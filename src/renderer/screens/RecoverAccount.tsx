import { useState } from 'react';
import type { RecoverResult } from '../../shared/ipc';
import { messageOf } from '../ipc-message';

/**
 * Restoring an account from its recovery file (§12 F2).
 *
 * ## Why this screen had to exist
 *
 * The main process could already do all of this — `account:recover` was written,
 * tested, and reachable over IPC — and **nothing in the interface called it.**
 * A recovery path that cannot be reached is not a recovery path; it is a file
 * the user was told to keep for an emergency and no way to spend it.
 *
 * It was worse than merely absent. The enrollment failure message says, in the
 * one situation this exists for, "unlock the vault and use Recover from file to
 * finish" — an instruction naming a control that did not exist anywhere.
 *
 * ## The passphrase is the one the vault had *then*
 *
 * Not necessarily the current one. Recovery files are sealed when the account is
 * created and are never rewritten, so changing the vault passphrase afterwards
 * leaves them on the old one. "My passphrase is right and it says it is wrong"
 * is otherwise a very bad few minutes to have while recovering an account, so
 * the screen says so before the attempt rather than in the error afterwards.
 */
export function RecoverAccount({
	onRecover,
	onClose
}: {
	onRecover: (passphrase: string) => Promise<RecoverResult>;
	onClose: () => void;
}): React.JSX.Element {
	const [passphrase, setPassphrase] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [result, setResult] = useState<RecoverResult | undefined>();

	const submit = (event: React.FormEvent): void => {
		event.preventDefault();
		if (busy || passphrase === '') {
			return;
		}
		setBusy(true);
		setError(undefined);
		setResult(undefined);
		onRecover(passphrase)
			.then((outcome) => {
				setResult(outcome);
				// Cleared whatever happened. A passphrase left in the field after a
				// failure invites pressing the button again unchanged, and one left
				// after a success has no reason to stay in renderer memory.
				setPassphrase('');
			})
			.catch((err: unknown) => {
				setError(messageOf(err));
				setPassphrase('');
			})
			.finally(() => setBusy(false));
	};

	return (
		<main className="shell">
			<header className="row">
				<h1>Recover an account</h1>
				<button type="button" className="secondary" onClick={onClose} disabled={busy}>
					Back
				</button>
			</header>

			<p className="muted">
				This app writes an encrypted recovery file the moment an authenticator is created, and keeps
				it even if the account is later removed. If you removed an account and did not write its
				revocation code down, this is how you get it back.
			</p>

			{error && <p className="error">{error}</p>}

			{result?.state === 'restored' && (
				<div className="ceremony">
					<h2>{result.accountName} is back</h2>
					<p>
						The account and its secrets are in the vault again. Its Steam Guard code should appear
						on the accounts list.
					</p>
				</div>
			)}

			{result?.state === 'alreadyPresent' && (
				<p className="hint">
					{result.accountName} is already in this vault, so nothing was changed. That file was not
					needed.
				</p>
			)}

			{/* Cancelling the OS dialog is not a failure and must not read as one —
			    silence here would be indistinguishable from the button not working. */}
			{result?.state === 'cancelled' && (
				<p className="hint">No file was chosen. Nothing changed.</p>
			)}

			<form onSubmit={submit}>
				<label htmlFor="recover-passphrase">Vault passphrase</label>
				<input
					id="recover-passphrase"
					type="password"
					value={passphrase}
					onChange={(event) => setPassphrase(event.target.value)}
					autoComplete="off"
					spellCheck={false}
					disabled={busy}
				/>
				<p className="hint">
					The vault passphrase that was in use <strong>when this file was last written</strong> —
					usually your current one. Finishing an account&rsquo;s activation rewrites its recovery
					file, so a file is not always sealed with the passphrase you had when the account was
					first set up. If your current one is refused and you have changed it since, try the
					previous one.
				</p>

				<div className="controls">
					<button type="submit" disabled={busy || passphrase === ''}>
						{busy ? 'Working…' : 'Choose a recovery file…'}
					</button>
				</div>
			</form>
		</main>
	);
}
