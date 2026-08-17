import { useState } from 'react';
import type { TransferAuthenticated } from '../../shared/ipc';
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
	onClose: () => void;
}): React.JSX.Element {
	const [accountName, setAccountName] = useState('');
	const [password, setPassword] = useState('');
	const [code, setCode] = useState('');
	const [proxyUrl, setProxyUrl] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [authenticated, setAuthenticated] = useState<TransferAuthenticated | undefined>(undefined);

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

	if (authenticated) {
		return (
			<section className="screen">
				<h1>Signed in to {authenticated.accountName}</h1>
				<p>
					Nothing on the Steam account has changed yet, and the authenticator on your phone is still
					the one in charge.
				</p>
				<div className="callout callout-warn">
					<h2>What happens next, and what it costs</h2>
					<ul>
						<li>
							Steam will text a code to the phone number on the account. Have it to hand — there is
							no way to finish without it.
						</li>
						<li>
							Submitting that code asks Steam to <strong>replace</strong> the authenticator. The one
							on your phone stops being the account&rsquo;s authenticator at that moment.
						</li>
						<li>
							Steam normally applies a short trading and Market restriction to a transfer. That is
							expected, and it is far shorter than the fifteen days a remove-and-add would cost.
						</li>
						<li>
							You will be given a new recovery code. Write it down before doing anything else — it
							is the only way back in if this machine is lost.
						</li>
					</ul>
				</div>
				<p className="hint">
					The step that sends the text is not built yet. Nothing further will happen to this account
					until it is.
				</p>
				<div className="controls">
					<button
						type="button"
						onClick={() => {
							void onCancel();
							onClose();
						}}
					>
						Close
					</button>
				</div>
			</section>
		);
	}

	return (
		<section className="screen">
			<h1>Move an authenticator from the Steam mobile app</h1>
			<p>
				This asks Steam to move the authenticator on your phone to this application. Steam replaces
				it: a new secret is issued here, and the one on the phone stops being the account&rsquo;s
				authenticator.
			</p>

			<div className="callout callout-warn">
				<h2>Do not remove the authenticator from your phone first</h2>
				<p>
					Removing it and adding a new one is a different operation and costs{' '}
					<strong>fifteen days</strong> of no trading and no Market. A transfer carries a much
					shorter restriction. Leave the phone exactly as it is and use this screen instead.
				</p>
			</div>

			<p>
				You will need the account&rsquo;s password, the current Steam Guard code from the phone, and
				later a code Steam texts to the number on the account.
			</p>

			<form onSubmit={(event) => void submit(event)}>
				<label>
					Account name
					<input
						value={accountName}
						onChange={(event) => setAccountName(event.target.value)}
						autoComplete="off"
						spellCheck={false}
						required
					/>
				</label>
				<label>
					Password
					<input
						type="password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						autoComplete="off"
						required
					/>
				</label>
				<label>
					Steam Guard code, from the Steam mobile app
					<input
						value={code}
						onChange={(event) => setCode(event.target.value)}
						autoComplete="off"
						spellCheck={false}
						maxLength={16}
						required
					/>
					<span className="hint">
						The five characters currently showing on the phone. This is what proves you hold the
						authenticator being moved.
					</span>
				</label>
				<label>
					Proxy for this account (optional)
					<input
						value={proxyUrl}
						onChange={(event) => setProxyUrl(event.target.value)}
						autoComplete="off"
						spellCheck={false}
						placeholder="socks5://user:pass@host:port"
					/>
				</label>

				{error ? <p className="field-error">{error}</p> : undefined}

				<p className="hint">
					Signing in changes nothing on the Steam account. You can stop here and your phone will
					carry on working.
				</p>

				<div className="controls">
					<button type="submit" disabled={busy}>
						{busy ? 'Signing in…' : 'Sign in'}
					</button>
					<button type="button" onClick={onClose} disabled={busy}>
						Cancel
					</button>
				</div>
			</form>
		</section>
	);
}
