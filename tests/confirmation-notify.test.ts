import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	composeBody,
	ConfirmationNotifier,
	type ToastHost
} from '../src/main/confirmations/notify';
import type { ConfirmationSummary } from '../src/shared/ipc';

/**
 * **What is worth interrupting somebody for, and how much to say.**
 *
 * Two properties carry the whole feature and both are easy to lose:
 *
 *  - **The same thing is announced once.** Polls run every fifteen seconds by
 *    default, so anything that re-announces an unchanged state per poll is not
 *    a notification, it is an alarm the user switches off.
 *  - **A toast is not a private surface.** It reaches the lock screen and stays
 *    in Windows notification history, and `full` — the default — puts Steam's
 *    own strings there. That is the one path on which text this application did
 *    not author reaches an OS-level surface.
 */

const ID = '76561198000000001';

function summary(overrides: Partial<ConfirmationSummary> = {}): ConfirmationSummary {
	return {
		id: '1',
		type: 2,
		typeName: 'Trade',
		hasIcon: false,
		securityCritical: false,
		autoConfirmable: true,
		...overrides
	};
}

function harness(): {
	notifier: ConfirmationNotifier;
	toasts: { title: string; body: string }[];
} {
	const toasts: { title: string; body: string }[] = [];
	const host: ToastHost = {
		show: (options) => {
			toasts.push(options);
		}
	};
	return { notifier: new ConfirmationNotifier({ host }), toasts };
}

/**
 * A notifier whose OS surface is refusing, and can be persuaded to stop.
 *
 * `Notification` is an OS surface: it can fail for reasons that have nothing to
 * do with this application, and the useful response is to say it again next
 * poll rather than to mark it said.
 */
function refusingHarness(): {
	notifier: ConfirmationNotifier;
	toasts: { title: string; body: string }[];
	/** Attempts, including the ones that threw. */
	attempts: () => number;
	recover: () => void;
} {
	const toasts: { title: string; body: string }[] = [];
	let attempts = 0;
	let failing = true;
	const host: ToastHost = {
		show: (options) => {
			attempts += 1;
			if (failing) {
				throw new Error('no notification service on this machine');
			}
			toasts.push(options);
		}
	};
	return {
		notifier: new ConfirmationNotifier({ host }),
		toasts,
		attempts: () => attempts,
		recover: () => {
			failing = false;
		}
	};
}

describe('the first poll for an account', () => {
	let h: ReturnType<typeof harness>;
	beforeEach(() => {
		h = harness();
	});

	/*
	 * Unlocking to twenty pending confirmations must not fire twenty toasts.
	 * The first poll establishes what is already there; it is not news.
	 */
	it('seeds silently', () => {
		h.notifier.pending(ID, 'trader', [summary(), summary({ id: '2' })], 0, 'full');
		expect(h.toasts).toEqual([]);
	});

	/*
	 * The carve-out that matters. A notify-only poll writes no activity entry,
	 * so without this, unlocking to a pending account takeover shows nothing at
	 * all — no toast and no badge.
	 */
	it('still announces a security-critical confirmation', () => {
		h.notifier.pending(
			ID,
			'trader',
			[summary({ id: '9', type: 6, typeName: 'Account recovery', securityCritical: true })],
			0,
			'type'
		);
		expect(h.toasts).toHaveLength(1);
		expect(h.toasts[0]?.body).toContain('account recovery');
	});

	it('still announces an unreadable entry', () => {
		h.notifier.pending(ID, 'trader', [], 2, 'full');
		expect(h.toasts).toHaveLength(1);
		expect(h.toasts[0]?.body).toContain('could not be read');
	});

	it('does not re-announce what it seeded on the next poll', () => {
		const entries = [summary(), summary({ id: '2' })];
		h.notifier.pending(ID, 'trader', entries, 0, 'full');
		h.notifier.pending(ID, 'trader', entries, 0, 'full');
		expect(h.toasts).toEqual([]);
	});
});

describe('announcing new confirmations', () => {
	let h: ReturnType<typeof harness>;
	beforeEach(() => {
		h = harness();
		h.notifier.pending(ID, 'trader', [], 0, 'full');
	});

	it('announces one that was not there before', () => {
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		expect(h.toasts).toHaveLength(1);
		expect(h.toasts[0]?.title).toBe('trader');
	});

	it('announces it once, not on every poll', () => {
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		expect(h.toasts).toHaveLength(1);
	});

	it('announces only the new one when others are still pending', () => {
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		h.notifier.pending(ID, 'trader', [summary(), summary({ id: '2' })], 0, 'count');
		expect(h.toasts).toHaveLength(2);
		expect(h.toasts[1]?.body).toContain('1 confirmation');
	});

	it('keeps accounts apart', () => {
		const other = '76561198000000002';
		h.notifier.pending(other, 'second', [], 0, 'full');
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		h.notifier.pending(other, 'second', [summary()], 0, 'count');
		expect(h.toasts.map((t) => t.title)).toEqual(['trader', 'second']);
	});
});

/**
 * **The ordering an earlier draft had wrong.**
 *
 * It put an early return for "nothing new" above the pruning and above the
 * `unreadable` check. Both of the first two cases here were required by that
 * same draft and were unreachable under its own ordering: the poll on which a
 * confirmation resolves brings nothing new *by definition*, so the set never
 * shrank, and an unreadable entry arriving on a quiet poll never spoke.
 */
describe('the order the steps run in', () => {
	let h: ReturnType<typeof harness>;
	beforeEach(() => {
		h = harness();
		h.notifier.pending(ID, 'trader', [], 0, 'full');
	});

	it('prunes on a poll that brings nothing new, so a reappearance is news again', () => {
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		expect(h.toasts).toHaveLength(1);

		// Resolved on the phone. This poll has no new ids at all.
		h.notifier.pending(ID, 'trader', [], 0, 'count');
		expect(h.toasts, 'the quiet poll should say nothing').toHaveLength(1);

		// The same id comes back — a genuinely new event.
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		expect(h.toasts, 'a reappearing confirmation was swallowed as already seen').toHaveLength(2);
	});

	it('announces an unreadable entry that arrives with no new confirmations', () => {
		h.notifier.pending(ID, 'trader', [], 3, 'count');
		expect(h.toasts, 'an unparseable entry arrived on a quiet poll and said nothing').toHaveLength(
			1
		);
		expect(h.toasts[0]?.body).toContain('could not be read');
	});

	it('sends one toast, not two, when a new id and an unreadable entry arrive together', () => {
		h.notifier.pending(ID, 'trader', [summary()], 1, 'count');
		expect(h.toasts).toHaveLength(1);
		expect(h.toasts[0]?.body).toContain('1 confirmation');
		expect(h.toasts[0]?.body).toContain('could not be read');
	});

	it('stays silent on a poll where nothing at all changed', () => {
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		expect(h.toasts).toHaveLength(1);
	});

	/*
	 * **This asserted the wrong quantity and could not fail.** It counted toasts
	 * and bounded them at 210 — but removing the pruning makes the run *quieter*,
	 * not louder, because ids that are never dropped are never fresh again. The
	 * bound it named was unobservable through the thing it measured.
	 *
	 * Pruning is observable as forgetting: an id dropped from `awaiting` and later
	 * returning must be announced again. Two hundred polls of distinct ids leave
	 * an unpruned set holding all of them, so id `0` coming back says nothing —
	 * which is the actual consequence of the set growing for ever.
	 */
	it('forgets ids that are no longer pending, however many have passed', () => {
		for (let i = 0; i < 200; i += 1) {
			h.notifier.pending(ID, 'trader', [summary({ id: String(i) })], 0, 'count');
		}
		const before = h.toasts.length;

		// `0` left the list 199 polls ago. Its return is news.
		h.notifier.pending(ID, 'trader', [summary({ id: '0' })], 0, 'count');

		expect(h.toasts.length, 'the seen set kept every id it had ever been shown').toBe(before + 1);
	});
});

describe('what the body says', () => {
	const trade = summary({
		headline: 'Trade with SomeTrader',
		summary: ['You give: AK-47 Redline']
	});
	const listing = summary({ id: '2', type: 3, typeName: 'Market listing' });

	it('counts, for count', () => {
		expect(composeBody('count', [trade, listing], 0)).toBe('2 confirmations need you');
	});

	it('uses the singular for one', () => {
		expect(composeBody('count', [trade], 0)).toBe('1 confirmation needs you');
	});

	it('names the types, for type', () => {
		expect(composeBody('type', [trade, listing], 0)).toBe('1 trade, 1 market listing');
	});

	/**
	 * **Our label, never Steam's.**
	 *
	 * `typeName` comes from the S16 table in `policy.ts`; `steamTypeName` is
	 * whatever the server sent, and a label the server chooses is a label an
	 * attacker chooses. This is the text somebody reads before deciding whether
	 * to get up and look, so it has to be the one this application controls.
	 */
	it('counts by our own type name, not the one Steam sent', () => {
		const lying = summary({
			type: 6,
			typeName: 'Account recovery',
			steamTypeName: 'Trade'
		});
		expect(composeBody('type', [lying], 0), 'a toast printed the type name Steam supplied').toBe(
			'1 account recovery'
		);
	});

	it('names the trade and the item, for full', () => {
		expect(composeBody('full', [trade], 0)).toBe('Trade with SomeTrader — You give: AK-47 Redline');
	});

	it('counts the rest rather than listing them', () => {
		expect(composeBody('full', [trade, listing], 0)).toContain('+1 more');
	});

	it('falls back to our own type name when Steam sent no headline', () => {
		expect(composeBody('full', [listing], 0)).toBe('Market listing');
	});

	it('reports unreadable entries on their own', () => {
		expect(composeBody('full', [], 2)).toBe('2 confirmations could not be read');
		expect(composeBody('full', [], 1)).toBe('1 confirmation could not be read');
	});

	/**
	 * **`full` is the default, so its input is untrusted.**
	 *
	 * `headline` and `summary` are Steam's strings, and this is the only place
	 * text this application did not write reaches an OS-level surface.
	 */
	it('caps an over-long Steam string', () => {
		const body = composeBody('full', [summary({ headline: 'A'.repeat(500) })], 0);
		expect(body.length).toBeLessThan(120);
		expect(body).toContain('…');
	});

	it('strips control characters, including the bidirectional overrides', () => {
		const nasty = 'Trade  with‮ evil​ one⁦';
		const body = composeBody('full', [summary({ headline: nasty })], 0);
		expect(body).not.toContain(' ');
		expect(body, 'a bidi override survived into a toast').not.toContain('‮');
		expect(body).not.toContain('​');
		expect(body).not.toContain('⁦');
	});

	it('strips them from the summary line too, not only the headline', () => {
		const body = composeBody('full', [summary({ headline: 'Trade', summary: ['gives‮ you'] })], 0);
		expect(body).not.toContain('‮');
	});

	/**
	 * **`full` means full, in every condition.**
	 *
	 * A recorded decision, not an oversight: the plan at §2.1 says a lock-aware
	 * degrade — composing at `count` while Windows is locked — is *not* wanted,
	 * because a user who chose `full` chose it knowing where toasts appear.
	 *
	 * This used to be `composeBody(...) === composeBody(...)` with identical
	 * arguments, which is a tautology: any degrade evaluated the same way twice
	 * running satisfies it. Built and measured over the real function, a mutant
	 * reading `globalThis.__windowsLocked` passed while `composeBody('full', …)`
	 * had silently become '2 confirmations need you · 1 more could not be read'.
	 *
	 * So it is pinned twice: the exact string for a known input, and a static
	 * check that the function reaches for nothing outside its own arguments —
	 * which is the half a conditional degrade would have to defeat.
	 */
	it('composes the whole sentence for full, unreadable included', () => {
		expect(composeBody('full', [trade, listing], 1)).toBe(
			'Trade with SomeTrader — You give: AK-47 Redline · +1 more · 1 more could not be read'
		);
	});

	it('reads nothing outside its own arguments', () => {
		const source = readFileSync(
			join(__dirname, '..', 'src', 'main', 'confirmations', 'notify.ts'),
			'utf8'
		);
		const start = source.indexOf('export function composeBody(');
		expect(start, 'composeBody is gone or renamed').toBeGreaterThan(-1);
		const body = source.slice(start, source.indexOf('\n}', start));

		/*
		 * The ambient signals a degrade would have to consult. None of them is a
		 * parameter of this function, so naming one at all is the change this
		 * forbids — and unlike an equality check it fails whether or not the
		 * branch happens to be taken while the tests run.
		 */
		for (const ambient of [
			'globalThis',
			'process.',
			'powerMonitor',
			'screen',
			'Locked',
			'locked',
			'idle',
			'Date.now'
		]) {
			expect(
				body,
				`composeBody consults ${ambient}, so its output is not just its arguments`
			).not.toContain(ambient);
		}
	});
});

describe('a session that needs signing in again', () => {
	let h: ReturnType<typeof harness>;
	beforeEach(() => {
		h = harness();
	});

	it('says so once, not on every poll', () => {
		h.notifier.signInNeeded(ID, 'trader');
		h.notifier.signInNeeded(ID, 'trader');
		h.notifier.signInNeeded(ID, 'trader');
		expect(h.toasts).toHaveLength(1);
		expect(h.toasts[0]?.title).toBe('trader');
		expect(h.toasts[0]?.body).toContain('Sign in again');
	});

	/*
	 * Nothing else clears the flag. Without this the account is told once per
	 * process, so a session that expires, is fixed, and expires again stays
	 * silent the second time.
	 */
	it('is said again after a successful poll in between', () => {
		h.notifier.signInNeeded(ID, 'trader');
		h.notifier.pending(ID, 'trader', [], 0, 'count');
		h.notifier.signInNeeded(ID, 'trader');
		expect(
			h.toasts.filter((t) => t.body.includes('Sign in again')),
			'the second expiry was swallowed'
		).toHaveLength(2);
	});

	/*
	 * **The case above does not actually test the clear**, which mutation testing
	 * is how I found out. It reaches `pending` on an account that has never
	 * seeded, so the seeding branch replaces the whole state record and resets
	 * the flag as a side effect — deleting the clear itself changes nothing.
	 *
	 * This one seeds first, so the poll in the middle takes the ordinary path and
	 * the clear is the only thing that can make the second toast happen.
	 */
	it('is said again after a successful poll on an account that had already seeded', () => {
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		h.notifier.signInNeeded(ID, 'trader');
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		h.notifier.signInNeeded(ID, 'trader');
		expect(
			h.toasts.filter((t) => t.body.includes('Sign in again')),
			'a recovered-then-expired session went quiet the second time'
		).toHaveLength(2);
	});

	it('is said again after a lock', () => {
		h.notifier.signInNeeded(ID, 'trader');
		h.notifier.forget();
		h.notifier.signInNeeded(ID, 'trader');
		expect(h.toasts).toHaveLength(2);
	});

	it('keeps accounts apart', () => {
		h.notifier.signInNeeded(ID, 'trader');
		h.notifier.signInNeeded('76561198000000002', 'second');
		expect(h.toasts).toHaveLength(2);
	});

	/*
	 * A sign-in toast on an account that has never polled must not destroy a
	 * seen-set that does not exist yet — and must not seed one that silences the
	 * next real poll either.
	 */
	it('does not stop the next poll seeding normally', () => {
		h.notifier.signInNeeded(ID, 'trader');
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		expect(h.toasts.filter((t) => t.body.includes('confirmation'))).toHaveLength(0);
	});
});

describe('a halt', () => {
	let h: ReturnType<typeof harness>;
	beforeEach(() => {
		h = harness();
	});

	it('says automatic confirmation stopped, for an account that was confirming', () => {
		h.notifier.halted(ID, 'trader', 'confirm');
		expect(h.toasts).toHaveLength(1);
		expect(h.toasts[0]?.title).toBe('trader');
		expect(h.toasts[0]?.body).toContain('Automatic confirmation stopped');
	});

	it('says checking stopped, for an account that was only watching', () => {
		h.notifier.halted(ID, 'trader', 'notify');
		expect(
			h.toasts[0]?.body,
			'a watching account was told automatic confirmation stopped, which it never had'
		).not.toContain('Automatic confirmation');
		expect(h.toasts[0]?.body).toContain('Stopped checking');
	});

	/*
	 * The reason is redacted error text composed for the activity log. A toast
	 * says the thing stopped; the log is where the detail belongs, and a proxy
	 * URL with credentials in it is the sort of thing that reason can carry.
	 */
	it('does not carry the failure text', () => {
		h.notifier.halted(ID, 'trader', 'confirm');
		expect(h.toasts[0]?.body).not.toContain('http');
		expect(h.toasts[0]?.body.length).toBeLessThan(80);
	});
});

describe('forgetting', () => {
	it('re-seeds every account after a lock', () => {
		const h = harness();
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		h.notifier.forget();
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		expect(h.toasts, 'the first poll after an unlock announced what was already there').toEqual([]);
	});

	/*
	 * **Probed with a *different* id on purpose.** Re-polling the same set cannot
	 * distinguish "forgotten, so seeded silently" from "still remembered, so
	 * nothing is new" — both are silence, and the first version of this test
	 * asserted exactly that. A new id separates them: a forgotten account seeds
	 * it without speaking, a remembered one announces it.
	 */
	it('drops one account and leaves the others', () => {
		const h = harness();
		const other = '76561198000000002';
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		h.notifier.pending(other, 'second', [summary()], 0, 'count');
		h.notifier.forgetAccount(ID);

		// Forgotten: this is its first poll again, so it seeds in silence.
		h.notifier.pending(ID, 'trader', [summary({ id: 'new-one' })], 0, 'count');
		expect(h.toasts, 'a forgotten account announced what it should have seeded').toEqual([]);

		// Not forgotten: the same shape of change is news here.
		h.notifier.pending(other, 'second', [summary({ id: 'new-two' })], 0, 'count');
		expect(h.toasts, 'forgetting one account forgot the others too').toHaveLength(1);
		expect(h.toasts[0]?.title).toBe('second');
	});
});

/**
 * **An unreadable entry is a state, not an event.**
 *
 * It stays unparseable on Steam until somebody looks at it, so `unreadable > 0`
 * is true on every poll — and the first version of this class announced it on
 * every poll, four times a minute, forever. That is the alarm the top of
 * `notify.ts` says a notification must not become, written by the same person
 * who wrote the warning.
 */
describe('an unreadable entry that does not change', () => {
	let h: ReturnType<typeof harness>;
	beforeEach(() => {
		h = harness();
		h.notifier.pending(ID, 'trader', [], 0, 'count');
	});

	it('is announced once, not on every poll', () => {
		h.notifier.pending(ID, 'trader', [], 2, 'count');
		h.notifier.pending(ID, 'trader', [], 2, 'count');
		h.notifier.pending(ID, 'trader', [], 2, 'count');
		expect(h.toasts, 'an unchanged unreadable count re-announced itself').toHaveLength(1);
	});

	it('is announced again when the count rises', () => {
		h.notifier.pending(ID, 'trader', [], 2, 'count');
		h.notifier.pending(ID, 'trader', [], 3, 'count');
		expect(h.toasts).toHaveLength(2);
		expect(h.toasts[1]?.body).toContain('3');
	});

	/*
	 * A drop means one was resolved. Nobody needs interrupting for that.
	 */
	it('is not announced when the count falls', () => {
		h.notifier.pending(ID, 'trader', [], 3, 'count');
		h.notifier.pending(ID, 'trader', [], 1, 'count');
		expect(h.toasts).toHaveLength(1);
	});

	/*
	 * **The ordering trap.** If the count were recorded only when a toast is
	 * sent, a return to zero would never be written down — and the reappearance
	 * would then compare against the old high-water mark and be swallowed for
	 * good.
	 */
	it('announces a reappearance after the count returns to zero', () => {
		h.notifier.pending(ID, 'trader', [], 2, 'count');
		h.notifier.pending(ID, 'trader', [], 0, 'count');
		h.notifier.pending(ID, 'trader', [], 2, 'count');
		expect(h.toasts, 'a reappearing unreadable entry was swallowed for good').toHaveLength(2);
	});

	it('still rides along on a toast a new confirmation earned', () => {
		h.notifier.pending(ID, 'trader', [], 2, 'count');
		h.notifier.pending(ID, 'trader', [summary()], 2, 'count');
		expect(h.toasts).toHaveLength(2);
		expect(h.toasts[1]?.body).toContain('could not be read');
	});
});

/**
 * **The first poll must not choose between the two things it may not hold
 * back.**
 *
 * An earlier version returned straight after the security-critical toast, so an
 * account whose first poll carried both a takeover attempt and an entry this
 * build could not parse was told about the first and not the second — and the
 * unparseable one might have been another takeover attempt.
 */
describe('a first poll carrying both a takeover and an unreadable entry', () => {
	it('says both, in one toast', () => {
		const h = harness();
		h.notifier.pending(
			ID,
			'trader',
			[summary({ type: 6, typeName: 'Account recovery', securityCritical: true })],
			2,
			'type'
		);
		expect(h.toasts).toHaveLength(1);
		expect(h.toasts[0]?.body).toContain('account recovery');
		expect(h.toasts[0]?.body, 'the unreadable entry was swallowed by the return').toContain(
			'could not be read'
		);
	});
});

/**
 * **The account name is un-authored text too.**
 *
 * The body was carefully capped and stripped while the title beside it went to
 * the OS verbatim. Names are usually copied out of an imported maFile, whose
 * schema asks only for a non-empty string — so a 50KB name, or one carrying a
 * bidirectional override, reached a lock-screen toast exactly as written.
 */
describe('the toast title', () => {
	it('caps an over-long account name', () => {
		const h = harness();
		h.notifier.halted(ID, 'A'.repeat(500), 'confirm');
		expect(h.toasts[0]?.title.length, 'an unbounded name reached the OS').toBeLessThan(80);
	});

	it('strips control characters from an account name', () => {
		const h = harness();
		h.notifier.halted(ID, 'tra‮der', 'confirm');
		expect(h.toasts[0]?.title, 'a bidi override reached a toast title').not.toContain('‮');
	});

	it('leaves an ordinary name alone', () => {
		const h = harness();
		h.notifier.halted(ID, 'trader', 'confirm');
		expect(h.toasts[0]?.title).toBe('trader');
	});
});

/**
 * **The account shape whose only surface is the toast.**
 *
 * With auto-confirm on and notifications off — which is what the schema
 * defaults to for a confirming account — the engine calls `signInNeeded` but
 * never `pending`. The flag that stops a repeat toast was cleared only inside
 * `pending`, so the first expiry spoke and every later one for the life of the
 * session was swallowed, because nothing left could clear it.
 */
describe('an account that confirms without notifying', () => {
	it('is told again about a second expiry', () => {
		const h = harness();
		h.notifier.signInNeeded(ID, 'trader');

		// A successful confirm poll: no `pending`, because notifications are off.
		h.notifier.pollSucceeded(ID);
		h.notifier.signInNeeded(ID, 'trader');

		expect(
			h.toasts.filter((t) => t.body.includes('Sign in again')),
			'the second expiry was swallowed for the life of the session'
		).toHaveLength(2);
	});

	it('still says it only once within one run', () => {
		const h = harness();
		h.notifier.signInNeeded(ID, 'trader');
		h.notifier.signInNeeded(ID, 'trader');
		expect(h.toasts).toHaveLength(1);
	});

	it('leaves other accounts alone', () => {
		const h = harness();
		const other = '76561198000000002';
		h.notifier.signInNeeded(ID, 'trader');
		h.notifier.signInNeeded(other, 'second');
		h.notifier.pollSucceeded(ID);
		h.notifier.signInNeeded(other, 'second');
		expect(h.toasts).toHaveLength(2);
	});
});

/**
 * **A toast that never appeared must not count as having been said.**
 *
 * Every "already told them" record — `seen`, `lastUnreadable`,
 * `toldSignInNeeded` — was written *before* `host.show` was called. So a throw
 * out of the OS notification surface left the entry marked as announced and it
 * was never announced again for the life of the session.
 *
 * `guarded()` in the engine stops such a throw being scored as a Steam failure,
 * which is a different problem: by the time it catches, the bookkeeping has
 * already happened. Nothing here covered a throwing host at all.
 */
describe('a notification surface that is refusing', () => {
	it('says a confirmation again on the next poll', () => {
		const h = refusingHarness();
		h.notifier.pending(ID, 'trader', [], 0, 'full');
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		expect(h.attempts(), 'nothing was even attempted').toBe(1);

		h.recover();
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');

		expect(
			h.toasts,
			'the confirmation was marked as announced by a toast that never appeared, so it was ' +
				'never mentioned again'
		).toHaveLength(1);
	});

	it('says an unreadable entry again on the next poll', () => {
		const h = refusingHarness();
		h.notifier.pending(ID, 'trader', [], 0, 'full');
		h.notifier.pending(ID, 'trader', [], 2, 'count');

		h.recover();
		h.notifier.pending(ID, 'trader', [], 2, 'count');

		expect(h.toasts, 'the unreadable high-water mark rose on a toast nobody saw').toHaveLength(1);
		expect(h.toasts[0]?.body).toContain('could not be read');
	});

	/*
	 * The worst case, and the reason this is not merely tidiness. A
	 * security-critical confirmation reaches `seen` as part of the silent seed —
	 * it is announced *despite* the seeding — so a failed toast there buried an
	 * account takeover attempt with nothing else able to raise it.
	 */
	it('says a security-critical confirmation again after a failed first poll', () => {
		const h = refusingHarness();
		const critical = summary({
			id: '9',
			type: 6,
			typeName: 'Account recovery',
			securityCritical: true
		});
		h.notifier.pending(ID, 'trader', [critical], 0, 'type');
		expect(h.attempts()).toBe(1);

		h.recover();
		h.notifier.pending(ID, 'trader', [critical], 0, 'type');

		expect(h.toasts, 'an account takeover attempt was swallowed by a failed toast').toHaveLength(1);
		expect(h.toasts[0]?.body).toContain('account recovery');
	});

	/*
	 * And the seed itself stands. Re-seeding would announce the whole backlog,
	 * which is what the silent seed exists to prevent.
	 */
	it('does not re-announce the ordinary backlog it seeded', () => {
		const h = refusingHarness();
		h.notifier.pending(ID, 'trader', [summary(), summary({ id: '2' })], 1, 'full');

		h.recover();
		h.notifier.pending(ID, 'trader', [summary(), summary({ id: '2' })], 0, 'full');

		expect(h.toasts, 'the silent seed was undone, so the backlog was announced').toEqual([]);
	});

	it('says sign in again on the next expiry', () => {
		const h = refusingHarness();
		h.notifier.signInNeeded(ID, 'trader');
		expect(h.attempts()).toBe(1);

		h.recover();
		h.notifier.signInNeeded(ID, 'trader');

		expect(h.toasts, 'an expired session was reported once, to nobody').toHaveLength(1);
	});

	/*
	 * And the throw does not escape. The engine's `guarded()` would catch it, but
	 * relying on that makes every future caller of this class responsible for a
	 * failure mode it cannot see.
	 */
	it('does not throw at its caller', () => {
		const h = refusingHarness();
		expect(() => h.notifier.pending(ID, 'trader', [summary()], 0, 'full')).not.toThrow();
		expect(() => h.notifier.signInNeeded(ID, 'trader')).not.toThrow();
		expect(() => h.notifier.halted(ID, 'trader', 'confirm')).not.toThrow();
	});
});

/**
 * **A failure the OS reports *after* `show()` returned.**
 *
 * `Notification.show()` returns before the OS has created anything; Electron
 * reports a native creation or display failure later, on the `failed` event. So
 * a synchronous "did it throw" answer was not an answer at all: the toast was
 * recorded as announced, the failure arrived a moment later with nobody
 * listening, and that confirmation was never mentioned again for the session.
 *
 * Measured by the auditor exactly this way — a delayed failure followed by the
 * same critical confirmation produced one delivery attempt and then silence.
 */
describe('a notification that fails after it was shown', () => {
	function delayedHarness(): {
		notifier: ConfirmationNotifier;
		attempts: () => number;
		/** Report the outcome of every toast raised so far. */
		settle: (delivered: boolean) => Promise<void>;
	} {
		let attempts = 0;
		const pending: ((delivered: boolean) => void)[] = [];
		const host: ToastHost = {
			show: () => {
				attempts += 1;
				return new Promise<boolean>((resolve) => {
					pending.push(resolve);
				});
			}
		};
		return {
			notifier: new ConfirmationNotifier({ host }),
			attempts: () => attempts,
			settle: async (delivered) => {
				for (const resolve of pending.splice(0)) {
					resolve(delivered);
				}
				// Let the rollback attached to the promise run.
				await Promise.resolve();
				await Promise.resolve();
			}
		};
	}

	const critical = summary({
		id: '9',
		type: 6,
		typeName: 'Account recovery',
		securityCritical: true
	});

	it('says a critical confirmation again once the failure is known', async () => {
		const h = delayedHarness();
		h.notifier.pending(ID, 'trader', [critical], 0, 'type');
		expect(h.attempts()).toBe(1);

		await h.settle(false);
		h.notifier.pending(ID, 'trader', [critical], 0, 'type');

		expect(
			h.attempts(),
			'the toast was recorded as announced before the OS said it had failed, so an account ' +
				'takeover attempt was never raised again'
		).toBe(2);
	});

	it('says an ordinary confirmation again too', async () => {
		const h = delayedHarness();
		h.notifier.pending(ID, 'trader', [], 0, 'full');
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		expect(h.attempts()).toBe(1);

		await h.settle(false);
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		expect(h.attempts()).toBe(2);
	});

	it('says sign in again once the failure is known', async () => {
		const h = delayedHarness();
		h.notifier.signInNeeded(ID, 'trader');
		await h.settle(false);
		h.notifier.signInNeeded(ID, 'trader');
		expect(h.attempts()).toBe(2);
	});

	/* And a delivery that succeeds is still announced exactly once. */
	it('does not repeat one the OS did show', async () => {
		const h = delayedHarness();
		h.notifier.pending(ID, 'trader', [], 0, 'full');
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');
		await h.settle(true);
		h.notifier.pending(ID, 'trader', [summary()], 0, 'count');

		expect(h.attempts(), 'a delivered toast was announced twice').toBe(1);
	});
});
