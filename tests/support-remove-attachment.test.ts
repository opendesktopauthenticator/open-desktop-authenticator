import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Removing an attachment from the support form, and the order it happens in.
 *
 * ## Why this reads source instead of clicking a button
 *
 * `site/assets/support.js` is a plain browser script that talks to the DOM, and
 * this suite has no DOM — the renderer tests use `renderToStaticMarkup` for the
 * same reason. Adding `jsdom` for one file would put a large dependency in a
 * tree §2.3 keeps deliberately small.
 *
 * So these are text assertions, and they are weaker than the behaviour they
 * stand for: they can prove the operations are in the right order and cannot
 * prove the button works. The half that *can* be executed — that the server
 * refuses to withdraw an upload once a report has claimed it — is covered for
 * real in `tickets-attachments.test.ts`. This file guards the client-side
 * ordering that decides whether the claim ever happens.
 */

const SOURCE = readFileSync(join(__dirname, '../site/assets/support.js'), 'utf8');

/** The body of the Remove button's click handler, and nothing around it. */
function removeHandler(): string {
	const start = SOURCE.indexOf("remove.addEventListener('click'");
	expect(start, 'the Remove handler has moved or gone').toBeGreaterThan(-1);
	const end = SOURCE.indexOf('li.appendChild(remove);', start);
	expect(end).toBeGreaterThan(start);
	return SOURCE.slice(start, end);
}

describe('taking an attachment back off a support report', () => {
	/*
	 * **The order is the whole fix.**
	 *
	 * The id used to stay in the form until the DELETE came back. Press Remove,
	 * press Send: the report claimed the attachment, and the delete that landed a
	 * moment later found it claimed and left it alone — deliberately, because an
	 * id attached to a report belongs to that report and a stranger who guessed
	 * one must not be able to strip evidence off somebody else's.
	 *
	 * So the file went out on the report anyway, and the page said it had been
	 * removed. The person pressing that button has usually just spotted their own
	 * account name in the corner of a screenshot.
	 */
	it('leaves the form before it leaves the server', () => {
		const handler = removeHandler();
		const dropped = handler.indexOf('sync();');
		const told = handler.indexOf('fetch(');

		expect(dropped, 'the id is never dropped from the form').toBeGreaterThan(-1);
		expect(told, 'the server is never told').toBeGreaterThan(-1);
		expect(dropped, 'the id is still in the form while the delete is in flight').toBeLessThan(told);
	});

	/*
	 * Belt to those braces. The id is already gone from the form by the time the
	 * request goes out, so this cannot change the outcome — it keeps the page
	 * honest about what it is still doing, and closes the window entirely rather
	 * than relying on one ordering staying correct forever.
	 */
	it('holds Send while a removal is in flight', () => {
		const handler = removeHandler();
		expect(handler).toContain('removing += 1');
		expect(handler).toContain('removing -= 1');
		// Send is disabled by the count, not by the upload count alone.
		expect(SOURCE).toContain('submit.disabled = inFlight + removing > 0;');
	});

	/*
	 * `fetch` rejects for a dropped connection and **resolves** for a refusal, so
	 * a 403 or a 500 came back through the success path and the card disappeared
	 * with the file still on the server. The `catch` looked like it covered this
	 * and did not.
	 */
	it('notices a refusal, not only a dropped connection', () => {
		const handler = removeHandler();
		expect(handler, 'a refused delete is read as a successful one').toContain('.ok');
	});

	it('says so when our copy could not be deleted', () => {
		const handler = removeHandler();
		expect(handler).toContain('complain(');
		expect(handler).toMatch(/taken off your report/i);
	});

	/*
	 * **No deadline the service cannot keep.**
	 *
	 * This message used to promise "within two hours" — the unclaimed lifetime —
	 * but the sweep runs hourly and only takes files already older than that, so
	 * one uploaded just after a sweep waits nearer three. A persistent
	 * filesystem failure has no bound at all. A privacy promise with a number in
	 * it had better be a number that holds, and this test asserted the number
	 * rather than the promise.
	 */
	it('promises no deadline it cannot hold', () => {
		const handler = removeHandler();
		expect(handler, 'a hard deadline the hourly sweep cannot guarantee').not.toMatch(
			/within two hours/i
		);
		expect(handler).toMatch(/usually within a few hours/i);
		// And a way out when "usually" is not good enough.
		expect(handler).toMatch(/support/i);
	});
});
