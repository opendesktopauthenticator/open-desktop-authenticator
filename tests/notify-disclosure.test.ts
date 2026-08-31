import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **The disclosure is the only thing standing between `full` and an unattended
 * screen.**
 *
 * A degrade to `count` while Windows is locked was proposed and deliberately
 * rejected, so nothing else covers this case. The sentence has to name **both**
 * surfaces: an earlier draft named only notification history, which is the
 * smaller of the two, and someone reading it would not learn that a toast
 * appears on the lock screen at all.
 *
 * Asserted against the source text because there is no DOM runner here. That is
 * a weaker test than rendering it — it proves the words exist in the file, not
 * that they reach the screen — so it is paired with the placement assertion
 * below, which is the part that actually goes wrong.
 */
describe('the disclosure beside the notifications switch', () => {
	const source = readFileSync(
		join(__dirname, '..', 'src', 'renderer', 'screens', 'AutoConfirm.tsx'),
		'utf8'
	);

	it('names the lock screen', () => {
		expect(source, 'the disclosure does not mention the lock screen').toContain('lock screen');
	});

	it('names notification history', () => {
		expect(source).toContain('notification history');
	});

	it('says the toast names the trade and its items', () => {
		expect(source).toContain('name the trade and its items');
	});

	it('offers the two quieter options by name', () => {
		expect(source).toContain('Count only');
		expect(source).toContain('Type only');
	});

	/*
	 * **Placement, which is the part that goes wrong.** `full` is the default, so
	 * the sentence has to be read by anyone switching notifications on — not only
	 * by somebody who goes looking at the detail options. If it moved next to the
	 * `full` radio it would be true and unread.
	 */
	it('sits beside the enable switch, not inside the detail group', () => {
		const enableAt = source.indexOf('setNotifyEnabled');
		const disclosureAt = source.indexOf('Windows shows them on the lock screen');
		const detailGroupAt = source.indexOf('<legend>What a notification says</legend>');
		expect(enableAt).toBeGreaterThan(-1);
		expect(disclosureAt).toBeGreaterThan(-1);
		expect(detailGroupAt).toBeGreaterThan(-1);
		expect(disclosureAt, 'the disclosure moved off the enable switch').toBeGreaterThan(enableAt);
		expect(disclosureAt, 'the disclosure moved into the detail group').toBeLessThan(detailGroupAt);
	});
});

/**
 * **A click that navigates nowhere looks broken, and would ship silently.**
 *
 * The unlocked view is a stack of `if`s, and `autoConfirmFor` and `removingFor`
 * are tested *above* `confirmingFor`. Setting the target while either of those
 * is open therefore does nothing at all — no error, no log, just a toast that
 * appears to do nothing when clicked.
 *
 * Asserted against the source because this project has no DOM runner. That is
 * weaker than rendering it, and it is the reason the assertion is about the
 * clears being present in this specific function rather than about the
 * navigation working.
 */
describe('opening confirmations from a notification', () => {
	const source = readFileSync(join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');

	/** The body of `openConfirmationsFor`, which is where the rule has to hold. */
	const body = (() => {
		const start = source.indexOf('const openConfirmationsFor = useCallback(');
		expect(start, 'openConfirmationsFor no longer exists').toBeGreaterThan(-1);
		const end = source.indexOf('[accounts]', start);
		expect(end, 'openConfirmationsFor changed shape; this test needs rewriting').toBeGreaterThan(
			start
		);
		return source.slice(start, end);
	})();

	it('looks the account up rather than trusting the id', () => {
		expect(body).toContain('confirmationsTargetFor(accounts, steamId64)');
	});

	it('clears the screens that sit above confirmations in the view stack', () => {
		// If one of these is dropped, the click silently does nothing whenever
		// that screen happens to be open.
		expect(body, 'the auto-confirm screen would swallow the navigation').toContain(
			'setAutoConfirmFor(undefined)'
		);
		expect(body, 'the removal screen would swallow the navigation').toContain(
			'setRemovingFor(undefined)'
		);
		expect(body).toContain('setRoutingFor(undefined)');
		expect(body).toContain('setBackupFor(undefined)');
	});

	it('returns to the account list before selecting within it', () => {
		expect(body).toContain("setView('accounts')");
		expect(body.indexOf("setView('accounts')")).toBeLessThan(body.indexOf('setConfirmingFor('));
	});

	it('sets the target last, so nothing clears it afterwards', () => {
		const target = body.indexOf('setConfirmingFor(account)');
		expect(target).toBeGreaterThan(body.indexOf('setAutoConfirmFor(undefined)'));
		expect(target).toBeGreaterThan(body.indexOf('setRemovingFor(undefined)'));
	});

	/*
	 * The collection path is what makes a lock survivable, and it is gated on
	 * there being an account list to navigate within — asking a beat too early
	 * would take the intent, fail the lookup, and throw it away.
	 */
	it('waits for an account list before collecting a pending click', () => {
		expect(source).toContain('takePendingConfirmations()');
		const effect = source.slice(source.indexOf('api\n\t\t\t.takePendingConfirmations()') - 400);
		expect(effect).toContain('accounts.length === 0');
	});
});
