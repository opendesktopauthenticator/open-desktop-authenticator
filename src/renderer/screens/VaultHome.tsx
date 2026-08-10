import { useEffect, useState } from 'react';
import type { AccountSummary, CodesList } from '../../shared/ipc';
import { messageOf } from '../ipc-message';

/**
 * The unlocked view.
 *
 * Confirmations arrive with F5. What exists now is the account list with its
 * live Steam Guard codes, import, the lock control, and an honest auto-lock
 * countdown — a user who can see when the vault will lock is far less likely to
 * disable the timeout, which is the outcome that actually costs security.
 */
export function VaultHome({
	accounts,
	codes,
	msUntilAutoLock,
	onCopyCode,
	onBackUpRevocationCode,
	onChangeRouting,
	onShowConfirmations,
	onRemoveAccount,
	onChangeAutoConfirm,
	onImport,
	onEnrol,
	onFinishActivation,
	onExport,
	onSettings,
	onActivity,
	activityUrgent,
	onLock
}: {
	accounts: AccountSummary[];
	codes: CodesList | undefined;
	msUntilAutoLock: number | null;
	onCopyCode: (steamId64: string) => Promise<{ clipboardClearsInSeconds: number }>;
	onBackUpRevocationCode: (account: AccountSummary) => void;
	onChangeRouting: (account: AccountSummary) => void;
	onShowConfirmations: (account: AccountSummary) => void;
	onRemoveAccount: (account: AccountSummary) => void;
	onChangeAutoConfirm: (account: AccountSummary) => void;
	onImport: () => void;
	/** Add an authenticator to an account that has none. */
	onEnrol: () => void;
	/** Resume an enrollment that was never activated. */
	onFinishActivation: (account: AccountSummary) => void;
	/** Write one account out as a maFile. */
	onExport: (account: AccountSummary) => void;
	onSettings: () => void;
	onActivity: () => void;
	/** Something automatic confirmation did needs a person to look at it. */
	activityUrgent: boolean;
	onLock: () => void;
}): React.JSX.Element {
	/** Which account was copied last, so the confirmation lands on the right row. */
	const [copied, setCopied] = useState<{ steamId64: string; seconds: number } | undefined>();
	/** A copy that failed. Silently doing nothing is the one response a button must never give. */
	const [copyError, setCopyError] = useState<{ steamId64: string; message: string } | undefined>();

	// Retire the message when the clipboard clear it describes has happened.
	// Left up, it goes from true to false without changing: the clipboard is
	// already empty while the text still promises to empty it.
	useEffect(() => {
		if (!copied) {
			return;
		}
		const timer = setTimeout(() => setCopied(undefined), copied.seconds * 1000);
		return () => clearTimeout(timer);
	}, [copied]);

	const byAccount = new Map(codes?.codes.map((entry) => [entry.steamId64, entry]));
	const failures = new Map(codes?.failures.map((entry) => [entry.steamId64, entry.reason]));

	return (
		<main className="shell">
			<header className="row">
				<h1>Accounts</h1>
				<div className="controls">
					<button type="button" className="secondary" onClick={onEnrol}>
						Add authenticator
					</button>
					<button type="button" className="secondary" onClick={onImport}>
						Import maFiles
					</button>
					<button
						type="button"
						className={activityUrgent ? 'secondary danger' : 'secondary'}
						onClick={onActivity}
					>
						{activityUrgent ? 'Activity — needs you' : 'Activity'}
					</button>
					<button type="button" className="secondary" onClick={onSettings}>
						Settings
					</button>
					<button type="button" className="secondary" onClick={onLock}>
						Lock now
					</button>
				</div>
			</header>

			<p className="muted">{describeAutoLock(msUntilAutoLock)}</p>

			{activityUrgent && (
				// A button label alone is missable, and the thing it is reporting may be
				// somebody taking the account.
				<div className="ceremony">
					<h2>Automatic confirmation held something back</h2>
					<p>
						Something was refused for your safety, or an account stopped being checked. Open
						Activity to see what and decide.
					</p>
					<div className="controls">
						<button type="button" onClick={onActivity}>
							Open Activity
						</button>
					</div>
				</div>
			)}

			{accounts.length > 0 && codes?.clockUnverified && (
				<p className="notice">
					This machine&rsquo;s clock has not been checked against Steam&rsquo;s. Codes are generated
					from local time, so if the clock is more than about half a minute out, Steam will reject
					them.
				</p>
			)}

			{accounts.length === 0 ? (
				<div className="empty">
					<h2>No accounts yet</h2>
					<p>
						Import the <code>.maFile</code> files from your existing Steam Desktop Authenticator
						install. Nothing is stored until you add something.
					</p>
					<button type="button" onClick={onEnrol}>
						Add an authenticator
					</button>
					<button type="button" className="secondary" onClick={onImport}>
						Import maFiles
					</button>
				</div>
			) : (
				<ul className="accounts">
					{accounts.map((account) => {
						const code = byAccount.get(account.steamId64);
						const failure = failures.get(account.steamId64);
						const justCopied = copied?.steamId64 === account.steamId64;

						return (
							<li key={account.steamId64}>
								<div>
									<strong>{account.accountName}</strong>
									<span className="muted"> {account.steamId64}</span>
									{failure && <p className="hint bad">{failure}</p>}
									{justCopied && (
										<p className="hint">
											Copied. The clipboard is cleared in {copied.seconds}s unless you copy
											something else.
										</p>
									)}
									{copyError?.steamId64 === account.steamId64 && (
										<p className="hint bad">{copyError.message}</p>
									)}
								</div>

								<div className="controls">
									{code && (
										<>
											{/* `--remaining` drives the drain under the glyphs and the
											    colour walk in app.css. A fraction rather than a count of
											    seconds, so the stylesheet owns the presentation and this
											    stays a statement about how much life the code has left.
											    Steam Guard codes run on a 30-second window. */}
											<span
												className={code.secondsRemaining <= 5 ? 'code expiring' : 'code'}
												title="Steam Guard code"
												style={
													{
														'--remaining': Math.max(0, Math.min(1, code.secondsRemaining / 30))
													} as React.CSSProperties
												}
											>
												{code.code}
											</span>
											<span
												className={code.secondsRemaining <= 5 ? 'expiry expiring' : 'expiry'}
												aria-label={`expires in ${code.secondsRemaining} seconds`}
											>
												{code.secondsRemaining}s
											</span>
											<button
												type="button"
												className="secondary"
												onClick={() => {
													setCopyError(undefined);
													onCopyCode(account.steamId64)
														.then((result) => {
															setCopied({
																steamId64: account.steamId64,
																seconds: result.clipboardClearsInSeconds
															});
														})
														.catch((err: unknown) => {
															setCopied(undefined);
															// The shared helper, not a second copy of the same
															// regex: two of them drift, and this one had already
															// grown a variation the other did not have.
															setCopyError({
																steamId64: account.steamId64,
																message: messageOf(err)
															});
														});
												}}
											>
												Copy
											</button>
										</>
									)}
									<button
										type="button"
										className="secondary"
										onClick={() => onShowConfirmations(account)}
									>
										Confirmations
									</button>
									{/* Last, and visually quietest of the three. It is the only one
									    here that destroys something. */}
									<button
										type="button"
										className="secondary"
										onClick={() => onExport(account)}
										title="Save this account as a .maFile, readable by SDA and anything else in the ecosystem."
									>
										Export
									</button>
									<button
										type="button"
										className="secondary danger"
										onClick={() => onRemoveAccount(account)}
										title="Remove this account from the vault. Does not remove it from Steam."
									>
										Remove
									</button>
								</div>

								<div className="flags">
									{account.status === 'pendingRevocationBackup' ? (
										// Actionable, not just a label. A warning with no way to clear it
										// is one people learn to look past.
										<button
											type="button"
											className="flag warn actionable"
											onClick={() => onBackUpRevocationCode(account)}
										>
											back up recovery code
										</button>
									) : account.status === 'pendingActivation' ? (
										/* A way back in, not just a label. Enrollment attaches the
										   authenticator on Steam's side before activation, so an
										   account stuck here already depends on this app — and the
										   screen that could finish it used to be unreachable once
										   left, including by going to write the revocation code down,
										   which that screen tells you to do. */
										<button
											type="button"
											className="flag warn actionable"
											onClick={() => onFinishActivation(account)}
											title="Steam has attached this authenticator but it was never activated. Finish it here."
										>
											finish activation
										</button>
									) : (
										account.status !== 'active' && (
											<span className="flag warn">{describeStatus(account.status)}</span>
										)
									)}
									{!account.hasRevocationCode && (
										<span className="flag bad" title="This account cannot be self-recovered.">
											no revocation code
										</span>
									)}
									{/* Always offered, never required — and the only way to remove a
									    proxy that came in with an imported maFile.

									    The label reports what is **known**, not what is configured.
									    "routed" used to mean only that a URL was stored, which is
									    the one reassurance an anonymity feature must never give on
									    faith: a proxy can be configured and silently not applied. */}
									<button
										type="button"
										className={`flag actionable ${routingClass(account.routing)}`}
										onClick={() => onChangeRouting(account)}
										title={routingExplanation(account)}
									>
										{routingLabel(account.routing)}
									</button>
									{/* Actionable like the routing flag: these were displayed and
									    unreachable, so nobody could turn them on OR off. */}
									<button
										type="button"
										className={
											account.autoConfirm.trades || account.autoConfirm.marketListings
												? 'flag warn actionable'
												: 'flag actionable'
										}
										onClick={() => onChangeAutoConfirm(account)}
										title="Approve trades or market listings without asking. Off by default."
									>
										{describeAutoConfirm(account.autoConfirm)}
									</button>
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</main>
	);
}

/** What the auto-confirm flag says, in the order that matters most. */
/**
 * The routing flag, worded so it cannot overstate what is known.
 *
 * Four states, and the distinction between the middle two is the whole point:
 * `unverified` means a proxy is configured but nothing has connected through it
 * yet, so the app has no evidence either way. Showing that as "routed" would be
 * a claim about anonymity made on the strength of a populated field.
 */
function routingLabel(routing: AccountSummary['routing']): string {
	switch (routing) {
		case 'off':
			return 'not routed';
		case 'unverified':
			return 'routed · unverified';
		case 'verified':
			return 'routed · verified';
		case 'blocked':
			return 'ROUTING FAILED';
	}
}

function routingClass(routing: AccountSummary['routing']): string {
	switch (routing) {
		case 'blocked':
			return 'bad';
		case 'verified':
			return 'good';
		// `off` and `unverified` are both "no claim is being made", and neither is
		// a problem — routing is optional and an unused account has simply not been
		// checked yet.
		default:
			return '';
	}
}

function routingExplanation(account: AccountSummary): string {
	switch (account.routing) {
		case 'off':
			return 'Optional. This account connects the way everything else on this machine does.';
		case 'unverified':
			return (
				`Configured to route through ${account.routedVia ?? 'a proxy'}, but nothing has ` +
				'connected through it yet, so this has not been checked. It is verified on the ' +
				'first request.'
			);
		case 'verified':
			return (
				`Checked: this account's requests leave through ${account.routedVia ?? 'the proxy'}. ` +
				'Re-checked before every request.'
			);
		case 'blocked':
			return (
				`This account will not connect. It is set to route through ` +
				`${account.routedVia ?? 'a proxy'}, but ${account.routingProblem ?? 'routing did not apply'}. ` +
				'Connecting anyway would expose the address the proxy exists to hide.'
			);
	}
}

function describeAutoConfirm(settings: AccountSummary['autoConfirm']): string {
	if (settings.trades && settings.marketListings) {
		return 'auto-confirm: trades + market';
	}
	// Trades first when only one is on: it is the consequential one.
	if (settings.trades) {
		return 'auto-confirm: trades';
	}
	if (settings.marketListings) {
		return 'auto-confirm: market';
	}
	return 'auto-confirm: off';
}

function describeStatus(status: AccountSummary['status']): string {
	switch (status) {
		case 'pendingRevocationBackup':
			return 'revocation code not backed up';
		case 'pendingActivation':
			return 'activation incomplete';
		default:
			return status;
	}
}

function describeAutoLock(ms: number | null): string {
	if (ms === null) {
		return 'Locked.';
	}
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	if (minutes > 0) {
		return `Locks automatically in ${minutes}m ${String(seconds).padStart(2, '0')}s of inactivity.`;
	}
	return `Locks automatically in ${seconds}s of inactivity.`;
}
