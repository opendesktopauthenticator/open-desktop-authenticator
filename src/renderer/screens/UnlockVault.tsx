import { useState } from 'react';
import { Logo } from '../Logo';
import { branding } from '../../shared/branding';
import { messageOf } from '../ipc-message';
import { BackupRestore } from './BackupRestore';

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
		<main className="shell gate solo">
			{/* The first thing anyone sees, every single time the app is opened. It
			    was a form in the top-left corner of an otherwise empty window; it is
			    the one screen that should feel like arriving somewhere. */}
			<div className="gate-hero">
				<Logo size={72} drawIn />
				<p className="wordmark">{branding.productName}</p>
			</div>

			<h1>Unlock</h1>

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

				<div className="controls">
					<button type="submit" disabled={!passphrase || busy}>
						{busy ? 'Unlocking…' : 'Unlock'}
					</button>
				</div>
				{busy && <p className="muted">Deriving the key — this takes a moment by design.</p>}
			</form>

			{backupAvailable && (
				<BackupRestore
					onRestore={onRestoreBackup}
					introduction="A backup of the previous vault is on disk. It is never loaded automatically, because doing so could quietly restore accounts you removed."
				/>
			)}
		</main>
	);
}
