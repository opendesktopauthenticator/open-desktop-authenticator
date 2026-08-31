import { useState } from 'react';
import type { AccountSummary } from '../../shared/ipc';
import type { NotifyDetail } from '../../shared/vault-schema';
import { matchesTradesAck, TRADES_ACK } from '../../shared/acknowledgements';
import { messageOf } from '../ipc-message';

/** Below this, the screen says what the interval costs. */
export const RATE_WARNING_BELOW_SECONDS = 30;

/**
 * Whether an account is polled at all.
 *
 * Either switch does it. An account that only watches still costs a request
 * per interval, which is the whole point of counting them here.
 */
export function isPolled(account: AccountSummary): boolean {
	return (
		account.autoConfirm.marketListings ||
		account.autoConfirm.trades ||
		account.autoConfirm.notify.enabled
	);
}

/**
 * Requests a minute across every polled account, and how many that is.
 *
 * Exported and tested directly: this project has no DOM runner, and the
 * arithmetic is the part that can be wrong in a way nobody notices. An earlier
 * draft of the test asserted `interval × accounts`, which is the reciprocal —
 * it would have expected 30 where the screen prints 8.
 *
 * `polled` counts accounts that are **actually** polled, not `accounts.length`.
 * Counting every account inflates the number for a vault where most are idle,
 * and a warning that overstates its case is one people learn to dismiss.
 *
 * **Summed per account, because each one has its own interval.** This used to
 * scale the *edited* account's pending interval by the number of polled
 * accounts, which is only right when every account shares that interval — and
 * the fixtures did, so both formulas agreed and the tests could not see it.
 * Editing one account to 10s beside three sitting at an hour printed "About 24
 * requests a minute" against a true 6; the reverse understated, printing 0 while
 * three accounts polled every ten seconds.
 *
 * @param editing the account being edited and the values on screen for it.
 * Required, and not merely an interval, because the interval only ever applied
 * to that one account — passing a bare number invited the reading that produced
 * the bug. Its saved settings are stale by definition: the form holds newer
 * ones, and without them turning notifications on for an idle account left it
 * uncounted until Save, which is the wrong moment to learn what the rate will
 * be.
 */
export function pollLoad(
	accounts: readonly AccountSummary[],
	editing: { steamId64: string; polled: boolean; pollIntervalSeconds: number }
): { requestsPerMinute: number; polled: number } {
	const isEdited = (account: AccountSummary): boolean => account.steamId64 === editing.steamId64;
	const counted = accounts.filter((account) =>
		isEdited(account) ? editing.polled : isPolled(account)
	);
	const perMinute = counted.reduce((total, account) => {
		const seconds = isEdited(account)
			? editing.pollIntervalSeconds
			: account.autoConfirm.pollIntervalSeconds;
		return total + 60 / Math.max(1, seconds);
	}, 0);
	return { requestsPerMinute: Math.round(perMinute), polled: counted.length };
}

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
	accounts,
	requireProxies,
	onSave,
	onClose
}: {
	account: AccountSummary;
	/**
	 * Whether the vault refuses to talk to Steam for an account with no proxy.
	 *
	 * Needed here only to say so: an account this rule strands is not polled at
	 * all, and every switch on this screen is about polling.
	 */
	requireProxies: boolean;
	/**
	 * Every account, so the rate warning can count the ones actually polled.
	 *
	 * The load this interval creates is not a property of one account — Steam
	 * rate-limits the machine, not the setting.
	 */
	accounts: readonly AccountSummary[];
	onSave: (settings: {
		marketListings: boolean;
		trades: boolean;
		pollIntervalSeconds: number;
		tradesAcknowledgement?: string;
		notify: { enabled: boolean; detail: NotifyDetail };
	}) => Promise<unknown>;
	onClose: () => void;
}): React.JSX.Element {
	const [marketListings, setMarketListings] = useState(account.autoConfirm.marketListings);
	const [trades, setTrades] = useState(account.autoConfirm.trades);
	const [pollIntervalSeconds, setPollIntervalSeconds] = useState(
		account.autoConfirm.pollIntervalSeconds
	);
	const [notifyEnabled, setNotifyEnabled] = useState(account.autoConfirm.notify.enabled);
	const [notifyDetail, setNotifyDetail] = useState<NotifyDetail>(account.autoConfirm.notify.detail);
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
			notify: { enabled: notifyEnabled, detail: notifyDetail },
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

			{/*
				**Nothing on this screen said the switches were doing nothing.**

				`Require proxies` is global, and the poller skips an account with no
				proxy under it — silently and on purpose, because counting a policy
				refusal as a failure would spend the ten-strike halt on it. So the
				switch stayed on, the account list went on saying "auto-confirm:
				trades, notifying", and the account had not been checked since the
				setting was saved. The global flip is the worse trigger: it strands
				every unproxied account at once with no screen changing.

				Stated above the switches rather than beside one of them, because it
				applies to all of them, and it names both ways out — this screen owns
				neither, so pointing at them is the most it can do.
			*/}
			{requireProxies && !account.hasProxy && (
				<p className="warn">
					<strong>Paused — this account has no proxy.</strong> Settings requires every account to
					use one, so nothing below is running for this account: no confirmations are approved and
					no notifications are raised. Give it a proxy under Routing, or turn off{' '}
					<em>Require proxies</em> in Settings.
				</p>
			)}

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

				<label className="checkbox">
					<input
						type="checkbox"
						checked={notifyEnabled}
						onChange={(event) => setNotifyEnabled(event.target.checked)}
					/>
					<span>
						<strong>Notify me about confirmations that need me</strong>
						{/*
						 * **The disclosure sits here, beside the switch — not beside the
						 * `full` radio below.** `full` is the default, so the sentence has
						 * to be read by anyone switching notifications on, not only by
						 * somebody who goes looking at the detail options.
						 *
						 * It names **both** the lock screen and notification history. An
						 * earlier draft named only the history, which is the smaller of
						 * the two, and this sentence is the only thing standing between
						 * the default and an unattended screen — a proposal to degrade
						 * `full` while Windows is locked was considered and deliberately
						 * rejected, so nothing else covers this.
						 */}
						<p className="hint">
							Notifications name the trade and its items. Windows shows them on the lock screen and
							keeps them in notification history, so they can be read by anyone at this machine.
							Choose <strong>Count only</strong> or <strong>Type only</strong> below to leave the
							details out.
						</p>
					</span>
				</label>

				{notifyEnabled && (
					<fieldset className="radios">
						<legend>What a notification says</legend>
						{(
							[
								['full', 'Everything', 'Trade with SomeTrader — you give: AK-47 Redline'],
								['type', 'Type only', '1 trade, 1 market listing'],
								['count', 'Count only', '2 confirmations need you']
							] as const
						).map(([value, label, example]) => (
							<label className="radio" key={value}>
								<input
									type="radio"
									name="notify-detail"
									value={value}
									checked={notifyDetail === value}
									onChange={() => setNotifyDetail(value)}
								/>
								<span>
									<strong>{label}</strong>
									<p className="hint">{example}</p>
								</span>
							</label>
						))}
						<p className="hint">
							<strong>Count only</strong> and <strong>Type only</strong> are the answer for a
							machine other people can see, or one you walk away from.
						</p>
					</fieldset>
				)}

				<label htmlFor="poll-interval">How often this account is checked</label>
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
					Seconds, at least 10. This interval serves both automatic confirmation and notifications —
					they are the same poll. Checking harder does not make Steam answer faster; it makes Steam
					start refusing.
				</p>

				{pollIntervalSeconds < RATE_WARNING_BELOW_SECONDS &&
					(() => {
						/*
						 * Shown at the default of 15 seconds, and deliberately not
						 * special-cased away. The default really does make this many
						 * requests, and a warning that hides at the one value most people
						 * never change is a warning that never appears.
						 */
						const { requestsPerMinute, polled } = pollLoad(accounts, {
							steamId64: account.steamId64,
							// The switches on screen, not the ones last saved.
							polled: marketListings || trades || notifyEnabled,
							pollIntervalSeconds
						});
						return (
							<p className="hint bad">
								About <strong>{requestsPerMinute}</strong> requests a minute across{' '}
								<strong>{polled}</strong> {polled === 1 ? 'account' : 'accounts'}. Steam
								rate-limits, and a blocked account stops confirmations entirely for a while.
							</p>
						);
					})()}

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
