import { useState } from 'react';
import {
	canCreateVault,
	MIN_PASSPHRASE_LENGTH,
	passphraseStrength,
	STRENGTH_ADVICE
} from '../../shared/passphrase-policy';
import { messageOf } from '../ipc-message';

/**
 * Vault creation, including the "there is no recovery" ceremony (§10.3).
 *
 * The acknowledgement is a deliberate piece of friction. Every other product
 * this user has met offers a password reset, so the absence of one is the single
 * most surprising fact about this app — and the moment they find out must not be
 * the moment they need it.
 */
export function CreateVault({
	onCreate
}: {
	onCreate: (passphrase: string) => Promise<void>;
}): React.JSX.Element {
	const [passphrase, setPassphrase] = useState('');
	const [confirmation, setConfirmation] = useState('');
	const [acknowledged, setAcknowledged] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

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
		try {
			await onCreate(passphrase);
			// Drop both copies as soon as they are no longer needed. This cannot
			// erase them — JavaScript strings are immutable and live until GC — but
			// it keeps them out of component state and out of the DOM.
			setPassphrase('');
			setConfirmation('');
		} catch (err) {
			setError(messageOf(err));
			setBusy(false);
		}
	}

	const strength = passphraseStrength(passphrase);

	return (
		<main className="shell">
			<h1>Create your vault</h1>
			<p className="muted">
				One passphrase protects every account you add. It never leaves this machine.
			</p>

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

				{error && <p className="error">{error}</p>}

				<button type="submit" disabled={!ready || busy}>
					{busy ? 'Creating…' : 'Create vault'}
				</button>
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
