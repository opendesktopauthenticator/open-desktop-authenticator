import { useEffect, useRef, useState } from 'react';
import type { EnrollmentStatus, EnrollBegin } from '../../shared/ipc';
import { enrollmentMayBeClearedAsNotAttached } from '../../shared/recovery-view';
import { messageOf } from '../ipc-message';
import { DynamicError } from '../DynamicError';

/**
 * Adding an authenticator to an account that has none (§12 F3).
 *
 * ## The shape of the screen follows the shape of the risk
 *
 * There is exactly one irreversible moment in this flow, and it is not the one
 * users expect. Pressing the button that signs in is what causes Steam to attach
 * an authenticator and issue secrets it will never reissue — so the screen says
 * so **before** it, in the plainest terms available, and stops pretending the
 * step afterwards is where the commitment happens.
 *
 * After that point the wording changes deliberately: no more "cancel", because
 * cancelling is no longer a thing that exists. The account has an authenticator
 * whether or not the user finishes, and the only useful instruction left is
 * "write the revocation code down".
 *
 * ## Two codes, from two places
 *
 * The account has no authenticator yet, so Steam Guard cannot ask for one —
 * it emails a code instead. Then activation needs a second code, texted to the
 * phone on the account. Users conflate them constantly, so each step names where
 * its code is coming from rather than saying "enter the code".
 */
export function AddAuthenticator({
	onBegin,
	onEmailCode,
	onCancel,
	onActivate,
	onBackup,
	onClose,
	onMove,
	onResolve,
	onClearStale,
	onEnrollmentStatus,
	onRetryEnrollment,
	onResolveEnrollment,
	recoveryQueued = false,
	unresolved,
	resume,
	requireProxies
}: {
	onBegin: (accountName: string, password: string, proxyUrl?: string) => Promise<EnrollBegin>;
	onEmailCode: (code: string) => Promise<EnrollBegin>;
	/**
	 * Whether the vault refuses to talk to Steam without a proxy.
	 *
	 * The main process already refuses a proxyless enrolment under this setting.
	 * Without it here the form said "optional" and offered a submit button that
	 * could only ever fail — inviting an action that cannot succeed, which is
	 * worse than not offering it.
	 */
	requireProxies: boolean;
	/** Drops the pending sign-in in the main process. Safe only before anything is attached. */
	onCancel: () => Promise<unknown>;
	onActivate: (
		steamId64: string,
		code: string
	) => Promise<{
		state: 'activated' | 'wantMore' | 'uncertain' | 'staleOperation' | 'unidentifiedOperation';
		kind?: 'activate' | 'deactivate';
		staleToken?: string;
		operationToken?: string;
		guidance?: string;
		certain?: boolean;
		persisted?: boolean;
		recoveryWarning?: string;
	}>;
	/** Opens the revocation-code ceremony for the newly enrolled account. */
	onBackup: (steamId64: string, accountName: string) => void;
	onClose: () => void;
	/**
	 * Switch to moving an authenticator that already exists on a phone.
	 *
	 * Offered here rather than as another button on the accounts screen, because
	 * here is where the person who needs it actually arrives: they press "add",
	 * Steam refuses because the account already has one, and the error tells them
	 * to remove it from their phone — which is the fifteen-day mistake. The way
	 * out belongs next to the wall, not in a row of seven buttons they read
	 * before they knew they had a problem.
	 */
	onMove: () => void;
	/**
	 * An account that is already enrolled but not activated, to resume.
	 *
	 * Enrollment used to be a one-shot wizard whose state died with the component,
	 * so leaving the screen — including by going to write the revocation code
	 * down, which the screen *tells* you to do — stranded the account as
	 * `ACTIVATION INCOMPLETE` with no way back in. Resuming makes the flow
	 * survive that, which it has to: the account already has an authenticator.
	 */
	resume?: { steamId64: string; accountName: string } | undefined;
	/**
	 * An activation on this account whose outcome was never established, read
	 * from the vault so it outlives this screen and a restart.
	 */
	unresolved?:
		| {
				kind?: 'activate' | 'deactivate';
				guidance: string;
				certain?: boolean;
				stale?: boolean;
				staleToken?: string;
				operationToken?: string;
				unidentified?: boolean;
		  }
		| undefined;
	/** Say the account has been checked, clearing the record above. */
	onResolve: (
		steamId64: string,
		operationToken: string,
		steamActed: boolean
	) => Promise<{ ok: true; recoveryWarning?: string }>;
	/** Discard only a record proved to describe an older authenticator. */
	onClearStale: (
		steamId64: string,
		kind: 'activate' | 'deactivate',
		staleToken: string
	) => Promise<unknown>;
	/** Durable AddAuthenticator state for an attempt that has no account row yet. */
	onEnrollmentStatus?: (() => Promise<EnrollmentStatus>) | undefined;
	/** Save a ciphertext-backed reply into the matching unlocked vault, without Steam. */
	onRetryEnrollment?: ((attemptId: string, steamId64: string) => Promise<EnrollBegin>) | undefined;
	/** Clear only the exact durable attempt after the user has established its outcome. */
	onResolveEnrollment?:
		| ((
				attemptId: string,
				steamId64: string,
				resolution: 'notAttached' | 'storedHere' | 'resolvedOutsideApp'
		  ) => Promise<unknown>)
		| undefined;
	/** A legacy transfer record also needs attention after this exact enrollment. */
	recoveryQueued?: boolean | undefined;
}): React.JSX.Element {
	const [step, setStep] = useState<'credentials' | 'emailCode' | 'activate' | 'done'>(
		resume ? 'activate' : 'credentials'
	);
	const [accountName, setAccountName] = useState('');
	const [password, setPassword] = useState('');
	const [proxyUrl, setProxyUrl] = useState('');
	const [code, setCode] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	/** A normal thing that happened, said in the ordinary voice rather than in red. */
	const [notice, setNotice] = useState<string | undefined>();
	const [recoveryWarning, setRecoveryWarning] = useState<string | undefined>();
	/**
	 * The request reached Steam and the reply did not.
	 *
	 * Its own state rather than an error, because the difference is what the
	 * screen must *offer*: an error is something to try again, and this is the one
	 * outcome where trying again may attach or detach a second time. The form goes
	 * away and the guidance takes its place.
	 */
	/*
	 * **Seeded from the account, not only from this session.** The refusal to
	 * repeat an activation whose outcome is unknown lived here and nowhere else,
	 * so closing the screen and coming back through "Finish activation" offered
	 * the form again — after the application had said it would not send the
	 * request a second time.
	 */
	const [uncertain, setUncertain] = useState<
		| {
				guidance: string;
				certain: boolean;
				persisted?: boolean;
				stale?: boolean;
				kind?: 'activate' | 'deactivate';
				staleToken?: string;
				operationToken?: string;
				unidentified?: boolean;
		  }
		| undefined
	>(
		unresolved === undefined
			? undefined
			: // Read from the account, so it is durable by construction.
				{
					guidance: unresolved.guidance,
					certain: unresolved.certain === true,
					persisted: true,
					...(unresolved.stale === true ? { stale: true } : {}),
					...(unresolved.kind === undefined ? {} : { kind: unresolved.kind }),
					...(unresolved.staleToken === undefined ? {} : { staleToken: unresolved.staleToken }),
					...(unresolved.operationToken === undefined
						? {}
						: { operationToken: unresolved.operationToken }),
					...(unresolved.unidentified === true ? { unidentified: true } : {})
				}
	);
	/** One local recovery action owns this screen until its exact result settles. */
	const [recoveryBusy, setRecoveryBusy] = useState(false);
	/**
	 * State disables the rendered controls; this ref closes the same-turn gap
	 * before React can paint that state. Retry and resolution are mutually
	 * exclusive operations over one durable record.
	 */
	const recoveryBusyRef = useRef(false);
	/*
	 * **A rejection has to be visible.** The buttons went `.then(onClose)` with no
	 * catch, so a refusal — a record for a different operation, an authenticator
	 * replaced since, nothing stored at all — closed the screen as though it had
	 * worked and changed nothing.
	 */
	const [resolveError, setResolveError] = useState<string | undefined>();
	const [pendingEnrollment, setPendingEnrollment] = useState<EnrollmentStatus['pending']>();
	const [journalProblem, setJournalProblem] = useState<string | undefined>();
	const enrollmentStatusRef = useRef(onEnrollmentStatus);
	useEffect(() => {
		enrollmentStatusRef.current = onEnrollmentStatus;
	}, [onEnrollmentStatus]);
	useEffect(() => {
		if (enrollmentStatusRef.current === undefined || resume !== undefined) {
			return;
		}
		let cancelled = false;
		void enrollmentStatusRef.current().then(
			(status) => {
				if (!cancelled) {
					setPendingEnrollment(status.pending);
					setJournalProblem(status.problem);
				}
			},
			(err: unknown) => {
				if (!cancelled) {
					setJournalProblem(messageOf(err));
				}
			}
		);
		return () => {
			cancelled = true;
		};
	}, [resume]);
	const [emailDomain, setEmailDomain] = useState<string | undefined>();
	const [enrolled, setEnrolled] = useState<
		| {
				steamId64: string;
				accountName: string;
				phoneNumberHint?: string;
				hasRevocationCode?: boolean;
		  }
		| undefined
	>(resume);

	/** Both entry points land here, because both can finish the enrollment. */
	const applyOutcome = (outcome: EnrollBegin): void => {
		/*
		 * **The end of the flow, not a failure it can retry from.**
		 *
		 * `AddAuthenticator` is sent before anything can go wrong with the answer,
		 * so a lost reply — or a reply Steam answered `ok` without the secrets, or a
		 * vault write that failed after it — leaves the account possibly or
		 * definitely carrying an authenticator this machine cannot use. All of those
		 * arrived here as thrown errors, which `run` handles by clearing `busy` and
		 * putting the form back, live, under a message saying not to try again.
		 */
		if (outcome.state === 'uncertain') {
			setUncertain({
				guidance: outcome.guidance,
				certain: outcome.certain === true,
				persisted: outcome.persisted
			});
			if (
				outcome.persisted === true &&
				outcome.attemptId !== undefined &&
				outcome.steamId64 !== undefined &&
				outcome.accountName !== undefined
			) {
				setPendingEnrollment({
					attemptId: outcome.attemptId,
					steamId64: outcome.steamId64,
					accountName: outcome.accountName,
					state: outcome.enrollmentState ?? (outcome.certain === true ? 'attached' : 'unanswered'),
					at: new Date().toISOString(),
					stored: outcome.stored === true,
					...(outcome.certain === undefined ? {} : { certain: outcome.certain }),
					...(outcome.recovery === undefined ? {} : { recovery: outcome.recovery }),
					...(outcome.usable === undefined ? {} : { usable: outcome.usable })
				});
			}
			return;
		}
		/*
		 * **Cleared on the way through, and this is not tidiness.**
		 *
		 * `uncertain` was only ever set, never unset. Gating the forms on it — which
		 * is what stops the screen offering the request it has just refused —
		 * therefore made a *successful* second attempt invisible: `setEnrolled` and
		 * `setStep('activate')` would run with a stale warning still set, the
		 * activation block is gated on the same flag, and the user would be looking
		 * at a panel about the previous attempt with no revocation-code button, at
		 * the exact moment this screen's own copy calls that the one step not to
		 * skip.
		 *
		 * An outcome that got this far is a live one. Whatever the last attempt
		 * left behind stops applying here.
		 */
		setUncertain(undefined);

		if (outcome.state === 'needsEmailCode') {
			setEmailDomain(outcome.emailDomain);
			setCode('');
			setStep('emailCode');
			return;
		}
		const details: {
			steamId64: string;
			accountName: string;
			phoneNumberHint?: string;
			hasRevocationCode?: boolean;
		} = {
			steamId64: outcome.steamId64,
			accountName: outcome.accountName,
			hasRevocationCode: outcome.hasRevocationCode
		};
		if (outcome.phoneNumberHint !== undefined) details.phoneNumberHint = outcome.phoneNumberHint;
		setEnrolled(details);
		setRecoveryWarning(outcome.recoveryWarning);
		if (
			outcome.recoveryWarning !== undefined &&
			outcome.recoveryAttemptId !== undefined &&
			outcome.recoveryAt !== undefined
		) {
			setPendingEnrollment({
				attemptId: outcome.recoveryAttemptId,
				steamId64: outcome.steamId64,
				accountName: outcome.accountName,
				state: 'recoverable',
				at: outcome.recoveryAt,
				stored: true,
				certain: true,
				recovery: 'durable',
				usable: true
			});
		}
		setCode('');
		setStep('activate');
	};

	const run = (work: () => Promise<void>): void => {
		if (busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		setNotice(undefined);
		work()
			.catch((err: unknown) => setError(messageOf(err)))
			.finally(() => setBusy(false));
	};

	const runRecovery = (
		work: () => Promise<void>,
		recordError: (message: string | undefined) => void
	): void => {
		if (busy || recoveryBusyRef.current) {
			return;
		}
		recoveryBusyRef.current = true;
		setRecoveryBusy(true);
		recordError(undefined);
		void Promise.resolve()
			.then(work)
			.catch((err: unknown) => recordError(messageOf(err)))
			.finally(() => {
				// The result above is recorded before the screen is released.
				setRecoveryBusy(false);
				recoveryBusyRef.current = false;
			});
	};
	const closeRecovery = (): void => {
		if (recoveryBusyRef.current) return;
		onClose();
	};

	const submitCredentials = (event: React.FormEvent): void => {
		event.preventDefault();
		run(async () => {
			// **Cleared in a `finally`, so a throw clears them too.**
			//
			// The password is single-use — the refresh token Steam issues is what
			// keeps the account working — and the proxy URL routinely carries a
			// username and password of its own. Both used to be cleared only on the
			// success path, so a sign-in that *rejected* (an IPC failure, a schema
			// refusal, a dead proxy) left them in component state, and in the DOM,
			// for the rest of a flow that can sit open for fifteen minutes waiting on
			// an email. Retyping after a failure is the cost, and it is the right one.
			const outcome = await onBegin(
				accountName.trim(),
				password,
				proxyUrl.trim() || undefined
			).finally(() => {
				setPassword('');
				setProxyUrl('');
			});
			applyOutcome(outcome);
		});
	};

	const submitEmailCode = (event: React.FormEvent): void => {
		event.preventDefault();
		run(async () => applyOutcome(await onEmailCode(code)));
	};

	const submitActivation = (event: React.FormEvent): void => {
		event.preventDefault();
		if (!enrolled) {
			return;
		}
		run(async () => {
			const result = await onActivate(enrolled.steamId64, code);
			if (result.state === 'staleOperation') {
				setUncertain({
					guidance:
						result.guidance ??
						'An old safety record must be cleared before this authenticator can be changed.',
					certain: false,
					persisted: true,
					stale: true,
					kind: result.kind ?? 'activate',
					...(result.staleToken === undefined ? {} : { staleToken: result.staleToken })
				});
				return;
			}
			if (result.state === 'unidentifiedOperation') {
				setUncertain({
					guidance:
						result.guidance ??
						'This legacy safety record cannot be matched to the authenticator stored now.',
					certain: false,
					persisted: true,
					unidentified: true,
					kind: result.kind ?? 'activate'
				});
				return;
			}
			if (result.state === 'uncertain') {
				/*
				 * **A dead end on purpose.** The request reached Steam and the reply did
				 * not, so the authenticator may already be active. Trying the same code
				 * again is the one thing that must not happen, and this used to arrive
				 * as an ordinary error — which cleared `busy` and re-enabled the button
				 * that sends it, while the message said not to.
				 */
				setUncertain({
					guidance: result.guidance ?? 'Steam did not answer, so the outcome is unknown.',
					certain: result.certain === true,
					persisted: result.persisted === true,
					/*
					 * **Carried, like the two branches above.** `recordFor` deliberately
					 * falls back to any applicable vault record when none matches the kind
					 * asked about, so asking about an activation can legitimately return a
					 * live *removal* record. Dropping the kind here left the screen showing
					 * removal guidance under activation controls.
					 */
					kind: result.kind ?? 'activate',
					...(result.operationToken === undefined ? {} : { operationToken: result.operationToken })
				});
				return;
			}
			if (result.state === 'wantMore') {
				// Not a failure, and it must not look like one. Steam accepted that code
				// and wants one from a later window, which is an ordinary part of its
				// flow — routing it through `setError` painted a working enrollment in
				// the red error style, at the step where the user is already worried
				// they have broken something irreversible.
				setCode('');
				setNotice(
					'Steam accepted that code and wants one more. Wait for the next one and enter it.'
				);
				return;
			}
			setRecoveryWarning(result.recoveryWarning);
			setStep('done');
		});
	};

	const resolvePendingEnrollment = (
		resolution: 'notAttached' | 'storedHere' | 'resolvedOutsideApp'
	): void => {
		if (pendingEnrollment === undefined || onResolveEnrollment === undefined) {
			return;
		}
		runRecovery(async () => {
			await onResolveEnrollment(
				pendingEnrollment.attemptId,
				pendingEnrollment.steamId64,
				resolution
			);
			setPendingEnrollment(undefined);
			setUncertain(undefined);
			if (resolution === 'notAttached') {
				setStep('credentials');
			} else {
				onClose();
			}
		}, setResolveError);
	};

	const retryPendingEnrollment = (): void => {
		if (pendingEnrollment === undefined || onRetryEnrollment === undefined) return;
		runRecovery(async () => {
			try {
				const outcome = await onRetryEnrollment(
					pendingEnrollment.attemptId,
					pendingEnrollment.steamId64
				);
				setPendingEnrollment(undefined);
				applyOutcome(outcome);
			} catch (err) {
				// An unusable reply deliberately rejects even after its ciphertext has
				// become durable: it must never be mistaken for a usable account. Refresh
				// the authoritative recovery state before showing that expected refusal,
				// otherwise the screen keeps claiming the only copy is in memory.
				if (enrollmentStatusRef.current !== undefined) {
					try {
						const status = await enrollmentStatusRef.current();
						setPendingEnrollment(status.pending);
						setJournalProblem(status.problem);
					} catch {
						// Keep the original persistence error; it is the actionable one.
					}
				}
				throw err;
			}
		}, setError);
	};

	if (journalProblem !== undefined) {
		return (
			<main className="shell">
				<h1>Enrollment needs attention</h1>
				<DynamicError>{journalProblem}</DynamicError>
				<p className="hint">
					No new authenticator will be requested while this safety record cannot be read. This is
					intentional: ignoring it could send AddAuthenticator twice.
				</p>
				{recoveryQueued && (
					<p className="notice">A saved authenticator transfer also needs attention next.</p>
				)}
				<div className="controls">
					<button type="button" className="secondary" onClick={onClose}>
						{recoveryQueued ? 'Review transfer recovery' : 'Close'}
					</button>
				</div>
			</main>
		);
	}

	if (pendingEnrollment !== undefined) {
		if (pendingEnrollment.recovery !== undefined && pendingEnrollment.stored) {
			return (
				<main className="shell">
					<h1>Finish the recovery backup</h1>
					<p className="lede">
						The authenticator for {pendingEnrollment.accountName} is safely stored in this vault.
					</p>
					<p className="notice" role="alert">
						{recoveryWarning ??
							'Its separate encrypted recovery backup is not yet verified. The encrypted workflow record remains available for a local retry.'}
					</p>
					{error !== undefined && <DynamicError id="add-authenticator-error">{error}</DynamicError>}
					<div className="controls">
						<button type="button" disabled={recoveryBusy} onClick={retryPendingEnrollment}>
							{recoveryBusy ? 'Saving…' : 'Finish recovery backup'}
						</button>
						<button
							type="button"
							className="secondary"
							onClick={closeRecovery}
							disabled={recoveryBusy}
						>
							{recoveryQueued ? 'Review transfer recovery' : 'Close'}
						</button>
					</div>
				</main>
			);
		}
		if (pendingEnrollment.recovery !== undefined && !pendingEnrollment.stored) {
			const durable = pendingEnrollment.recovery === 'durable';
			if (pendingEnrollment.usable === false) {
				return (
					<main className="shell">
						<h1>The authenticator reply cannot be used safely</h1>
						<p className="lede">
							Steam attached an authenticator to {pendingEnrollment.accountName}, but one of its
							one-time keys is malformed or the wrong length. It was not stored as a working
							account.
						</p>
						<p className="notice">
							{durable
								? 'The encrypted reply survives a restart for diagnosis or a future recovery tool.'
								: 'The encrypted reply exists only in this running app. Do not quit until the data-folder problem is repaired.'}{' '}
							Do not add another authenticator. Resolve or remove this one through Steam or Steam
							Support first.
						</p>
						{uncertain !== undefined && <DynamicError>{uncertain.guidance}</DynamicError>}
						{error !== undefined && (
							<DynamicError id="add-authenticator-error">{error}</DynamicError>
						)}
						{resolveError !== undefined && (
							<DynamicError id="resolve-enrollment-error">{resolveError}</DynamicError>
						)}
						<div className="controls">
							{!durable && (
								<button type="button" disabled={recoveryBusy} onClick={retryPendingEnrollment}>
									{recoveryBusy ? 'Saving…' : 'Save safety record now'}
								</button>
							)}
							<button
								type="button"
								disabled={recoveryBusy}
								onClick={() => resolvePendingEnrollment('resolvedOutsideApp')}
							>
								I resolved or removed it through Steam
							</button>
							<button
								type="button"
								className="secondary"
								onClick={closeRecovery}
								disabled={recoveryBusy}
							>
								{recoveryQueued ? 'Review transfer recovery' : 'Close'}
							</button>
						</div>
					</main>
				);
			}
			return (
				<main className="shell">
					<h1>Save the authenticator Steam created</h1>
					<p className="lede">
						Steam attached the authenticator to {pendingEnrollment.accountName}, but it has not been
						written into this vault yet.
					</p>
					<div className="notice">
						{durable ? (
							<p className="hint">
								Its encrypted safety record survives a restart. Unlock or restore the same vault and
								choose “Save it now”; Steam will not be contacted again.
							</p>
						) : (
							<p className="hint">
								Its encrypted reply is held only by this running app. Do not quit or restart: repair
								the application data folder and choose “Save it now”.
							</p>
						)}
					</div>
					{recoveryQueued && (
						<p className="notice">A saved authenticator transfer also needs attention next.</p>
					)}
					{uncertain !== undefined && <DynamicError>{uncertain.guidance}</DynamicError>}
					{error !== undefined && <DynamicError id="add-authenticator-error">{error}</DynamicError>}
					<div className="controls">
						<button type="button" disabled={recoveryBusy} onClick={retryPendingEnrollment}>
							{recoveryBusy ? 'Saving…' : 'Save it now'}
						</button>
						<button
							type="button"
							className="secondary"
							onClick={closeRecovery}
							disabled={recoveryBusy}
						>
							{recoveryQueued ? 'Review transfer recovery' : 'Close'}
						</button>
					</div>
				</main>
			);
		}
		const unknown = enrollmentMayBeClearedAsNotAttached(pendingEnrollment);
		return (
			<main className="shell">
				<h1>Finish checking {pendingEnrollment.accountName}</h1>
				{recoveryQueued && (
					<p className="notice">A saved authenticator transfer also needs attention next.</p>
				)}
				{pendingEnrollment.stored ? (
					<>
						<p className="lede">
							The authenticator and its secrets are already stored in this vault.
						</p>
						<p className="hint">
							Only the safety record could not be removed. Clearing it does not contact Steam or
							change the stored authenticator.
						</p>
					</>
				) : pendingEnrollment.state === 'not-attached' ? (
					<>
						<p className="lede">Steam did not add the authenticator.</p>
						<p className="hint">
							Only the local safety record could not be removed. Clear that record before trying
							again; doing so does not contact Steam.
						</p>
					</>
				) : pendingEnrollment.state === 'attached' || pendingEnrollment.certain === true ? (
					<>
						<p className="lede">
							Steam attached an authenticator, but this vault does not hold its secrets.
						</p>
						<p className="hint">
							This app cannot reconstruct those one-time secrets from Steam. If it previously
							reported that it wrote a recovery file, use Recover; otherwise resolve or remove the
							authenticator through Steam or Steam Support before clearing this record.
						</p>
					</>
				) : (
					<>
						<p className="lede">The app stopped after writing its safety record.</p>
						<p className="hint">
							The saved state does not prove whether the request reached Steam. Check Steam Guard on
							this exact account before choosing an answer.
						</p>
					</>
				)}
				{resolveError !== undefined && (
					<DynamicError id="resolve-enrollment-error">{resolveError}</DynamicError>
				)}
				{uncertain !== undefined && <DynamicError>{uncertain.guidance}</DynamicError>}
				<div className="controls">
					{pendingEnrollment.stored && (
						<button
							type="button"
							disabled={recoveryBusy}
							onClick={() => resolvePendingEnrollment('storedHere')}
						>
							The account is stored — clear the record
						</button>
					)}
					{unknown && (
						<button
							type="button"
							disabled={recoveryBusy}
							onClick={() => resolvePendingEnrollment('notAttached')}
						>
							Steam Guard was not added — allow me to try again
						</button>
					)}
					{!pendingEnrollment.stored && (
						<button
							type="button"
							disabled={recoveryBusy}
							onClick={() => resolvePendingEnrollment('resolvedOutsideApp')}
						>
							I resolved or removed it through Steam
						</button>
					)}
					<button
						type="button"
						className="secondary"
						onClick={closeRecovery}
						disabled={recoveryBusy}
					>
						{recoveryQueued ? 'Review transfer recovery' : 'Close'}
					</button>
				</div>
			</main>
		);
	}

	return (
		<main className="shell">
			<header className="row">
				<h1>Add an authenticator</h1>
				{/* Three different exits, because at three points in this flow the honest
				    thing to say is different.

				    Before sign-in: Cancel. Nothing has happened.

				    Waiting on the emailed code: still Cancel — Steam has authenticated
				    nothing and attached nothing. This step had *no* control at all, so a
				    mistyped account name left force-quitting or waiting out the idle
				    lock as the only ways out, with a live LoginSession running behind
				    the screen the whole time. It now tells the main process to drop it.

				    After the authenticator is attached: not a cancel, because there is
				    nothing left to cancel. "Finish later" matches what the copy on that
				    step already promises and what resuming actually does. Its absence
				    meant the only exits were activating successfully or the revocation
				    button beside it. */}
				{uncertain === undefined && step === 'credentials' && (
					<button type="button" className="secondary" onClick={onClose} disabled={busy}>
						Cancel
					</button>
				)}
				{uncertain === undefined && step === 'emailCode' && (
					<button
						type="button"
						className="secondary"
						onClick={() => {
							void onCancel();
							onClose();
						}}
						disabled={busy}
					>
						Cancel
					</button>
				)}
				{step === 'activate' && (
					<button
						type="button"
						className="secondary"
						onClick={closeRecovery}
						disabled={busy || recoveryBusy}
					>
						Finish later
					</button>
				)}
			</header>

			{error && <DynamicError id="add-authenticator-error">{error}</DynamicError>}
			{notice && <p className="hint">{notice}</p>}

			{/*
			 * **Gated, like the activation block below it.**
			 *
			 * The warning panel was rendered *above* these forms rather than instead
			 * of them, so after an outcome that says "this application will not send
			 * it again" the credentials form and the email-code form were still
			 * mounted, still enabled, and still wired to the handler. The sentence
			 * and the screen disagreed, and the screen is the one the user can act
			 * on: a probe invoked the irreversible call twice through it.
			 */}
			{uncertain === undefined && step === 'credentials' && (
				<>
					<div className="notice">
						<strong>This changes your Steam account, and it cannot be undone from here.</strong>
						<p className="hint">
							Signing in below tells Steam to attach a new authenticator. From that moment the
							account needs this app — or the revocation code — to log in. Steam issues that code
							once and never again, and the very next screen shows it to you.
						</p>
					</div>

					<div className="ceremony">
						<h2>Before you start</h2>
						<p className="hint">
							This screen is for an account with <strong>no</strong> authenticator yet. If the
							account already has one on a phone, do not remove it — move it across instead, using
							the link under the button below. Removing and re-adding costs fifteen days of no
							trading; moving does not.
						</p>
						<p className="hint">
							A phone number is <strong>not</strong> required. If the account has one, Steam texts
							the activation code; if it does not, Steam emails it instead.
						</p>
					</div>

					<form onSubmit={submitCredentials}>
						<label htmlFor="enroll-account">Steam account name</label>
						<input
							id="enroll-account"
							type="text"
							value={accountName}
							disabled={busy}
							onChange={(event) => setAccountName(event.target.value)}
							autoComplete="off"
							spellCheck={false}
						/>

						<label htmlFor="enroll-password">Steam password</label>
						<input
							id="enroll-password"
							type="password"
							value={password}
							disabled={busy}
							onChange={(event) => setPassword(event.target.value)}
							autoComplete="off"
						/>
						<p className="hint">
							Used once, to sign in, and never stored. What is kept is the session Steam gives back.
						</p>

						<label htmlFor="enroll-proxy">
							{requireProxies
								? 'Route this account through a proxy (required)'
								: 'Route this account through a proxy (optional)'}
						</label>
						<input
							id="enroll-proxy"
							type="text"
							value={proxyUrl}
							disabled={busy}
							onChange={(event) => setProxyUrl(event.target.value)}
							placeholder="socks5://host:1080"
							autoComplete="off"
							spellCheck={false}
						/>
						{/* Offered here rather than only afterwards, and the reason is worth
						    stating: an account enrolled from one address and then routed
						    through another is linked to both, by Steam, through the account
						    itself. Adding routing later cannot undo the first request. */}
						{/* **SOCKS4 was on this list, and the transport has never taken it.**
						    `planProxy` refuses `socks4://` deliberately: the protocol carries an
						    address and not a hostname, so the client has to resolve first, and
						    every Steam host is then looked up by this machine, in the clear, on
						    whatever resolver the network hands out. That is the leak routing an
						    account exists to close.

						    The screen invited people into it anyway. They typed a socks4 address
						    into the field above and the main process turned them away with a
						    message contradicting the sentence directly beneath it — mid sign-in,
						    password already entered.

						    The reason is spelled out rather than left at "not supported", because
						    "not supported" reads as "not built yet" and earns a feature request
						    instead of a socks5 address. */}
						<p className="hint">
							<code>http</code>, <code>https</code> and <code>socks5</code> are accepted; the
							example is only an example. SOCKS4 is refused rather than merely unbuilt: it cannot
							ask a proxy to look a hostname up, so this machine would resolve every Steam address
							itself and your own network would see which accounts you are contacting.{' '}
							{/* The label above says required under this setting, and the main
							    process refuses an empty field. A hint still offering to leave
							    it empty contradicted both. */}
							{requireProxies
								? 'This vault requires a proxy, so it cannot be left empty.'
								: 'Leave empty to use this machine’s own connection.'}{' '}
							If you intend to route this account at all, <strong>set it now</strong> — Steam sees
							the address every request comes from, so enrolling here and routing later ties the two
							together permanently.
						</p>

						<div className="controls">
							<button
								type="submit"
								disabled={
									busy ||
									accountName.trim() === '' ||
									password === '' ||
									// Under `Require proxies` an empty field is a submission the
									// main process will refuse, so it is not offered.
									(requireProxies && proxyUrl.trim() === '')
								}
							>
								{busy ? 'Talking to Steam…' : 'Sign in and add authenticator'}
							</button>
						</div>

						<p className="hint">
							Already have an authenticator on your phone for this account?{' '}
							{/* **Disabled while a sign-in is in the air.** Submit was guarded by
							    `busy` and this was not, so pressing it during `onBegin` only
							    changed the view: the component unmounted, the main process
							    carried on, and Steam could attach an authenticator whose
							    ceremony — the revocation code the user must write down — had
							    no screen left to run on. */}
							<button type="button" className="link" onClick={onMove} disabled={busy}>
								Move it here instead
							</button>{' '}
							— adding a second one is not possible, and removing the first costs fifteen days of no
							trading.
						</p>
					</form>
				</>
			)}

			{uncertain === undefined && step === 'emailCode' && (
				<form onSubmit={submitEmailCode}>
					<div className="ceremony">
						<h2>Check your email</h2>
						<p>
							This account has no authenticator yet, so Steam sent a code to your email
							{emailDomain === undefined ? '' : ` at ${emailDomain}`} rather than to an app.
						</p>
					</div>

					<label htmlFor="enroll-email-code">Code from your email</label>
					<input
						id="enroll-email-code"
						type="text"
						value={code}
						disabled={busy}
						onChange={(event) => setCode(event.target.value)}
						autoComplete="off"
						spellCheck={false}
					/>
					<p className="hint">
						Nothing has changed on your account yet. Getting this wrong costs you nothing — you can
						try the code again.
					</p>

					<div className="controls">
						<button type="submit" disabled={busy || code.trim() === ''}>
							{busy ? 'Checking…' : 'Continue'}
						</button>
					</div>
				</form>
			)}

			{uncertain !== undefined && (
				<section className="ceremony">
					{/*
					 * **Two true headings rather than one that fits both.**
					 *
					 * This said "This may already have happened" for every case. Two of
					 * them are not maybes: Steam answered `ok` without the secrets, or it
					 * returned them and the vault write failed. Telling someone nothing
					 * can tell whether Steam acted, when it certainly did — and when the
					 * text below may be carrying the only copy of their revocation code —
					 * is false at the moment they most need a true sentence.
					 */}
					<h2>
						{uncertain.unidentified
							? 'This safety record cannot be matched'
							: uncertain.stale
								? 'An old safety record needs clearing'
								: uncertain.certain
									? 'Steam has already done this'
									: 'This may already have happened'}
					</h2>
					<p>{uncertain.guidance}</p>
					<p>
						{uncertain.unidentified
							? 'The app cannot prove whether this record describes the authenticator stored now, so it will not clear the record, change the account, or contact Steam.'
							: uncertain.stale
								? 'The old record does not describe the authenticator stored now. Clearing it does not contact Steam or change this account.'
								: uncertain.certain
									? 'Follow the steps above before starting another enrollment for this account.'
									: 'Nothing here can tell whether Steam acted on the last request. Check the Steam ' +
										'mobile app before doing anything else.'}
					</p>
					{/*
					 * **Only promised when it is true.** The refusal is kept on the
					 * account, and that write can fail — a full disk, a vault that locked
					 * while Steam was being waited on. It was caught and swallowed, and
					 * the screen went on saying the request would not be sent again about
					 * a record that does not exist.
					 */}
					<p>
						{uncertain.unidentified
							? 'Keep your backup and contact support before changing Steam Guard for this account.'
							: uncertain.stale
								? 'The activation form stays unavailable until that exact old record is cleared.'
								: uncertain.persisted === false
									? 'This warning could not be saved, so it will be gone once you close this ' +
										'window and the account will look ordinary again. Write down what it says ' +
										'above before you close it.'
									: 'This application will not send the request again.'}
					</p>
					{resolveError !== undefined && (
						<DynamicError id="resolve-enrollment-error">{resolveError}</DynamicError>
					)}
					<div className="controls">
						<button type="button" onClick={closeRecovery} disabled={recoveryBusy}>
							Close
						</button>
						{uncertain.stale && enrolled !== undefined && uncertain.staleToken !== undefined && (
							<button
								type="button"
								disabled={recoveryBusy}
								onClick={() => {
									runRecovery(async () => {
										await onClearStale(
											enrolled.steamId64,
											uncertain.kind ?? 'activate',
											uncertain.staleToken!
										);
										onClose();
									}, setResolveError);
								}}
							>
								Clear old safety record
							</button>
						)}
						{/*
						 * Only the user can settle this: nothing here knows what Steam did.
						 * Without an explicit way out the account carries the warning for
						 * ever, and a warning that never clears is one people learn to
						 * ignore.
						 */}
						{/*
						 * **Two answers.** One generic "I have checked" cleared the record
						 * and left the account reading `pendingActivation`, so "Finish
						 * activation" came straight back — and on an authenticator Steam
						 * had already activated it fails in a way that looks like a wrong
						 * code. What the user found is the only thing that settles it.
						 */}
						{/*
						 * The deny side is offered only where the outcome is genuinely
						 * unknown. When Steam is known to have acted, "it did not" is a
						 * false statement, and acting on it clears the protection and
						 * re-offers an operation that has already happened.
						 */}
						{/*
						 * Nothing stored means nothing to resolve, so both answers can only
						 * come back refused. The paragraph above already says the warning
						 * will not survive this window.
						 */}
						{uncertain.kind !== 'deactivate' &&
							!uncertain.stale &&
							!uncertain.unidentified &&
							uncertain.persisted !== false &&
							uncertain.operationToken !== undefined &&
							enrolled !== undefined && (
								<>
									<button
										type="button"
										disabled={recoveryBusy}
										onClick={() => {
											runRecovery(async () => {
												const result = await onResolve(
													enrolled.steamId64,
													uncertain.operationToken!,
													true
												);
												if (result.recoveryWarning === undefined) {
													onClose();
													return;
												}
												setRecoveryWarning(result.recoveryWarning);
												setUncertain(undefined);
												setStep('done');
											}, setResolveError);
										}}
									>
										Steam Guard is on this account now
									</button>
									{!uncertain.certain && (
										<button
											type="button"
											disabled={recoveryBusy}
											onClick={() => {
												runRecovery(async () => {
													await onResolve(enrolled.steamId64, uncertain.operationToken!, false);
													onClose();
												}, setResolveError);
											}}
										>
											Steam Guard is not on it — let me try again
										</button>
									)}
								</>
							)}
						{/*
						 * **A removal is not answerable here, so it is not offered here.**
						 *
						 * Plumbing the kind through `onResolve` would look like the fix and
						 * is not one: answering "yes, Steam did it" for a *removal* deletes
						 * the account, which the main process requires the vault passphrase
						 * for — and this screen has no passphrase field. That trades a kind
						 * refusal for a passphrase refusal and leaves the user just as stuck.
						 *
						 * So the record is described and the reader is sent to the screen
						 * that can actually settle it.
						 */}
						{uncertain.kind === 'deactivate' && uncertain.persisted !== false && (
							<p className="hint">
								The unfinished operation recorded against this account is a <strong>removal</strong>
								, not an activation, and answering it deletes the account — so it is settled from{' '}
								<strong>Remove account</strong>, which asks for your vault passphrase. Close this
								screen and open it there.
							</p>
						)}
					</div>
				</section>
			)}

			{uncertain === undefined && step === 'activate' && enrolled && (
				<>
					<div className="notice">
						<strong>
							{resume
								? `${enrolled.accountName} has an authenticator, but it was never activated.`
								: `The authenticator is attached to ${enrolled.accountName}.`}
						</strong>
						{enrolled.hasRevocationCode === false ? (
							<p className="hint bad">
								Steam did not return a revocation code. The login and confirmation secrets are
								saved, but this authenticator cannot be detached or self-recovered from this app.
								Keep the vault backed up.
							</p>
						) : (
							<>
								<p className="hint">
									Steam has issued its secrets and this app has saved them.{' '}
									<strong>Write down the revocation code now</strong> — it is the one route back
									that depends on nothing else if you ever lose this vault, and Steam will not show
									it again.
								</p>
								<div className="controls">
									<button
										type="button"
										onClick={() => onBackup(enrolled.steamId64, enrolled.accountName)}
										disabled={busy}
									>
										Show my revocation code
									</button>
								</div>
							</>
						)}
					</div>

					<form onSubmit={submitActivation}>
						<h2>Finish activating</h2>
						{/* Where the code came from is decided by whether Steam returned a
						    phone hint — never assumed. An account with no phone enrols
						    perfectly well and Steam emails the code instead (F-10, settled
						    by live run). Telling somebody to check a phone they do not have
						    is how a working flow reads as broken. */}
						{resume ? (
							// Resumed from the account list: the delivery method was not
							// carried across. Naming both beats confidently naming the wrong one.
							<p className="hint">
								Enter the activation code Steam sent when this authenticator was added — by email if
								the account has no phone number, by text if it has one.
							</p>
						) : enrolled.phoneNumberHint === undefined ? (
							<p className="hint">
								There is no phone number on this account, so Steam sent the code to its{' '}
								<strong>email address</strong> — nothing was texted. Entering it proves the secrets
								arrived intact.
							</p>
						) : (
							<p className="hint">
								Steam has texted a code to the phone ending {enrolled.phoneNumberHint}. Entering it
								proves the secrets arrived intact.
							</p>
						)}

						<label htmlFor="enroll-sms-code">
							{resume
								? 'Activation code'
								: enrolled.phoneNumberHint === undefined
									? 'Code from your email'
									: 'Code from the text message'}
						</label>
						<input
							id="enroll-sms-code"
							type="text"
							value={code}
							disabled={busy}
							onChange={(event) => setCode(event.target.value)}
							autoComplete="off"
							spellCheck={false}
						/>

						<div className="controls">
							<button type="submit" disabled={busy || code.trim() === ''}>
								{busy ? 'Activating…' : 'Activate'}
							</button>
						</div>
						<p className="hint">
							If you close this before activating, the account stays in your vault and you can
							finish later — but it is already using this authenticator either way.
						</p>
					</form>
				</>
			)}

			{step === 'done' && enrolled && (
				<div className="ceremony">
					<h2>{enrolled.accountName} is ready</h2>
					{recoveryWarning !== undefined && (
						<p className="hint bad" role="alert">
							{recoveryWarning}
						</p>
					)}
					<p>
						Steam Guard codes for this account now come from here. Steam will ask for one the next
						time you sign in anywhere.
					</p>
					<p className="hint">
						{enrolled.hasRevocationCode === false
							? 'Steam did not return a revocation code; keep this vault backed up.'
							: 'If you have not written the revocation code down yet, do it before you close this.'}
					</p>
					<div className="controls">
						{enrolled.hasRevocationCode !== false && (
							<button
								type="button"
								onClick={() => onBackup(enrolled.steamId64, enrolled.accountName)}
								disabled={recoveryBusy}
							>
								Show my revocation code
							</button>
						)}
						<button
							type="button"
							className="secondary"
							onClick={closeRecovery}
							disabled={recoveryBusy}
						>
							Done
						</button>
					</div>
				</div>
			)}
		</main>
	);
}
