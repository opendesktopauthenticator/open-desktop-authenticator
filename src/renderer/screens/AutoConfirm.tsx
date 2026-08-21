import { useState } from 'react';
import type { AccountSummary } from '../../shared/ipc';
import { matchesTradesAck, TRADES_ACK } from '../../shared/acknowledgements';
import { messageOf } from '../ipc-message';

/**
 * Turning automatic confirmation on for one account (§12 F6).
 *
 * This screen is where a user hands over a decision they would otherwise make
 * themselves, so it is written to be read rather than clicked through.
 *
 * Trades and market listings are separate switches because they are not the same
 * risk. A market listing that goes through wrongly costs the difference in price.
 * A trade that goes through wrongly is the items gone — and "approve trades
 * without asking me" is, stated plainly, what every scam in this ecosystem is
 * trying to obtain. So trades carry the sterner warning and neither is on by
 * default.
 *
 * What the screen also says, because users will otherwise assume the opposite:
 * **this never approves anything else.** Account-recovery and phone-number
 * confirmations are refused by the app regardless of what is switched on here,
 * and no setting on this page can widen that.
 */
export function AutoConfirm({
	account,
	onSave,
	onClose
}: {
	account: AccountSummary;
	onSave: (settings: {
		marketListings: boolean;
		trades: boolean;
		pollIntervalSeconds: number;
		tradesAcknowledgement?: string;
	}) => Promise<unknown>;
	onClose: () => void;
}): React.JSX.Element {
	const [marketListings, setMarketListings] = useState(account.autoConfirm.marketListings);
	const [trades, setTrades] = useState(account.autoConfirm.trades);
	const [pollIntervalSeconds, setPollIntervalSeconds] = useState(
		account.autoConfirm.pollIntervalSeconds
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [acknowledgement, setAcknowledgement] = useState('');

	/**
	 * Turning trades on requires typing the words, not ticking a box.
	 *
	 * §3 of the threat model promises exactly this and the checkbox alone did not
	 * deliver it. Ticking is muscle memory; typing is not, and this is the single
	 * setting in the application that lets items leave an account with nobody
	 * looking. Only required when switching it **on** — turning it off is always
	 * one click.
	 */
	const turningTradesOn = trades && !account.autoConfirm.trades;
	const acknowledged = !turningTradesOn || matchesTradesAck(acknowledgement);

	const submit = (event: React.FormEvent): void => {
		event.preventDefault();
		if (busy || !acknowledged) {
			return;
		}
		setBusy(true);
		setError(undefined);
		// The acknowledgement travels with the change. Main enforces it — the
		// typing gate here is the prompt, not the control.
		onSave({
			marketListings,
			trades,
			pollIntervalSeconds,
			...(turningTradesOn ? { tradesAcknowledgement: acknowledgement } : {})
		})
			.then(() => onClose())
			.catch((err: unknown) => setError(messageOf(err)))
			.finally(() => setBusy(false));
	};

	return (
		<main className="shell">
			<header className="row">
				<h1>Automatic confirmation</h1>
				<button type="button" className="secondary" onClick={onClose} disabled={busy}>
					Back
				</button>
			</header>

			<p className="muted">
				{account.accountName} <span className="muted">{account.steamId64}</span>
			</p>

			{error && <p className="error">{error}</p>}

			<form onSubmit={submit}>
				<label className="checkbox">
					<input
						type="checkbox"
						checked={marketListings}
						onChange={(event) => setMarketListings(event.target.checked)}
					/>
					<span>
						<strong>Market listings</strong>
						<p className="hint">
							Listings you create are confirmed without asking. If one was not yours, the cost is
							the item being on sale at a price you did not choose.
						</p>
					</span>
				</label>

				<label className="checkbox">
					<input
						type="checkbox"
						checked={trades}
						onChange={(event) => setTrades(event.target.checked)}
					/>
					<span>
						<strong>Trades</strong>
						<p className="hint bad">
							Trades are confirmed without asking. If one was not yours, the items are gone and
							there is no undo. &ldquo;Approve trades without asking me&rdquo; is what every scam in
							this ecosystem is trying to obtain — switch this on only if you understand that.
						</p>
					</span>
				</label>

				{turningTradesOn && (
					<>
						<label htmlFor="trade-acknowledgement">
							Type <code>{TRADES_ACK}</code> to switch this on
						</label>
						<input
							id="trade-acknowledgement"
							type="text"
							value={acknowledgement}
							onChange={(event) => setAcknowledgement(event.target.value)}
							autoComplete="off"
							spellCheck={false}
						/>
						<p className="hint">
							Asked because ticking a box is muscle memory and typing is not. Switching it back off
							never needs this.
						</p>
					</>
				)}

				<label htmlFor="poll-interval">Check for confirmations every</label>
				<input
					id="poll-interval"
					type="number"
					min={10}
					max={3600}
					value={pollIntervalSeconds}
					onChange={(event) =>
						setPollIntervalSeconds(Number.parseInt(event.target.value, 10) || 15)
					}
				/>
				<p className="hint">
					Seconds, at least 10. Checking harder does not make Steam answer faster — it makes Steam
					start refusing.
				</p>

				<div className="controls">
					<button type="submit" disabled={busy || !acknowledged}>
						{busy ? 'Saving…' : 'Save'}
					</button>
				</div>
			</form>

			<div className="ceremony">
				<h2>What this will never do</h2>
				<p>
					Account recovery and phone-number confirmations are <strong>never</strong> approved
					automatically, whatever is switched on above. Neither is any confirmation type this app
					does not recognise.
				</p>
				<p>
					That is not a setting — it is a rule in the code, because an attacker starting an account
					recovery is exactly the moment an authenticator must not be helpful.
				</p>
			</div>
		</main>
	);
}
