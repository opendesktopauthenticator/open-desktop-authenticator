import { useState } from 'react';
import { messageOf } from '../ipc-message';

/**
 * The forced revocation-code backup ceremony (§11 S12).
 *
 * A revocation code is the only way to remove an authenticator without Steam
 * Support. It arrives once, inside a maFile, and if the vault is lost with the
 * code unrecorded the account is stuck behind a support queue.
 *
 * So the ceremony is deliberately three steps rather than a line of text:
 *
 *  1. **Prove you are here.** The passphrase is required again even though the
 *     vault is unlocked — unlocked means the machine was used recently, not that
 *     its owner is at it, and this is the one screen that puts a permanent
 *     credential in front of whoever is looking.
 *  2. **Show the code once**, on its own, with nothing else to read.
 *  3. **Ask for a deliberate confirmation**, which is what finally clears the
 *     account's warning.
 *
 * The code is held in component state and dies with the screen. The main process
 * reloads this window whenever the vault locks, so it cannot outlive a session.
 */
export function RevocationBackup({
	accountName,
	steamId64,
	onReveal,
	onConfirm,
	onClose
}: {
	accountName: string;
	steamId64: string;
	onReveal: (passphrase: string) => Promise<{ revocationCode: string }>;
	onConfirm: () => Promise<unknown>;
	onClose: () => void;
}): React.JSX.Element {
	const [passphrase, setPassphrase] = useState('');
	const [code, setCode] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const reveal = (event: React.FormEvent): void => {
		event.preventDefault();
		if (busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		onReveal(passphrase)
			.then((result) => {
				setCode(result.revocationCode);
				// The passphrase has done its job; there is no reason for the input to
				// keep holding it.
				setPassphrase('');
			})
			.catch((err: unknown) => setError(messageOf(err)))
			.finally(() => setBusy(false));
	};

	const confirm = (): void => {
		if (busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		onConfirm()
			.then(() => onClose())
			.catch((err: unknown) => setError(messageOf(err)))
			.finally(() => setBusy(false));
	};

	return (
		<main className="shell">
			<header className="row">
				<h1>Back up the recovery code</h1>
				<button type="button" className="secondary" onClick={onClose} disabled={busy}>
					Later
				</button>
			</header>

			<p className="muted">
				{accountName} <span className="muted">{steamId64}</span>
			</p>

			{error && <p className="error">{error}</p>}

			{code === undefined ? (
				<>
					<div className="ceremony">
						<h2>This code is the only way back</h2>
						<p>
							If you lose this vault and you do not have this code, removing the authenticator means
							going through Steam Support. There is no other route.
						</p>
						<p>Write it on paper. Not in this app, not in a note synced to a phone.</p>
					</div>

					<form onSubmit={reveal}>
						<label htmlFor="ceremony-passphrase">Confirm your vault passphrase</label>
						<input
							id="ceremony-passphrase"
							type="password"
							value={passphrase}
							onChange={(event) => setPassphrase(event.target.value)}
							autoComplete="off"
							autoFocus
							disabled={busy}
						/>
						<p className="hint">
							Asked again on purpose. Being unlocked means this machine was used recently, not that
							you are the one at it.
						</p>
						<div className="controls">
							<button type="submit" disabled={busy || passphrase.length === 0}>
								{busy ? 'Checking…' : 'Show the code'}
							</button>
						</div>
					</form>
				</>
			) : (
				<>
					<div className="ceremony">
						<h2>Write this down now</h2>
						<p className="revocation">{code}</p>
						<p>
							It will not be shown again unless you come back here and enter your passphrase again.
						</p>
					</div>

					<div className="controls">
						<button type="button" onClick={confirm} disabled={busy}>
							{busy ? 'Saving…' : 'I have written it down'}
						</button>
						<button type="button" className="secondary" onClick={onClose} disabled={busy}>
							Not yet
						</button>
					</div>
				</>
			)}
		</main>
	);
}
