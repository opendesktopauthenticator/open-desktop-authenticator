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
			onResolve={() => Promise.resolve({ ok: true as const })}
			onClearStale={() => Promise.resolve()}
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
			unresolved: {
				guidance: 'Steam did not answer, so the outcome is unknown.',
				operationToken: '0'.repeat(64)
			}
		});

		expect(withAccount).toContain('Steam Guard is on this account now');
		expect(hasSubmit(withAccount), 'the activation form was still offered').toBe(false);
	});

	it('does not offer an answer when the exact saved operation token is absent', () => {
		const withoutIdentity = screen({
			resume: { steamId64: '76561198000000001', accountName: 'trader' },
			unresolved: { guidance: 'Steam did not answer, so the outcome is unknown.' }
		});

		expect(withoutIdentity).not.toContain('Steam Guard is on this account now');
		expect(withoutIdentity).not.toContain('Steam Guard is not on it');
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
		/*
		 * **The phrase has to be one the component can actually render.**
		 *
		 * This looked for 'will not send it again'; the copy is 'This application
		 * will not send the request again.' The searched substring appears nowhere
		 * under any props, so the assertion held in every state — including with the
		 * warning panel on screen, which is the one state it exists to exclude. Its
		 * sibling above uses the right phrase, which is what makes this a typo
		 * rather than a different check.
		 */
		expect(screen()).not.toContain('will not send the request again');
	});
});

describe('a recovery backup warning after successful activation', () => {
	it('is retained into the completion screen for both activation and reconciliation', () => {
		const source = AddAuthenticator.toString();
		const completion = source.slice(source.indexOf('step === "done"'));

		expect(source.match(/setRecoveryWarning\(result\.recoveryWarning\)/g)).toHaveLength(2);
		expect(
			source.indexOf('setUncertain(void 0)', source.indexOf('result.recoveryWarning'))
		).toBeGreaterThan(source.indexOf('result.recoveryWarning'));
		expect(completion).toContain('recoveryWarning');
		expect(completion).toContain('role: "alert"');
	});
});

describe('a safety record for an older authenticator', () => {
	const stale = screen({
		resume: { steamId64: '76561198000000001', accountName: 'trader' },
		unresolved: {
			kind: 'activate',
			guidance: 'This record belongs to an older authenticator.',
			stale: true,
			staleToken: 'a'.repeat(64)
		}
	});

	it('offers only the exact-record cleanup, not a Steam outcome answer or activation', () => {
		expect(stale).toContain('An old safety record needs clearing');
		expect(stale).toContain('Clear old safety record');
		expect(stale).not.toContain('Steam Guard is on this account now');
		expect(stale).not.toContain('Steam Guard is not on it');
		expect(hasSubmit(stale), 'the irreversible activation form was still live').toBe(false);
	});
});

describe('a legacy safety record whose authenticator cannot be identified', () => {
	const unidentified = screen({
		resume: { steamId64: '76561198000000001', accountName: 'trader' },
		unresolved: {
			kind: 'activate',
			guidance: 'This record was written before authenticator identities were stored.',
			unidentified: true
		}
	});

	it('fails closed without offering cleanup, a Steam answer, or activation', () => {
		expect(unidentified).toContain('This safety record cannot be matched');
		expect(unidentified).toMatch(/contact support/i);
		expect(unidentified).not.toContain('Clear old safety record');
		expect(unidentified).not.toContain('Steam Guard is on this account now');
		expect(unidentified).not.toContain('Steam Guard is not on it');
		expect(hasSubmit(unidentified), 'the irreversible activation form was still live').toBe(false);
	});
});

describe('an unusable enrollment reply held only in memory', () => {
	it('offers the only action that can make its encrypted safety record durable', () => {
		const html = screen({
			onEnrollmentStatus: () => Promise.resolve({ pending: undefined }),
			onRetryEnrollment: () => Promise.reject(new Error('retained as unreadable'))
			// Seeded synchronously by a dedicated resume-free status is not possible in
			// static rendering, so this test pins the rendered branch through the source
			// contract below; the behavioral persistence path is covered in the service.
		});
		expect(html).toContain('Add an authenticator');
		const source = AddAuthenticator.toString();
		expect(source).toContain('Save safety record now');
		expect(source).toContain('enrollmentStatusRef.current');
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

/**
 * **A removal recorded against the account is not answerable on this screen.**
 *
 * `recordFor` deliberately falls back to any applicable vault record when none
 * matches the kind asked about, so asking about an activation can legitimately
 * return a live `deactivate` record. This screen then rendered removal guidance
 * under two activation buttons, and `App.tsx` sends the literal `'activate'` for
 * both — so the main process refused the resolve on the kind mismatch and the
 * account could never be settled from here. Reopening repeated it.
 *
 * The fix is not to plumb the kind through: answering "yes, Steam did it" for a
 * removal deletes the account, which the main process requires the vault
 * passphrase for, and this screen has no passphrase field. That would trade a
 * kind refusal for a passphrase refusal. So the record is described and the
 * reader is sent to the screen that can settle it.
 */
describe('a removal record surfaced on the activation screen', () => {
	const removal = screen({
		// `resume` is required: `enrolled` initialises from it, and the resolution
		// controls are gated on `enrolled !== undefined`. Without it neither kind
		// renders a button and the assertions below would hold for the wrong reason.
		resume: { steamId64: '76561198000000001', accountName: 'trader' },
		unresolved: {
			kind: 'deactivate' as const,
			guidance: 'Steam did not answer, so the outcome is unknown.',
			operationToken: 'token-for-a-removal'
		}
	});

	it('does not offer to answer it here', () => {
		expect(
			removal,
			'the activation screen offers "Steam Guard is on this account now" for a record that is ' +
				'a removal — the main process refuses that resolve on the kind mismatch, so the ' +
				'button can only ever fail and reopening repeats it'
		).not.toContain('Steam Guard is on this account now');
	});

	it('does not offer the deny button either', () => {
		expect(removal).not.toContain('Steam Guard is not on it');
	});

	it('says where it can be answered', () => {
		expect(
			removal,
			'the screen hides the controls but never tells the reader the record is a removal or ' +
				'where to settle it, which is a quieter dead end rather than none'
		).toMatch(/Remove account/);
	});

	it('still shows the guidance the record carries', () => {
		expect(removal).toContain('Steam did not answer');
	});
});

/*
 * And the ordinary case is untouched: an activation record is still answerable
 * here, or the fix would have closed the screen's actual job.
 */
describe('an activation record on the activation screen', () => {
	const activation = screen({
		resume: { steamId64: '76561198000000001', accountName: 'trader' },
		unresolved: {
			kind: 'activate' as const,
			guidance: 'Steam did not answer, so the outcome is unknown.',
			operationToken: 'token-for-an-activation'
		}
	});

	it('is still answerable here', () => {
		expect(
			activation,
			'the removal gate swallowed the activation case too, so the screen can no longer resolve ' +
				'the operation it exists for'
		).toContain('Steam Guard is on this account now');
	});

	it('does not send the reader elsewhere', () => {
		expect(activation).not.toMatch(/settled from <strong>Remove account/);
	});
});
