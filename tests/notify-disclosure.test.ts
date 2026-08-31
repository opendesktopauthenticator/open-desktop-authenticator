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
