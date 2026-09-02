import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AddAuthenticator } from '../src/renderer/screens/AddAuthenticator';

/**
 * **A dead end that still rendered the way out of it.**
 *
 * When `AddAuthenticator` reaches an outcome Steam may already have acted on,
 * the screen shows a panel saying so — and says, in as many words, that this
 * application will not send the request again.
 *
 * The panel was rendered *above* the forms rather than instead of them. The
 * credentials form and the email-code form stayed mounted, stayed enabled and
 * stayed wired to the handler, so the sentence and the screen disagreed and the
 * screen is the half a user can act on. A probe invoked the irreversible call
 * twice straight through it.
 *
 * The activation block was gated on exactly this condition from the start,
 * which is what makes the other two an omission rather than a design.
 *
 * Rendered rather than asserted on state: what is being checked is whether the
 * control exists on the page at all.
 */

const noop = (): void => undefined;

/** The screen at a given step, with an activation outcome already in hand. */
function screen(props: Record<string, unknown> = {}): string {
	return renderToStaticMarkup(
		<AddAuthenticator
			requireProxies={false}
			onBegin={() => Promise.resolve({ state: 'needsEmailCode' as const })}
			onEmailCode={() => Promise.resolve({ state: 'needsEmailCode' as const })}
			onCancel={() => Promise.resolve()}
			onActivate={() => Promise.resolve({ state: 'activated' as const })}
			onResolve={() => Promise.resolve()}
			onBackup={noop}
			onClose={noop}
			onMove={noop}
			{...props}
		/>
	);
}

/** Whether the markup offers a control that submits an enrollment step. */
const hasSubmit = (html: string): boolean => html.includes('type="submit"');

describe('the screen after an outcome Steam may already have acted on', () => {
	/*
	 * **No `resume`, deliberately.** `step` starts at `activate` when a resume is
	 * passed, and the activation block was already gated — so a case built that
	 * way renders no form either way and cannot see the defect. The first version
	 * of this test did exactly that and passed with the fix removed. Without a
	 * resume the screen starts on `credentials`, which is the form the probe
	 * actually submitted twice.
	 */
	const stopped = screen({
		unresolved: { guidance: 'Steam did not answer, so the outcome is unknown.' }
	});

	it('says it will not send the request again', () => {
		expect(stopped).toContain('will not send the request again');
	});

	it('offers no control that would send one', () => {
		expect(
			hasSubmit(stopped),
			'the warning was rendered above the forms rather than instead of them, so the control ' +
				'that sends the irreversible request was still on the page underneath a sentence ' +
				'saying it would not be sent'
		).toBe(false);
	});

	it('offers a way out instead', () => {
		expect(stopped).toContain('Close');
	});

	/*
	 * **And not the word "Cancel".** The header's cancel buttons were gated on
	 * `step` alone, so one sat beside a heading saying Steam had already done the
	 * thing — the exact wording this file's own header comment forbids, because
	 * cancelling is no longer something that exists at that point.
	 */
	it('does not offer to cancel something already done', () => {
		expect(stopped).not.toContain('>Cancel<');
	});

	/*
	 * And with an account in hand it offers the resolution too — that control
	 * needs a SteamID to clear, which the credentials-step case has not got yet.
	 */
	it('offers the resolution once there is an account to resolve', () => {
		const withAccount = screen({
			resume: { steamId64: '76561198000000001', accountName: 'trader' },
			unresolved: { guidance: 'Steam did not answer, so the outcome is unknown.' }
		});

		expect(withAccount).toContain('Steam Guard is on this account now');
		expect(hasSubmit(withAccount), 'the activation form was still offered').toBe(false);
	});
});

/**
 * And with nothing outstanding the screen is an ordinary form — otherwise the
 * check above would pass on a screen that offers nothing to anybody.
 */
describe('the screen with no outcome outstanding', () => {
	it('does offer a submit control', () => {
		expect(
			hasSubmit(screen()),
			'the ordinary enrollment form is gone, so the guard above is measuring a screen nobody ' +
				'can use rather than one that is correctly stopped'
		).toBe(true);
	});

	it('does not show the warning', () => {
		expect(screen()).not.toContain('will not send it again');
	});
});

/**
 * **What this harness cannot reach, said plainly.**
 *
 * `uncertain` was only ever set, never unset — which did not matter while the
 * panel sat above the forms, and matters once they are gated on it: a second
 * attempt that SUCCEEDS would run `setEnrolled` and `setStep('activate')` with
 * the stale flag still set, and the activation block is gated on that same
 * flag. The user would have a real authenticator attached and no
 * revocation-code button in front of them.
 *
 * `applyOutcome` clears it now. **That clearing is not covered by a test**, and
 * this comment exists instead of one: reaching it needs a driven state
 * transition, and this project renders screens with `renderToStaticMarkup` and
 * has no renderer framework that can click. A test written against a static
 * render passes whether or not the clearing is there — it was tried, it
 * survived the mutation, and a green check that measures nothing is worse than
 * an honest gap.
 */
