import { useState } from 'react';
import type { SignInResult } from '../../shared/ipc';
import { messageOf } from '../ipc-message';
import { DynamicError } from '../DynamicError';

/**
 * Signing in to Steam, once (§12 F3).
 *
 * The Steam Guard code is not asked for — this application generates it. The
 * password is, and it is the only thing the user has to supply, once.
 *
 * **The password is not stored.** It is sent to the main process, used to obtain
 * a session that lasts months, and dropped. That is not a limitation to
 * apologise for: after this, the saved session does everything the password
 * would, and it can be revoked from Steam without changing anything. A password
 * kept next to a shared secret is the one combination that turns a stolen vault
 * into a stolen account.
 */
export function SteamSignIn({
	accountName,
	reason,
	onSignIn,
	onSignedIn,
	onCancel
}: {
	accountName: string;
	/** Why the sign-in is being asked for, in Steam's own terms. */
	reason?: string;
	/**
	 * Returns the outcome rather than throwing it.
	 *
	 * A sign-in can fail in a way no second attempt can fix — Steam wanting the
	 * approval on the device that holds the authenticator, or an account using
	 * emailed codes this app cannot answer. `retryable: false` says so, and the
	 * form withdraws instead of inviting another password.
	 */
	onSignIn: (password: string) => Promise<SignInResult>;
	/** Runs only after Steam has accepted and saved the sign-in. */
	onSignedIn?: () => void;
	onCancel: () => void;
}): React.JSX.Element {
	const [password, setPassword] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	/** Set when Steam has said something no further attempt can change. */
	const [hopeless, setHopeless] = useState<string | undefined>();

	const submit = (event: React.FormEvent): void => {
		event.preventDefault();
		if (busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		onSignIn(password)
			.then((result) => {
				// Cleared on the way out rather than left in a state object for the
				// lifetime of the screen — whatever the outcome was.
				setPassword('');
				if (result.ok) {
					onSignedIn?.();
					return;
				}
				if (result.retryable) {
					setError(result.reason);
				} else {
					setHopeless(result.reason);
				}
			})
			.catch((err: unknown) => {
				// **Cleared here too.** The comment above says "whatever the outcome",
				// and a throw — an IPC failure, a schema refusal, a dead transport — is
				// an outcome: without this the password stayed in component state, and
				// in the DOM, until the next success or unmount.
				setPassword('');
				setError(messageOf(err));
			})
			.finally(() => setBusy(false));
	};

	return (
		<>
			<div className="ceremony">
				{/* The reassurance is only true while signing in here is still possible.
				    Left in place above a message saying it cannot work, "this happens
				    once and you will not be asked again" reads as the app contradicting
				    itself at the moment the user most needs to believe it. */}
				{hopeless === undefined ? (
					<>
						<h2>Steam needs you to sign in</h2>
						<p>{reason ?? `There is no saved Steam session for ${accountName}.`}</p>
						<p>
							This happens once. Afterwards the app keeps a session that lasts months and renews
							itself, and you will not be asked again unless it expires or you change this
							account&rsquo;s routing.
						</p>
					</>
				) : (
					<>
						<h2>This sign-in cannot be completed here</h2>
						<p>Steam will not accept a password for {accountName} from this app right now.</p>
					</>
				)}
			</div>

			{error && <DynamicError id="steam-sign-in-error">{error}</DynamicError>}

			{/* The form withdraws entirely. Steam has said something a password
			    cannot answer — the sign-in must be approved on the device holding the
			    authenticator, or the account uses emailed codes this app cannot
			    complete — and leaving the box on screen invites attempts that are
			    guaranteed to fail. `permanent` was classified for exactly this and
			    then discarded on the way to the renderer, so every failure looked
			    alike. */}
			{hopeless !== undefined ? (
				<>
					<DynamicError>{hopeless}</DynamicError>
					<p className="hint">
						Another password attempt will not change this. Deal with it on Steam&rsquo;s side, then
						come back.
					</p>
					<div className="controls">
						<button type="button" className="secondary" onClick={onCancel}>
							Back
						</button>
					</div>
				</>
			) : (
				<form onSubmit={submit}>
					<label htmlFor="steam-password">Steam password for {accountName}</label>
					<input
						id="steam-password"
						aria-invalid={error !== undefined}
						aria-describedby={error === undefined ? undefined : 'steam-sign-in-error'}
						type="password"
						value={password}
						disabled={busy}
						onChange={(event) => setPassword(event.target.value)}
						autoComplete="off"
						spellCheck={false}
						autoFocus
					/>
					<p className="hint">
						Not saved. It is used to get a session and then discarded — the Steam Guard code is
						generated here, so there is nothing else to enter.
					</p>

					<div className="controls">
						<button type="submit" disabled={busy || password === ''}>
							{busy ? 'Signing in…' : 'Sign in'}
						</button>
						<button type="button" className="secondary" onClick={onCancel} disabled={busy}>
							Not now
						</button>
					</div>
				</form>
			)}
		</>
	);
}
