import { useState } from 'react';
import { messageOf } from '../ipc-message';

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
	onCancel
}: {
	accountName: string;
	/** Why the sign-in is being asked for, in Steam's own terms. */
	reason?: string;
	onSignIn: (password: string) => Promise<unknown>;
	onCancel: () => void;
}): React.JSX.Element {
	const [password, setPassword] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const submit = (event: React.FormEvent): void => {
		event.preventDefault();
		if (busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		onSignIn(password)
			.then(() => {
				// Cleared on the way out rather than left in a state object for the
				// lifetime of the screen.
				setPassword('');
			})
			.catch((err: unknown) => setError(messageOf(err)))
			.finally(() => setBusy(false));
	};

	return (
		<>
			<div className="ceremony">
				<h2>Steam needs you to sign in</h2>
				<p>{reason ?? `There is no saved Steam session for ${accountName}.`}</p>
				<p>
					This happens once. Afterwards the app keeps a session that lasts months and renews itself,
					and you will not be asked again unless it expires or you change this account&rsquo;s
					routing.
				</p>
			</div>

			{error && <p className="error">{error}</p>}

			<form onSubmit={submit}>
				<label htmlFor="steam-password">Steam password for {accountName}</label>
				<input
					id="steam-password"
					type="password"
					value={password}
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
		</>
	);
}
