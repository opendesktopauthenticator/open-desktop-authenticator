import { useState } from 'react';
import type { AccountSummary } from '../../shared/ipc';
import { messageOf } from '../ipc-message';

/**
 * Removing an account from the vault.
 *
 * The thing this screen exists to say, before anything else: **removing an
 * account here does not remove the authenticator from Steam.** Steam will keep
 * demanding codes that this app can no longer produce. Someone who deletes an
 * account without their revocation code has locked themselves out of a Steam
 * account and will not discover it until they next try to sign in.
 *
 * So the order is deliberate. The consequence comes first, the state of *this*
 * account's revocation code second — because that is what decides whether the
 * user is about to make a recoverable mistake or an unrecoverable one — and the
 * button last, behind the passphrase.
 *
 * Being unlocked is not enough to reach it. That is the same rule the revocation
 * reveal follows, applied to the one action that destroys rather than shows.
 */
export function RemoveAccount({
	account,
	onRemove,
	onClose
}: {
	account: AccountSummary;
	onRemove: (passphrase: string) => Promise<unknown>;
	onClose: () => void;
}): React.JSX.Element {
	const [passphrase, setPassphrase] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const submit = (event: React.FormEvent): void => {
		event.preventDefault();
		if (busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		onRemove(passphrase)
			.then(() => {
				setPassphrase('');
				onClose();
			})
			.catch((err: unknown) => setError(messageOf(err)))
			.finally(() => setBusy(false));
	};

	return (
		<main className="shell">
			<header className="row">
				<h1>Remove account</h1>
				{/* Disabled while the removal is in flight. Leaving mid-write does not
				    cancel it — the account is still deleted — and a dismiss control
				    that looks like an escape hatch and is not is worse than none. */}
				<button type="button" className="secondary" onClick={onClose} disabled={busy}>
					Cancel
				</button>
			</header>

			<p className="muted">
				{account.accountName} <span className="muted">{account.steamId64}</span>
			</p>

			{error && <p className="error">{error}</p>}

			<div className="ceremony">
				<h2>This does not remove the authenticator from Steam</h2>
				<p>
					Steam will keep asking this account for Steam Guard codes. After this, nothing on this
					machine can produce them.
				</p>
				{account.hasRevocationCode ? (
					<p>
						You have a revocation code on file for this account. Make sure you have written it down{' '}
						<strong>before</strong> continuing — it is the only way to remove the authenticator from
						Steam yourself, and it is deleted with everything else.
					</p>
				) : (
					<p>
						<strong>There is no revocation code for this account.</strong> If you remove it here,
						the only way back into the Steam account is Steam Support.
					</p>
				)}
			</div>

			<form onSubmit={submit}>
				<label htmlFor="remove-passphrase">Confirm your vault passphrase</label>
				<input
					id="remove-passphrase"
					type="password"
					value={passphrase}
					onChange={(event) => setPassphrase(event.target.value)}
					autoComplete="off"
				/>
				<p className="hint">
					Asked because being unlocked means this machine was used recently, not that you are the
					one at it.
				</p>

				<div className="controls">
					<button type="submit" disabled={busy || passphrase === ''}>
						{busy ? 'Removing…' : `Remove ${account.accountName} permanently`}
					</button>
					<button type="button" className="secondary" onClick={onClose} disabled={busy}>
						Keep it
					</button>
				</div>
			</form>
		</main>
	);
}
