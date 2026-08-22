import { useEffect, useRef, useState } from 'react';
import type {
	TransferAuthenticated,
	TransferComplete,
	TransferStartChallenge,
	TransferStatus
} from '../../shared/ipc';
import { messageOf } from '../ipc-message';

/**
 * Moving an authenticator that already lives on the Steam mobile app.
 *
 * ## Why this is not the "add authenticator" screen
 *
 * Adding attaches an authenticator to an account that has none. This replaces
 * one that exists. Steam treats them as different operations and charges
 * different prices for them: a transfer carries the shorter restriction, while
 * removing an authenticator and enrolling a new one costs fifteen days of no
 * trading and no Market. Anybody who reads "remove it in the Steam app first"
 * and does that has paid the higher price for nothing.
 *
 * So the two flows stay apart, and this one says plainly that the phone should
 * be left exactly as it is.
 *
 * ## The shape of the screen follows the shape of the risk
 *
 * This step — signing in — changes nothing on the Steam account. It can be
 * abandoned, retried, and walked away from, and the phone keeps working. That
 * is worth saying, because the equivalent screen for enrolment is the opposite:
 * there, the sign-in is the irreversible moment.
 *
 * The irreversible moment here comes later, when a texted code is submitted and
 * Steam rotates the authenticator. This screen therefore ends by naming what is
 * about to be needed — the phone, and its number — rather than by pretending the
 * work is done.
 */
export function MoveAuthenticator({
	onAuthenticate,
	onCancel,
	onStartChallenge,
	onComplete,
	onRetryPersist,
	onStatus,
	onClose
}: {
	onAuthenticate: (
		accountName: string,
		password: string,
		steamGuardCode: string,
		proxyUrl?: string
	) => Promise<TransferAuthenticated>;
	/** Drops the pending sign-in in the main process. Always safe at this stage. */
	onCancel: () => Promise<unknown>;
	/** Asks Steam to text a code. Reversible, but it spends a message and a rate limit. */
	onStartChallenge: () => Promise<TransferStartChallenge>;
	/** **Irreversible.** Submits the code and replaces the authenticator. */
	onComplete: (smsCode: string) => Promise<TransferComplete>;
	/** Stores a replacement Steam already issued. Steam is not asked again. */
	onRetryPersist: () => Promise<TransferComplete>;
	/**
	 * Asks the main process what, if anything, this transfer is still waiting on.
	 *
	 * The screen cannot answer that itself after a vault lock: locking reloads the
	 * window, and every piece of state below is gone. The secrets are not — they
	 * are held in the main process, and this is how the screen finds out it is
	 * supposed to come back for them.
	 */
	onStatus: () => Promise<TransferStatus>;
	onClose: () => void;
}): React.JSX.Element {
	const [accountName, setAccountName] = useState('');
	const [password, setPassword] = useState('');
	const [code, setCode] = useState('');
	const [proxyUrl, setProxyUrl] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [authenticated, setAuthenticated] = useState<TransferAuthenticated | undefined>(undefined);
	const [challenge, setChallenge] = useState<TransferStartChallenge | undefined>(undefined);
	const [smsCode, setSmsCode] = useState('');
	const [done, setDone] = useState<TransferComplete | undefined>(undefined);
	const [savedCode, setSavedCode] = useState(false);
	/**
	 * True once Steam has been asked to rotate.
	 *
	 * From this point the screen stops offering to cancel, because cancelling is
	 * no longer a thing that exists — the authenticator has moved whether or not
	 * anything here succeeds afterwards.
	 */
	const [committed, setCommitted] = useState(false);
	/**
	 * The retry the main process says is outstanding, straight from its own state.
	 *
	 * Authoritative in a way nothing else on this screen is. Everything above is
	 * lost when the vault locks and reloads the window; this is read back
	 * afterwards, which is what lets a rotated-but-unsaved authenticator be
	 * finished instead of stranded.
	 */
	const [awaiting, setAwaiting] = useState<'persist' | 'unanswered' | 'unreadable' | undefined>(
		undefined
	);

	/**
	 * Asked once on mount.
	 *
	 * Through a ref because the parent re-renders every second to drive the
	 * auto-lock countdown, handing down a fresh callback each time — the same trap
	 * that had the confirmations screen polling Steam once a second.
	 */
	const statusRef = useRef(onStatus);
	useEffect(() => {
		statusRef.current = onStatus;
	}, [onStatus]);

	useEffect(() => {
		let cancelled = false;
		statusRef
			.current()
			.then((status) => {
				if (cancelled || !status.awaiting) {
					return;
				}
				// Steam has already rotated the authenticator, whatever this document
				// happens to know. Saying so is the whole point of asking.
				setAwaiting(status.awaiting);
				setCommitted(true);
			})
			.catch(() => {
				// A status check that fails is not worth a message. The user either has
				// a normal transfer to start, or will find out from the retry itself.
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const submit = async (event: React.FormEvent): Promise<void> => {
		event.preventDefault();
		// A second press while the first is in flight would start a second sign-in
		// against the same account. The main process refuses it; the button should
		// not have offered it.
		if (busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			setAuthenticated(await onAuthenticate(accountName, password, code, proxyUrl));
			// Held only as long as the request. Nothing about this screen needs the
			// password again, and the code is single-use.
		} catch (err) {
			setError(messageOf(err));
		} finally {
			// **Cleared however it settled.** The password is single-use, the Guard
			// code is one-time and already spent by the attempt, and the proxy URL
			// routinely carries credentials of its own — yet all three survived a
			// rejection (bad credentials, an IPC error, a dead proxy) and sat in React
			// state and the DOM until the field was edited or the screen went away.
			// `SteamSignIn` and `AddAuthenticator` already do this.
			setPassword('');
			setCode('');
			setProxyUrl('');
			setBusy(false);
		}
	};

	const requestCode = async (): Promise<void> => {
		if (busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			setChallenge(await onStartChallenge());
		} catch (err) {
			setError(messageOf(err));
		} finally {
			setBusy(false);
		}
	};

	const submitCode = async (): Promise<void> => {
		if (busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		// Set *before* the request, and that is deliberate: a request that times out
		// may still have rotated the authenticator, so the pessimistic assumption is
		// the safe one. What follows in the catch is how it gets taken back.
		setCommitted(true);
		try {
			setDone(await onComplete(smsCode));
			setSmsCode('');
		} catch (err) {
			setError(messageOf(err));
			// **Ask whether anything is actually held.**
			//
			// A mistyped code is the ordinary failure here, and Steam rejects it
			// without changing a thing. The screen used to keep `committed` anyway,
			// so it hid Close, announced that the authenticator had been replaced,
			// and offered "Try saving again" — which calls `retryPersist`, which
			// throws "There is no unsaved authenticator to store." The user was told
			// an irreversible thing had happened, then trapped on the screen saying
			// so, over a typo.
			//
			// The main process knows the truth: nothing held means nothing happened.
			try {
				const status = await statusRef.current();
				setAwaiting(status.awaiting);
				if (!status.awaiting) {
					setCommitted(false);
				}
			} catch {
				// Unreachable in practice, and if it is not, the pessimistic state is
				// the one to keep. Leaving `committed` set costs the user a Close
				// button; clearing it wrongly would offer to cancel a transfer that
				// really had gone through.
			}
		} finally {
			setBusy(false);
		}
	};

	const retrySave = async (): Promise<void> => {
		if (busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			// Storage is the only stage that can be retried at all — see `awaiting`.
			setDone(await onRetryPersist());
			// Nothing is outstanding any more. Cleared explicitly so the recovery
			// branch cannot re-assert itself over the success screen.
			setAwaiting(undefined);
		} catch (err) {
			setError(messageOf(err));
		} finally {
			setBusy(false);
		}
	};

	/*
	 * The recovery-code ceremony.
	 *
	 * Shown only once the secrets are provably on disk, and it will not let the
	 * user leave by pretending. Steam issues this code once; the account it
	 * belongs to now depends on this machine.
	 */
	/*
	 * Picking a transfer back up after the window reloaded under it.
	 *
	 * Reached when the main process reports an outstanding retry and this document
	 * has no memory of the transfer — which is exactly the state a vault lock
	 * leaves behind, because locking reloads the window and everything above is
	 * per-document. Steam has already rotated the authenticator by this point, so
	 * the only copy of the replacement is the one being held for this screen.
	 *
	 * Placed before `done` and `authenticated` because neither survives a reload:
	 * without it the screen offered a fresh sign-in form and the held secrets were
	 * unreachable until the process exited and took them with it.
	 */
	if (awaiting === 'unreadable' && !done) {
		return (
			<main className="shell">
				<h1>This transfer cannot be completed</h1>
				<p className="lede">
					Steam replaced the authenticator on this account, and this version could not read what it
					sent back.
				</p>
				<div className="notice">
					<strong>The account still has Steam Guard, and nothing here holds it.</strong>
					<p className="hint">
						There is nothing to retry: the reply was already read as carefully as this version knows
						how, and reading it again would do exactly the same thing. Steam Support is the route
						back into the account.
					</p>
				</div>
				{error ? <p className="error">{error}</p> : undefined}
				<div className="controls">
					<button
						type="button"
						className="secondary"
						onClick={() => {
							void onCancel().catch(() => undefined);
							onClose();
						}}
					>
						Close
					</button>
				</div>
			</main>
		);
	}

	/*
	 * A submission that went out and was never answered.
	 *
	 * Nothing is held, and that is what makes it dangerous rather than harmless:
	 * the request may have reached Steam and rotated the authenticator. Reported
	 * separately because every other state here can say what happened, and this
	 * one cannot — the only way to find out is the phone.
	 */
	if (awaiting === 'unanswered' && !done) {
		return (
			<main className="shell">
				<h1>This transfer was not answered</h1>
				<p className="lede">
					The code was submitted and the connection failed before Steam replied. This application
					cannot tell whether the authenticator was replaced.
				</p>
				<div className="notice">
					<strong>Do not assume it went through, and do not assume it did not.</strong>
					<p className="hint">
						Open the Steam mobile app and look at this account. If it still shows a Steam Guard
						code, nothing changed and you can start again. If it no longer does, the transfer
						reached Steam and the new authenticator was never delivered here — Steam Support is the
						route back in.
					</p>
				</div>
				{error ? <p className="error">{error}</p> : undefined}
				<div className="controls">
					{/* No retry, and no second submission. The code is spent either way,
					    and sending another would be a second irreversible request made on
					    a guess about the first. Closing is the only honest control. */}
					<button
						type="button"
						className="secondary"
						onClick={() => {
							void onCancel().catch(() => undefined);
							onClose();
						}}
					>
						I have checked the Steam app
					</button>
				</div>
			</main>
		);
	}

	// **`=== 'persist'`, not a truthy check.**
	//
	// This was `awaiting && !authenticated`, which caught every outstanding state
	// — including the two above it that have their own screens. `authenticated` is
	// undefined after the reload a lock causes, so a transfer that had ended
	// unusably landed here instead: on a screen telling the user secrets were held
	// and would be lost if they quit, offering a "Save it now" that calls
	// `retryPersist` and throws "There is no unsaved authenticator to store".
	//
	// Exactly the trap removing the decode retry was meant to close, reintroduced
	// by the order these branches sit in.
	// **`!done`, but not `!authenticated`.** `authenticated` stays set for the
	// whole flow — it is what proves the sign-in happened — so requiring it to be
	// absent meant a persist failure never reached this screen: the user stayed
	// on the code form, where "Replace the authenticator" was still enabled for
	// an authenticator Steam had *already* rotated. Pressing it could only be
	// refused, while "Try saving again" — the one button that can succeed — sat
	// below it as a secondary control and the only copy of the new secrets lived
	// in memory. `awaiting === 'persist'` is already the precise statement that
	// Steam is done and the vault is not.
	if (awaiting === 'persist' && !done) {
		return (
			<main className="shell">
				<h1>Finish moving this authenticator</h1>
				<p className="lede">
					Steam has already replaced the authenticator on this account. The new one has not been
					saved here yet — it was interrupted, most likely by the vault locking.
				</p>
				<div className="notice">
					<strong>Do not close this window until it is saved.</strong>
					<p className="hint">
						Steam issues these secrets once and will not send them again. They are held in memory
						and will be lost if this application exits.
					</p>
				</div>
				<p className="hint">
					The new authenticator was read successfully and still needs writing to the vault. Trying
					again only stores it; Steam is not contacted.
				</p>
				{error ? <p className="error">{error}</p> : undefined}
				<div className="controls">
					<button type="button" disabled={busy} onClick={() => void retrySave()}>
						{busy ? 'Working…' : 'Save it now'}
					</button>
				</div>
			</main>
		);
	}

	/*
	 * Steam rotated the authenticator and sent back something this build cannot
	 * use — a reply that would not decode, or a replacement it would not validate.
	 *
	 * A dead end, and the screen says so. An earlier version kept the bytes and
	 * offered to try again: the retry ran the same pure decoder over the same
	 * bytes and could only fail the same way, and the encrypted copy it wrote had
	 * nothing anywhere able to read it. Offering a recovery that cannot recover is
	 * worse than saying plainly that there is none.
	 */
	if (done) {
		return (
			<main className="shell">
				<h1>{done.accountName} has moved</h1>
				<p className="lede">
					The authenticator is now held here. The one on your phone is no longer the account&rsquo;s
					authenticator.
				</p>

				<div className="notice">
					<strong>Write this recovery code down before you close this window.</strong>
					<p className="hint">
						It is the only way to detach this authenticator yourself if this machine is lost. Steam
						issued it once and will not issue it again.
					</p>
					<p className="code">{done.revocationCode}</p>
				</div>

				<div className="ceremony">
					<h2>What to expect now</h2>
					<p className="hint">
						Steam applies a short trading and Market restriction after a transfer. Codes and
						confirmations work throughout; only trading is held.
					</p>
					<p className="hint">
						Nothing needs removing from the Steam mobile app. Steam replaced the authenticator on
						its side, so the app&rsquo;s copy is already inert.
					</p>
				</div>

				<label className="checkbox">
					<input
						type="checkbox"
						checked={savedCode}
						onChange={(event) => setSavedCode(event.target.checked)}
					/>
					I have written the recovery code down somewhere other than this computer
				</label>

				<div className="controls">
					<button type="button" disabled={!savedCode} onClick={onClose}>
						Done
					</button>
				</div>
			</main>
		);
	}

	if (authenticated) {
		return (
			<main className="shell">
				<h1>Signed in to {authenticated.accountName}</h1>
				{/* Conditional, because the same branch renders after a submission that
				    failed to save. Unconditionally, this reassured the user that nothing
				    had changed while the controls beside it offered to retry storing an
				    authenticator Steam had already rotated — the same contradiction the
				    removed "nothing will happen" line created one step further down. */}
				{committed ? (
					<p className="lede">
						Steam has already replaced the authenticator on this account. It is not saved here yet.
					</p>
				) : (
					<p className="lede">
						Nothing on the Steam account has changed yet, and the authenticator on your phone is
						still the one in charge.
					</p>
				)}

				<div className="notice">
					<strong>The next step is the one that cannot be undone.</strong>
					<p className="hint">
						Submitting the texted code asks Steam to <strong>replace</strong> the authenticator. The
						one on your phone stops being the account&rsquo;s authenticator at that moment.
					</p>
				</div>

				<div className="ceremony">
					<h2>What happens next</h2>
					<p className="hint">
						Steam texts a code to the phone number on the account. Have it to hand — there is no way
						to finish without it.
					</p>
					<p className="hint">
						Steam normally applies a short trading and Market restriction to a transfer. That is
						expected, and far shorter than the fifteen days a remove-and-add costs.
					</p>
					<p className="hint">
						You will be given a new recovery code. Write it down before doing anything else — it is
						the only way back in if this machine is lost.
					</p>
				</div>

				{error ? <p className="error">{error}</p> : undefined}

				{challenge ? (
					<div className="notice">
						<strong>
							{challenge.sent
								? 'Steam has sent the code to your phone.'
								: 'Steam did not send a code.'}
						</strong>
						<p className="hint">
							{challenge.sent
								? 'Check the phone on the account. The code is single-use and Steam rate-limits requests for another.'
								: (challenge.meaning ??
									`Steam answered without confirming it${challenge.eresult === undefined ? '' : ` (result ${challenge.eresult})`}.`)}
						</p>
						{challenge.sent ? undefined : (
							<p className="hint">
								Nothing has changed on the account. Steam&rsquo;s texts are unreliable even in its
								own app, so a missing message is not proof anything is wrong — close this and try
								again in a few minutes.
							</p>
						)}
					</div>
				) : (
					<p className="hint">
						Nothing is sent until you press the button below, and nothing is changed even then.
					</p>
				)}

				{challenge?.sent ? (
					<>
						<div className="notice">
							<strong>Submitting the code cannot be undone.</strong>
							<p className="hint">
								Steam replaces the authenticator the moment it accepts this code. Do not close this
								window until it says the new one has been saved.
							</p>
						</div>

						<label htmlFor="move-sms">Code Steam sent to your phone</label>
						<input
							id="move-sms"
							type="text"
							value={smsCode}
							onChange={(event) => setSmsCode(event.target.value)}
							autoComplete="off"
							spellCheck={false}
							maxLength={16}
							disabled={committed && !error}
						/>
					</>
				) : undefined}

				<div className="controls">
					{challenge ? undefined : (
						<button type="button" disabled={busy} onClick={() => void requestCode()}>
							{busy ? 'Asking Steam…' : 'Send the code to my phone'}
						</button>
					)}
					{challenge?.sent ? (
						<button
							type="button"
							disabled={busy || smsCode.trim() === ''}
							onClick={() => void submitCode()}
						>
							{busy ? 'Working…' : 'Replace the authenticator'}
						</button>
					) : undefined}
					{committed && error && awaiting !== 'unreadable' ? (
						// Storage only. A decode failure is deterministic, so a button for
						// it would be a button that cannot succeed — the text above says so
						// instead.
						<button type="button" disabled={busy} onClick={() => void retrySave()}>
							Try saving again
						</button>
					) : undefined}
					{committed ? undefined : (
						<button
							type="button"
							className="secondary"
							// **Disabled while a request is in the air.** It was not, so it was
							// pressable during "Send the code to my phone": the screen closed,
							// the cancel was refused, and Steam sent the message anyway —
							// spending a rate limit on a transfer the user had just abandoned.
							// The main process refuses this now; the button should not offer it.
							disabled={busy}
							onClick={() => {
								// Refuses once Steam has replaced the authenticator, which is
								// correct and is why this button is hidden then. Swallowed rather
								// than left to become an unhandled rejection: closing a screen must
								// not depend on the main process agreeing to forget it.
								void onCancel().catch(() => undefined);
								onClose();
							}}
						>
							Close
						</button>
					)}
				</div>
			</main>
		);
	}

	return (
		<main className="shell">
			<h1>Move an authenticator from the Steam mobile app</h1>
			<p className="lede">
				Steam replaces the authenticator on your phone with one here. A new secret is issued to this
				app, and the one on the phone stops being the account&rsquo;s authenticator.
			</p>

			<div className="notice">
				<strong>Do not remove the authenticator from your phone first.</strong>
				<p className="hint">
					Removing it and adding a new one is a different operation and costs{' '}
					<strong>fifteen days</strong> of no trading and no Market. A transfer carries a much
					shorter restriction. Leave the phone exactly as it is and use this screen instead.
				</p>
			</div>

			<div className="ceremony">
				<h2>Before you start</h2>
				<p className="hint">
					You need the account&rsquo;s password, the code currently showing in the Steam mobile app,
					and later a code Steam texts to the number on the account.
				</p>
				<p className="hint">
					Signing in below changes nothing on the Steam account. You can stop at any point up to the
					texted code and your phone will carry on working.
				</p>
			</div>

			<form onSubmit={(event) => void submit(event)}>
				<label htmlFor="move-account">Steam account name</label>
				<input
					id="move-account"
					type="text"
					value={accountName}
					onChange={(event) => setAccountName(event.target.value)}
					autoComplete="off"
					spellCheck={false}
				/>

				<label htmlFor="move-password">Steam password</label>
				<input
					id="move-password"
					type="password"
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					autoComplete="off"
				/>
				<p className="hint">
					Used once, to sign in, and never stored. What is kept is the session Steam gives back.
				</p>

				<label htmlFor="move-code">Steam Guard code, from the Steam mobile app</label>
				<input
					id="move-code"
					type="text"
					value={code}
					onChange={(event) => setCode(event.target.value)}
					autoComplete="off"
					spellCheck={false}
					maxLength={16}
				/>
				<p className="hint">
					The five characters currently showing on the phone. This is what proves you hold the
					authenticator being moved.
				</p>

				<label htmlFor="move-proxy">Route this account through a proxy (optional)</label>
				<input
					id="move-proxy"
					type="text"
					value={proxyUrl}
					onChange={(event) => setProxyUrl(event.target.value)}
					autoComplete="off"
					spellCheck={false}
					placeholder="socks5://user:pass@host:1080"
				/>
				<p className="hint">
					HTTP, HTTPS, SOCKS4 and SOCKS5 are all accepted — the example is only an example. Leave it
					empty to connect directly.
				</p>

				{error ? <p className="error">{error}</p> : undefined}

				<div className="controls">
					<button type="submit" disabled={busy}>
						{busy ? 'Signing in…' : 'Sign in'}
					</button>
					<button type="button" className="secondary" onClick={onClose} disabled={busy}>
						Cancel
					</button>
				</div>
			</form>
		</main>
	);
}
