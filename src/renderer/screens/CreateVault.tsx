import { useState } from 'react';
import { Logo } from '../Logo';
import { branding } from '../../shared/branding';
import {
	canCreateVault,
	MIN_PASSPHRASE_LENGTH,
	passphraseStrength,
	STRENGTH_ADVICE
} from '../../shared/passphrase-policy';
import type { AdoptResult } from '../../shared/ipc';
import { messageOf } from '../ipc-message';
import { DynamicError } from '../DynamicError';
import { BackupRestore } from './BackupRestore';

/**
 * Vault creation, including the "there is no recovery" ceremony (§10.3).
 *
 * The acknowledgement is a deliberate piece of friction. Every other product
 * this user has met offers a password reset, so the absence of one is the single
 * most surprising fact about this app — and the moment they find out must not be
 * the moment they need it.
 */
export function CreateVault({
	onCreate,
	backupAvailable,
	onRestoreBackup,
	onAdopt
}: {
	onCreate: (passphrase: string) => Promise<void>;
	/** True when a `vault.json.bak` is on disk even though the vault itself is gone. */
	backupAvailable: boolean;
	onRestoreBackup: (passphrase: string) => Promise<void>;
	/** Opens and authenticates a vault file the user has elsewhere. */
	onAdopt: (passphrase: string) => Promise<AdoptResult>;
}): React.JSX.Element {
	const [passphrase, setPassphrase] = useState('');
	const [confirmation, setConfirmation] = useState('');
	const [acknowledged, setAcknowledged] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	/** Set when a vault file was offered and the picker was closed without one. */
	const [adoptNote, setAdoptNote] = useState<string | undefined>();
	/**
	 * Kept apart from `error`, which renders beside the create form far below.
	 *
	 * Sharing it meant clicking "Load a vault file" and having the reason it failed
	 * appear off the bottom of the screen — indistinguishable from the button doing
	 * nothing at all, which is how it was reported.
	 */
	const [adoptError, setAdoptError] = useState<string | undefined>();
	const [adoptPassphrase, setAdoptPassphrase] = useState('');

	const mismatch = confirmation.length > 0 && confirmation !== passphrase;
	// One shared gate, so the button's disabled state and the submit guard can
	// never disagree about whether creation is allowed.
	const ready = canCreateVault({ passphrase, confirmation, acknowledged });

	async function submit(event: React.FormEvent): Promise<void> {
		event.preventDefault();
		if (!ready || busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		let releaseAfterFailure = false;
		try {
			await onCreate(passphrase);
		} catch (err) {
			setError(messageOf(err));
			releaseAfterFailure = true;
		} finally {
			// Both inputs are frozen while this attempt owns them, so these are the
			// submitted copies rather than newer user edits. Drop them after either
			// outcome. JavaScript strings cannot be wiped in place, but they no
			// longer need to remain in component state or the DOM.
			setPassphrase('');
			setConfirmation('');
			if (releaseAfterFailure) setBusy(false);
		}
	}

	const strength = passphraseStrength(passphrase);

	return (
		<main className="shell gate">
			{/* Same gate as the unlock screen: this is the other way in, and the two
			    should not look like different applications. */}
			<div className="gate-hero">
				<Logo size={72} drawIn />
				<p className="wordmark">{branding.productName}</p>
			</div>

			<h1>Create your vault</h1>
			<p className="muted">
				One passphrase protects every account you add. It never leaves this machine.
			</p>

			{/* **The reason this screen can be reached with accounts still on disk.**
			    `vault.json` going missing — moved, deleted, or a restore that failed
			    partway — shows "create a vault" while `vault.json.bak` still holds
			    every account. Following the only route offered would write a fresh
			    vault, and the second save after that copies it over the backup: the
			    app would talk the user through destroying what it could have given
			    back. */}
			{backupAvailable && (
				<div className="ceremony">
					<h2>There is a backup here</h2>
					<p>
						This machine has no vault file, but it does have a backup of one. If you have used this
						app before, that backup is your accounts —{' '}
						<strong>do not create a new vault before restoring it</strong>, because creating one
						will eventually overwrite the backup.
					</p>
					<BackupRestore
						onRestore={onRestoreBackup}
						// **The same busy flag as Create.** The two forms are on one
						// screen and both end in a deliberate second of scrypt, so with
						// separate flags a user could submit the restore and then press
						// Create — and whichever KDF finished first won. Create winning
						// installs an empty vault, and its next save copies that over the
						// `.bak` the restore was reading: the backup this screen exists to
						// protect, destroyed by the screen that warned about it.
						onBusy={setBusy}
						// **And back the other way.** `onBusy` alone was one-directional:
						// this form could tell the screen it was busy, and nothing told
						// *it* that Create was already running. Both end in a second of
						// scrypt, so without this a user could start a create and then
						// submit a restore — and a winning create leaves an empty vault
						// whose next save copies itself over the backup.
						siblingBusy={busy}
						introduction="Restoring it makes it your vault, exactly as it was when it was written."
					/>
				</div>
			)}

			{/* **A vault file is not always in the place this app looks.** Somebody
			    moving machines, restoring from their own copy, or recovering after
			    both the vault and its backup were lost has the file in hand and no way
			    to hand it over — the only route was knowing the data directory and the
			    filename and putting it there by hand. */}
			<div className="ceremony">
				<h2>Already have a vault?</h2>
				<p>
					If you have used this app before and kept a copy of your <code>vault.json</code>, load it
					here rather than starting again. It is only offered because this machine has none — it can
					never replace a vault you already have.
				</p>
				{adoptError && <DynamicError id="adopt-vault-error">{adoptError}</DynamicError>}
				{adoptNote && <p className="hint">{adoptNote}</p>}
				<label htmlFor="adopt-passphrase">Existing vault passphrase</label>
				<input
					id="adopt-passphrase"
					aria-invalid={adoptError !== undefined}
					aria-describedby={adoptError === undefined ? undefined : 'adopt-vault-error'}
					type="password"
					autoComplete="current-password"
					spellCheck={false}
					value={adoptPassphrase}
					onChange={(event) => setAdoptPassphrase(event.target.value)}
					disabled={busy}
				/>
				<p className="hint">
					The file is opened and checked locally before it is installed. The passphrase never leaves
					this machine.
				</p>
				<div className="controls">
					<button
						type="button"
						className="secondary"
						disabled={busy || adoptPassphrase.length === 0}
						onClick={() => {
							const submittedPassphrase = adoptPassphrase;
							setAdoptError(undefined);
							setAdoptNote(undefined);
							setBusy(true);
							let attempt: Promise<AdoptResult>;
							try {
								attempt = onAdopt(submittedPassphrase);
							} catch (err) {
								attempt = Promise.reject(err instanceof Error ? err : new Error(messageOf(err)));
							}
							void attempt
								.then((result) => {
									// Cancelling the picker is not a failure and must not read as
									// one; silence is indistinguishable from a dead button.
									if (result.state === 'cancelled') {
										setAdoptNote('No file was chosen. Nothing changed.');
									}
								})
								.catch((err: unknown) => setAdoptError(messageOf(err)))
								.finally(() => {
									setAdoptPassphrase('');
									setBusy(false);
								});
						}}
					>
						Load a vault file…
					</button>
				</div>
			</div>

			<div className="ceremony">
				<h2>There is no recovery</h2>
				<p>
					We cannot reset this passphrase, and neither can anyone else. There is no email link, no
					support route, and no back door — that is what makes the vault worth trusting.
				</p>
				<p>
					<strong>
						If you forget it, every authenticator stored here is gone and each account has to be
						recovered through Steam Support.
					</strong>
				</p>
				<p>Write it down and keep it somewhere physical before you continue.</p>
			</div>

			<form
				onSubmit={(event) => {
					void submit(event);
				}}
			>
				<label htmlFor="passphrase">Passphrase</label>
				<input
					id="passphrase"
					aria-invalid={error !== undefined}
					aria-describedby={error === undefined ? undefined : 'create-vault-error'}
					type="password"
					autoComplete="new-password"
					spellCheck={false}
					value={passphrase}
					onChange={(e) => setPassphrase(e.target.value)}
					disabled={busy}
				/>
				<p className={`hint ${strength === 'tooShort' ? 'bad' : 'ok'}`}>
					{passphrase.length === 0
						? `At least ${MIN_PASSPHRASE_LENGTH} characters. Several unrelated words beat one complicated one.`
						: `${passphrase.length} characters — ${STRENGTH_ADVICE[strength]}`}
				</p>

				<label htmlFor="confirmation">Type it again</label>
				<input
					id="confirmation"
					aria-invalid={error !== undefined || mismatch}
					aria-describedby={error === undefined ? undefined : 'create-vault-error'}
					type="password"
					autoComplete="new-password"
					spellCheck={false}
					value={confirmation}
					onChange={(e) => setConfirmation(e.target.value)}
					disabled={busy}
				/>
				{mismatch && <p className="hint bad">These do not match.</p>}

				<label className="checkbox">
					<input
						type="checkbox"
						checked={acknowledged}
						onChange={(e) => setAcknowledged(e.target.checked)}
						disabled={busy}
					/>
					<span>I have written down my passphrase and understand it cannot be recovered.</span>
				</label>

				{error && <DynamicError id="create-vault-error">{error}</DynamicError>}

				<div className="controls">
					<button type="submit" disabled={!ready || busy}>
						{busy ? 'Creating…' : 'Create vault'}
					</button>
				</div>
				{busy && (
					<p className="muted">
						Deriving the key. This is deliberately slow — it is what makes guessing your passphrase
						expensive.
					</p>
				)}
			</form>
		</main>
	);
}
