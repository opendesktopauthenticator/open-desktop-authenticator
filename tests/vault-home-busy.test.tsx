import { describe, expect, it } from 'vitest';
import { finished, noted, running } from '../src/renderer/screens/VaultHome';

/**
 * Which accounts are mid-operation, and why one name was not enough.
 *
 * **Copy and Export used to remember a single account.** Start a copy on one
 * row, start another before it settles, and the first row's button came back to
 * life still saying "Copy" while its request was very much in flight — so it
 * could be pressed again, running a second copy, or in the export case opening
 * a second save dialog over a file already being written.
 *
 * The `finally` was already careful not to clear somebody else's flag, which is
 * what made this hard to see: the *finishing* path was correct and the
 * *starting* path overwrote. The test that guarded it asserted the shape of
 * that `finally` as source text and never involved two accounts, so it passed
 * throughout.
 */

const A = '76561198000000001';
const B = '76561198000000002';

describe('accounts with an operation in flight', () => {
	it('keeps the first while a second starts', () => {
		const none: ReadonlySet<string> = new Set();
		const one = running(A)(none);
		const both = running(B)(one);

		expect(both.has(A), 'starting B stopped A from looking busy').toBe(true);
		expect(both.has(B)).toBe(true);
	});

	it('releases only the one that finished', () => {
		const both = running(B)(running(A)(new Set()));
		const after = finished(B)(both);

		expect(after.has(A), 'B finishing released A as well').toBe(true);
		expect(after.has(B)).toBe(false);
	});

	it('leaves the previous set untouched', () => {
		// React compares by identity; mutating in place would skip the re-render
		// that re-enables the button.
		const before = running(A)(new Set());
		const after = running(B)(before);

		expect(after).not.toBe(before);
		expect([...before]).toEqual([A]);
	});

	it('is unbothered by a release for something that never started', () => {
		const one = running(A)(new Set());
		expect([...finished(B)(one)]).toEqual([A]);
	});

	it('does not double-count a second press of the same button', () => {
		expect([...running(A)(running(A)(new Set()))]).toEqual([A]);
	});
});

/*
 * **Trade and Open were left on a single name after Copy and Export were fixed.**
 *
 * The previous pass converted the two that were filed and stopped there, so
 * starting a browser for account B re-enabled A's button while A's request was
 * still running — and if A then failed, the global attempt counter called it
 * stale and threw its error away. A's browser did not open and nothing on
 * screen said why.
 */
describe('the browser buttons across two accounts', () => {
	it('keeps both accounts busy at once', () => {
		const both = running(B)(running(A)(new Set()));
		expect(both.has(A), 'opening B released A').toBe(true);
		expect(both.has(B)).toBe(true);
	});

	/*
	 * The per-account attempt counter, in the shape the screen uses it: claim,
	 * then ask whether this is still the newest press *for that account*.
	 */
	it('does not let one account’s press stale another’s failure', () => {
		const attempts = new Map<string, number>();
		const claim = (id: string): (() => boolean) => {
			const mine = (attempts.get(id) ?? 0) + 1;
			attempts.set(id, mine);
			return () => attempts.get(id) === mine;
		};

		const firstA = claim(A);
		const firstB = claim(B);

		expect(firstA(), 'starting B discarded A’s failure as stale').toBe(true);
		expect(firstB()).toBe(true);

		// A second press on A *does* stale the first, which is the point of it.
		const secondA = claim(A);
		expect(firstA()).toBe(false);
		expect(secondA()).toBe(true);
		expect(firstB(), 'a press on A staled B').toBe(true);
	});
});

/*
 * **Two accounts failing is two messages, not the newest one.**
 *
 * `browserError` was a single object for the whole list, and the message is
 * rendered on the row it belongs to — so account B's failure overwrote account
 * A's, only one row explained itself, and pressing any third browser cleared
 * what was on screen. Both people pressed a button, neither browser opened, and
 * one of them was told nothing.
 *
 * ## What these do not cover
 *
 * The component is not rendered here with two rejecting promises: this suite
 * has no DOM, and `renderToStaticMarkup` neither runs effects nor settles
 * promises. What is tested is the updater the handlers call, which is the thing
 * that decides — and `settings-passphrase-wiring` asserts the state really is a
 * `Map`, so a regression to one object shows up there.
 */
describe('browser failures across two accounts', () => {
	it('keeps both messages', () => {
		const none: ReadonlyMap<string, string> = new Map();
		const one = noted(A, 'the proxy refused')(none);
		const both = noted(B, 'Steam declined the session')(one);

		expect(both.get(A), 'B’s failure erased A’s explanation').toBe('the proxy refused');
		expect(both.get(B)).toBe('Steam declined the session');
	});

	it('clears only the account being retried', () => {
		const both = noted(B, 'Steam declined')(noted(A, 'proxy refused')(new Map()));
		const retryingB = noted(B, undefined)(both);

		expect(retryingB.has(A), 'starting B wiped A’s message off the screen').toBe(true);
		expect(retryingB.has(B)).toBe(false);
	});

	it('replaces one account’s own message rather than accumulating', () => {
		const first = noted(A, 'the proxy refused')(new Map());
		const second = noted(A, 'Steam declined the session')(first);

		expect(second.size).toBe(1);
		expect(second.get(A)).toBe('Steam declined the session');
	});

	it('leaves the previous map untouched', () => {
		const before = noted(A, 'the proxy refused')(new Map());
		const after = noted(B, 'Steam declined')(before);

		expect(after).not.toBe(before);
		expect([...before.keys()]).toEqual([A]);
	});
});

/*
 * **Export results share the same slot problem, and carry a heavier message.**
 *
 * When the previous export cannot be deleted, the result says a plaintext file
 * holding the older authenticator secrets is still on disk. That is the last
 * message on this screen that should be dismissible by somebody else's action —
 * and a single object meant starting an export for another account erased it,
 * and a second export advancing a shared counter discarded the first's result
 * before it was ever shown.
 */
describe('export results across two accounts', () => {
	it('keeps a stale-plaintext warning while another export starts', () => {
		const warned = noted(A, 'Saved. The previous export could not be deleted.')(new Map());
		// Starting B clears only B.
		const bStarts = noted(B, undefined)(warned);

		expect(bStarts.get(A), 'B’s export erased A’s plaintext warning').toContain(
			'could not be deleted'
		);
	});

	it('lets each account report its own outcome', () => {
		const both = noted(B, 'Nothing was saved.')(noted(A, 'Saved as a.maFile.')(new Map()));
		expect(both.get(A)).toBe('Saved as a.maFile.');
		expect(both.get(B)).toBe('Nothing was saved.');
	});

	/*
	 * The per-account attempt counter, in the shape the screen uses it. A single
	 * number made B's press newer than A's, so A's result — including the stale
	 * plaintext warning — was discarded as stale and never shown.
	 */
	it('does not let one account’s export stale another’s result', () => {
		const attempts = new Map<string, number>();
		const claim = (id: string): (() => boolean) => {
			const mine = (attempts.get(id) ?? 0) + 1;
			attempts.set(id, mine);
			return () => attempts.get(id) === mine;
		};

		const firstA = claim(A);
		claim(B);
		expect(firstA(), 'starting B discarded A’s export result').toBe(true);
	});
});
