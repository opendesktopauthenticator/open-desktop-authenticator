import { useState } from 'react';
import type { AccountSummary } from '../../shared/ipc';
import { DEACTIVATE_ACK, matchesDeactivateAck } from '../../shared/acknowledgements';
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
	onDeactivate,
	onClose
}: {
	account: AccountSummary;
	onRemove: (passphrase: string) => Promise<unknown>;
	/**
	 * Detach the authenticator from Steam, then forget the account.
	 *
	 * Offered beside plain removal rather than on its own screen, because the two
	 * are constantly confused and the difference is the whole point: one leaves
	 * Steam demanding codes nobody can produce, the other leaves the account with
	 * no second factor at all. Putting them side by side is what makes the choice
	 * legible.
	 */
	onDeactivate: (passphrase: string, acknowledgement: string) => Promise<unknown>;
	onClose: () => void;
}): React.JSX.Element {
	const [passphrase, setPassphrase] = useState('');
	const [acknowledgement, setAcknowledgement] = useState('');
	/** Whether the user has opened the harder of the two options. */
	const [detaching, setDetaching] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const submit = (event: React.FormEvent): void => {
		event.preventDefault();
		if (busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		(detaching ? onDeactivate(passphrase, acknowledgement) : onRemove(passphrase))
			.then(() => {
				setPassphrase('');
				setAcknowledgement('');
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

			{/* The heading has to follow the action. With detaching on, this screen
			    does the exact opposite of what it said — and the block further down
			    already told the user so, leaving two contradictory statements on one
			    screen about the most destructive operation in the application. */}
			<div className="ceremony">
				{detaching ? (
					<>
						<h2>This removes Steam Guard from the account itself</h2>
						<p>
							Steam stops asking this account for codes at all. It is not just being forgotten here
							— the account is left with no second factor until you add one somewhere else.
						</p>
					</>
				) : (
					<>
						<h2>This does not remove the authenticator from Steam</h2>
						<p>
							Steam will keep asking this account for Steam Guard codes. After this, nothing on this
							machine can produce them.
						</p>
					</>
				)}
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

			{/* The other option, and deliberately not the default. Detaching is
			    strictly more destructive — it changes the Steam account, not just
			    this vault — so it is something a user opts into after reading, not a
			    button sitting at equal weight with the ordinary one. */}
			{account.hasRevocationCode && (
				<div className="ceremony">
					<h2>Or remove it from Steam as well</h2>
					<p>
						Using your revocation code, this app can tell Steam to drop the authenticator entirely.
						Steam stops asking this account for codes, and the account is left with{' '}
						<strong>no second factor</strong> until you add one elsewhere.
					</p>
					<p className="hint">
						This is what you want if you are moving the account to a phone, or retiring it. It is
						not what you want if you simply no longer wish to manage it here.
					</p>
					<label className="checkbox">
						<input
							type="checkbox"
							checked={detaching}
							onChange={(event) => setDetaching(event.target.checked)}
							disabled={busy}
						/>
						<span>Also remove the authenticator from Steam</span>
					</label>
				</div>
			)}

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

				{detaching && (
					<>
						<label htmlFor="remove-ack">
							Type <code>{DEACTIVATE_ACK}</code> to confirm
						</label>
						<input
							id="remove-ack"
							type="text"
							value={acknowledgement}
							onChange={(event) => setAcknowledgement(event.target.value)}
							autoComplete="off"
							spellCheck={false}
						/>
						<p className="hint bad">
							This leaves the Steam account with <strong>no second factor at all</strong> until you
							add one somewhere else. Do that immediately afterwards.
						</p>
					</>
				)}

				<div className="controls">
					{/* Detaching also needs the typed phrase. The main process enforces
					    it regardless, but a submit that looks available and then refuses
					    teaches the user the app is flaky rather than that the phrase
					    matters. */}
					<button
						type="submit"
						disabled={
							busy || passphrase === '' || (detaching && !matchesDeactivateAck(acknowledgement))
						}
					>
						{busy
							? detaching
								? 'Removing from Steam…'
								: 'Removing…'
							: detaching
								? `Remove Steam Guard from ${account.accountName}`
								: `Remove ${account.accountName} from this vault`}
					</button>
					<button type="button" className="secondary" onClick={onClose} disabled={busy}>
						Keep it
					</button>
				</div>
			</form>
		</main>
	);
}
