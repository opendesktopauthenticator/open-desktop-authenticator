import { useState } from 'react';
import type {
	TransferAuthenticated,
	TransferComplete,
	TransferStartChallenge
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
			setPassword('');
			setCode('');
		} catch (err) {
			setError(messageOf(err));
		} finally {
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
		setCommitted(true);
		try {
			setDone(await onComplete(smsCode));
			setSmsCode('');
		} catch (err) {
			setError(messageOf(err));
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
			setDone(await onRetryPersist());
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
	if (done) {
		return (
			<section>
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
			</section>
		);
	}

	if (authenticated) {
		return (
			<section>
				<h1>Signed in to {authenticated.accountName}</h1>
				<p className="lede">
					Nothing on the Steam account has changed yet, and the authenticator on your phone is still
					the one in charge.
				</p>

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
						<p className="hint">
							Submitting that code is not built yet, so nothing further will happen to this account.
							The authenticator on your phone is still the one in charge.
						</p>
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
					{committed && error ? (
						<button type="button" disabled={busy} onClick={() => void retrySave()}>
							Try saving again
						</button>
					) : undefined}
					{committed ? undefined : (
						<button
							type="button"
							className="secondary"
							onClick={() => {
								void onCancel();
								onClose();
							}}
						>
							Close
						</button>
					)}
				</div>
			</section>
		);
	}

	return (
		<section>
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
					placeholder="socks5://user:pass@host:port"
				/>

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
		</section>
	);
}
