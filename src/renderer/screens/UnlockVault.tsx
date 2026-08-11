import { useState } from 'react';
import { messageOf } from '../ipc-message';

/**
 * The unlock screen.
 *
 * This document is always freshly loaded: the main process reloads the renderer
 * whenever the vault locks, so a passphrase is never typed into a page that has
 * previously rendered Steam content. That is what keeps a renderer compromise
 * bounded to one session instead of yielding the vault key material.
 */
export function UnlockVault({
	onUnlock,
	onRestoreBackup,
	backupAvailable
}: {
	onUnlock: (passphrase: string) => Promise<void>;
	/** Replace the vault with its backup and unlock that instead. */
	onRestoreBackup: (passphrase: string) => Promise<void>;
	backupAvailable: boolean;
}): React.JSX.Element {
	const [passphrase, setPassphrase] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	/** Whether the user has asked to see the restore option at all. */
	const [restoring, setRestoring] = useState(false);

	async function submit(event: React.FormEvent): Promise<void> {
		event.preventDefault();
		if (!passphrase || busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			await onUnlock(passphrase);
			setPassphrase('');
		} catch (err) {
			// The message from the main process deliberately does not distinguish a
			// wrong passphrase from a damaged file; only Electron's IPC wrapper is
			// stripped so the user sees that reason rather than a channel name.
			setError(messageOf(err));
			setPassphrase('');
			setBusy(false);
		}
	}

	return (
		<main className="shell">
			<h1>Unlock</h1>

			{/* Hidden while the restore form is up. Both bind the same passphrase
			    state — deliberately, since it is usually the same passphrase — and two
			    visible password fields mirroring each other's keystrokes reads as a
			    bug rather than as a convenience. Showing one at a time also makes it
			    a choice between two actions, which is what it is. */}
			{!restoring && (
				<form
					onSubmit={(event) => {
						void submit(event);
					}}
				>
					<label htmlFor="passphrase">Passphrase</label>
					<input
						id="passphrase"
						type="password"
						autoComplete="current-password"
						spellCheck={false}
						autoFocus
						value={passphrase}
						onChange={(e) => setPassphrase(e.target.value)}
						disabled={busy}
					/>

					{error && <p className="error">{error}</p>}

					<button type="submit" disabled={!passphrase || busy}>
						{busy ? 'Unlocking…' : 'Unlock'}
					</button>
					{busy && <p className="muted">Deriving the key — this takes a moment by design.</p>}
				</form>
			)}

			{/* The error belongs outside the form now, so a failed restore reports
			    itself too rather than vanishing with the form that raised it. */}
			{restoring && error && <p className="error">{error}</p>}

			{backupAvailable && (
				<>
					<p className="hint">
						A backup of the previous vault is on disk. It is never loaded automatically, because
						doing so could quietly restore accounts you removed.
					</p>

					{/* The sentence above has always been here; the way to act on it has
					    not. "Never loaded automatically" reads as "load it yourself when
					    you need to", and there was no way to — so a vault file that would
					    not parse locked the user out of every account they had, with a
					    good copy sitting beside it saying so. */}
					{!restoring ? (
						<div className="controls">
							<button type="button" className="secondary" onClick={() => setRestoring(true)}>
								Use the backup instead
							</button>
						</div>
					) : (
						<form
							onSubmit={(event) => {
								event.preventDefault();
								if (!passphrase || busy) {
									return;
								}
								setBusy(true);
								setError(undefined);
								onRestoreBackup(passphrase)
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
							/>
							<p className="hint">
								The backup becomes your vault. Anything changed since it was written — accounts
								added, settings altered — is not in it. The file being replaced is kept on disk
								rather than deleted, renamed with a <code>superseded</code> suffix.
							</p>
							<p className="hint">
								Usually the same passphrase. If you have changed it since the backup was written,
								the backup still uses the old one.
							</p>

							<div className="controls">
								<button type="submit" disabled={busy || passphrase === ''}>
									{busy ? 'Restoring…' : 'Restore the backup and unlock'}
								</button>
								<button
									type="button"
									className="secondary"
									onClick={() => {
										setRestoring(false);
										setError(undefined);
									}}
									disabled={busy}
								>
									Cancel
								</button>
							</div>
						</form>
					)}
				</>
			)}
		</main>
	);
}
