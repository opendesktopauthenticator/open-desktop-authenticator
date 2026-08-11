import { useState } from 'react';
import { messageOf } from '../ipc-message';

/**
 * Loading the vault's `.bak` deliberately (§12 F1).
 *
 * ## Why this is a component rather than markup in one screen
 *
 * It belongs on **two** screens, and they are reached by opposite routes.
 * `UnlockVault` shows it when the vault will not open. `CreateVault` shows it
 * when there is no vault file at all — and that second case was missed entirely:
 * a lost or moved `vault.json` with a perfectly good backup beside it produced
 * the "create a vault" screen, which offered no way to load it.
 *
 * That is worse than an inconvenience. Creating a fresh vault writes a new
 * `vault.json`, and the *second* save after that copies it over `vault.json.bak`
 * — so following the only route the app offered would destroy the backup that
 * still held every account.
 *
 * Written once because two copies of a restore form would drift, and this
 * codebase has already produced that bug twice in a week.
 */
export function BackupRestore({
	onRestore,
	introduction
}: {
	onRestore: (passphrase: string) => Promise<void>;
	/** What the surrounding screen has already told the user about the backup. */
	introduction: string;
}): React.JSX.Element {
	const [open, setOpen] = useState(false);
	const [passphrase, setPassphrase] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	if (!open) {
		return (
			<>
				<p className="hint">{introduction}</p>
				<div className="controls">
					<button type="button" className="secondary" onClick={() => setOpen(true)}>
						Use the backup instead
					</button>
				</div>
			</>
		);
	}

	return (
		<>
			{/* **Still shown.** This used to be replaced by the form, so the sentence
			    explaining what a backup is disappeared at the exact moment the user
			    was about to load one. */}
			<p className="hint">{introduction}</p>

			{error && <p className="error">{error}</p>}

			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (!passphrase || busy) {
						return;
					}
					setBusy(true);
					setError(undefined);
					onRestore(passphrase)
						.then(() => setPassphrase(''))
						.catch((err: unknown) => {
							setError(messageOf(err));
							setPassphrase('');
							setBusy(false);
						});
				}}
			>
				<label htmlFor="restore-passphrase">Passphrase for the backup</label>
				<input
					id="restore-passphrase"
					type="password"
					value={passphrase}
					onChange={(event) => setPassphrase(event.target.value)}
					autoComplete="off"
					spellCheck={false}
					disabled={busy}
					autoFocus
				/>
				{/* **Both directions, because the second one surprises people.** The
				    copy used to say only that later changes are missing, which reads as
				    "you might lose something". The other half is that a backup written
				    before a removal still contains what you removed, so restoring it
				    brings those accounts back — found by a founder who removed an
				    account, restored, and watched it reappear. */}
				<p className="hint">
					The backup replaces your vault with how it was when it was written. Accounts you have
					<strong> added</strong> since then will be gone, and accounts you have
					<strong> removed</strong> since then will come back.
				</p>
				<p className="hint">
					If a vault file is being replaced it is kept on disk rather than deleted, renamed with a{' '}
					<code>superseded</code> suffix.
				</p>
				<p className="hint">
					Usually the same passphrase. If you have changed it since the backup was written, the
					backup still uses the old one.
				</p>

				<div className="controls">
					<button type="submit" disabled={busy || passphrase === ''}>
						{busy ? 'Restoring…' : 'Restore the backup and unlock'}
					</button>
					<button
						type="button"
						className="secondary"
						onClick={() => {
							setOpen(false);
							setError(undefined);
						}}
						disabled={busy}
					>
						Cancel
					</button>
				</div>
			</form>
		</>
	);
}
