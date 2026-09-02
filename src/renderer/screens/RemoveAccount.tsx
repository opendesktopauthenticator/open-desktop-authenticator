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
	onResolve,
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
	onDeactivate: (
		passphrase: string,
		acknowledgement: string
	) => Promise<{ state?: 'uncertain'; guidance?: string; certain?: boolean; persisted?: boolean }>;
	/**
	 * Clear the vault's record that an irreversible operation on this account was
	 * left unresolved. Called only when the user says they have checked it.
	 */
	onResolve: () => Promise<unknown>;
	onClose: () => void;
}): React.JSX.Element {
	const [passphrase, setPassphrase] = useState('');
	const [acknowledgement, setAcknowledgement] = useState('');
	/** Whether the user has opened the harder of the two options. */
	const [detaching, setDetaching] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	/** Steam was asked and did not answer. See the note in `submit`. */
	/*
	 * **Seeded from the account, not only from this session.**
	 *
	 * The refusal to repeat a removal whose outcome is unknown lived in this
	 * component's state, which lasts exactly as long as the component. Closing
	 * the screen, or restarting, offered the form again — after the application
	 * had said in as many words that it would not send the request a second time.
	 * The vault remembers it now, and this is where that record is read.
	 */
	const [uncertain, setUncertain] = useState<
		{ guidance: string; certain: boolean; persisted?: boolean } | undefined
	>(
		account.unresolvedOperation?.kind === 'deactivate'
			? {
					guidance: account.unresolvedOperation.guidance,
					certain: account.unresolvedOperation.certain === true,
					// Read from the account, so it is durable by construction.
					persisted: true
				}
			: undefined
	);
	const [resolving, setResolving] = useState(false);

	const submit = (event: React.FormEvent): void => {
		event.preventDefault();
		if (busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		(detaching ? onDeactivate(passphrase, acknowledgement) : onRemove(passphrase))
			.then((result: unknown) => {
				/*
				 * **A removal Steam may already have performed is not a failure to
				 * retry.** It used to arrive as a thrown error, which cleared `busy` and
				 * re-enabled the button that sends the detach again — while the message
				 * said not to. The form is replaced by the guidance instead.
				 */
				/*
				 * **The cast is what dropped it.** `certain` reached this function and
				 * was narrowed away one line before it was read, so a removal Steam is
				 * known to have performed rendered as one nobody can be sure about.
				 */
				const outcome = result as
					{ state?: string; guidance?: string; certain?: boolean; persisted?: boolean } | undefined;
				if (outcome?.state === 'uncertain') {
					setUncertain({
						guidance: outcome.guidance ?? 'Steam did not answer, so the outcome is unknown.',
						certain: outcome.certain === true,
						persisted: outcome.persisted === true
					});
					return;
				}
				setPassphrase('');
				setAcknowledgement('');
				onClose();
			})
			.catch((err: unknown) => setError(messageOf(err)))
			.finally(() => setBusy(false));
	};

	if (uncertain !== undefined) {
		/*
		 * The detach reached Steam and the reply may not have come back, so the
		 * authenticator may already be gone. The form is not offered again:
		 * sending it a second time is the one thing that must not happen, and the
		 * codes this application still shows may no longer be the ones Steam
		 * accepts.
		 *
		 * **And "may" is not always the right word.** The main process
		 * distinguishes a lost reply from a removal Steam is *known* to have
		 * performed — where the detach succeeded and only the local write failed —
		 * and this screen dropped that distinction on the floor, telling somebody
		 * whose account is definitely unprotected that nothing here can tell.
		 */
		return (
			<main className="shell">
				<header className="row">
					<h1>
						{uncertain.certain
							? 'Steam has already removed this'
							: 'This may already have happened'}
					</h1>
				</header>
				<p className="muted">
					{account.accountName} <span className="muted">{account.steamId64}</span>
				</p>
				<p className="error">{uncertain.guidance}</p>
				<p>
					{uncertain.certain
						? 'The account has no second factor until you add one somewhere else — do that ' +
							'before anything else.'
						: 'Nothing here can tell whether Steam acted on the request. Check Steam Guard on ' +
							'the account before doing anything else.'}
				</p>
				{/*
				 * **Only promised when it is true.** The refusal is kept on the account,
				 * and that write can fail. It was caught and swallowed, and the screen
				 * went on saying the request would not be sent again — about a record
				 * that does not exist.
				 */}
				<p>
					{uncertain.persisted === false
						? 'This warning could not be saved, so it will be gone once you close this window. ' +
							'The account will still be listed here and will still show codes, which may ' +
							'mean nothing. Write down what it says above before you close it.'
						: 'This application will not send the request again.'}
				</p>
				<div className="controls">
					<button type="button" onClick={onClose}>
						Close
					</button>
					{/*
					 * **The only thing that can settle this is the user.** Nothing local
					 * knows what Steam did, so the record is cleared by the person
					 * saying they have been and looked — which is also the moment the
					 * guidance above stops being useful to them. Without it the account
					 * carries the warning for ever.
					 */}
					<button
						type="button"
						disabled={resolving}
						onClick={() => {
							setResolving(true);
							void onResolve()
								.then(onClose)
								.finally(() => setResolving(false));
						}}
					>
						I have checked this account
					</button>
				</div>
			</main>
		);
	}

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
					<>
						<p>
							<strong>There is no revocation code for this account.</strong> Removing it here
							destroys this machine&rsquo;s copy of the authenticator, and the revocation code is
							what would otherwise let you detach it from Steam yourself.
						</p>
						<p>
							Without it you are relying on Steam&rsquo;s own account recovery — which may go
							through a phone number linked to the account, and may end at Steam Support. Neither is
							something this app can promise you, and both are slower than having the code.
						</p>
					</>
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
