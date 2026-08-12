import { useEffect, useRef, useState } from 'react';
import { Logo } from '../Logo';
import { branding } from '../../shared/branding';
import type { AccountSummary, CodesList, ExportResult } from '../../shared/ipc';
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
	onRecover,
	onEnrol,
	onFinishActivation,
	onExport,
	onSettings,
	onAbout,
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
	/**
	 * Opens the recovery screen.
	 *
	 * Present on the header and on the empty state, because the two situations
	 * that lead here are opposite ones: an established vault that lost an account,
	 * and a fresh install being rebuilt from files after a machine died.
	 */
	onRecover: () => void;
	/** Add an authenticator to an account that has none. */
	onEnrol: () => void;
	/** Resume an enrollment that was never activated. */
	onFinishActivation: (account: AccountSummary) => void;
	/** Write one account out as a maFile. */
	onExport: (account: AccountSummary) => Promise<ExportResult>;
	onSettings: () => void;
	onAbout: () => void;
	onActivity: () => void;
	/** Something automatic confirmation did needs a person to look at it. */
	activityUrgent: boolean;
	onLock: () => void;
}): React.JSX.Element {
	/** Which account was copied last, so the confirmation lands on the right row. */
	const [copied, setCopied] = useState<{ steamId64: string; seconds: number } | undefined>();
	/** A copy that failed. Silently doing nothing is the one response a button must never give. */
	const [copyError, setCopyError] = useState<{ steamId64: string; message: string } | undefined>();
	/** The account whose code is being copied, if any. */
	const [copying, setCopying] = useState<string | undefined>();
	/** The account being exported, and what came of the last one. */
	const [exporting, setExporting] = useState<string | undefined>();
	const [exported, setExported] = useState<{ steamId64: string; message: string } | undefined>();

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

	/**
	 * The pointer's position within whichever row it is over, for the light that
	 * follows it (`--mx` / `--my` in app.css).
	 *
	 * One delegated listener on the list rather than one per row, and coalesced
	 * into an animation frame so a fast sweep across twenty accounts sets two
	 * custom properties per frame instead of two per pointer event. Passive,
	 * because it never calls preventDefault and saying so lets the compositor
	 * stop waiting to find out.
	 */
	const list = useRef<HTMLUListElement>(null);
	useEffect(() => {
		const element = list.current;
		if (!element) {
			return;
		}
		let frame = 0;
		let last: PointerEvent | undefined;
		const onMove = (event: PointerEvent) => {
			last = event;
			if (frame !== 0) {
				return;
			}
			frame = requestAnimationFrame(() => {
				frame = 0;
				const target = last?.target;
				const row = target instanceof Element ? target.closest('li') : null;
				if (!row || last === undefined) {
					return;
				}
				const box = row.getBoundingClientRect();
				row.style.setProperty('--mx', `${last.clientX - box.left}px`);
				row.style.setProperty('--my', `${last.clientY - box.top}px`);
			});
		};
		element.addEventListener('pointermove', onMove, { passive: true });
		return () => {
			element.removeEventListener('pointermove', onMove);
			// A frame still queued after unmount would touch a detached row.
			cancelAnimationFrame(frame);
		};
	}, []);

	const byAccount = new Map(codes?.codes.map((entry) => [entry.steamId64, entry]));
	const failures = new Map(codes?.failures.map((entry) => [entry.steamId64, entry.reason]));

	return (
		<main className="shell">
			<header className="row">
				{/* The mark, then the title. A product with no sign of itself anywhere
				    on its main screen reads as a utility somebody threw together. */}
				<div className="brand">
					<Logo size={30} />
					<h1>Accounts</h1>
				</div>
				<div className="controls">
					{/* **The one primary button on this screen.** Six identical secondary
					    buttons gave the eye nowhere to land; adding an account is the
					    thing a new user is here to do, so it is the thing that looks
					    like an action. */}
					<button type="button" onClick={onEnrol}>
						Add authenticator
					</button>
					<button type="button" className="secondary" onClick={onImport}>
						Import maFiles
					</button>
					<button type="button" className="secondary" onClick={onRecover}>
						Recover from file
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
					<button type="button" className="secondary" onClick={onAbout}>
						About
					</button>
					<button type="button" className="secondary" onClick={onLock}>
						Lock now
					</button>
				</div>
			</header>

			{/* Its own bar under the header rule rather than a paragraph pushed up
			    against the toolbar, where it read as a caption belonging to the last
			    button rather than as the window's status. */}
			<p className="statusline">
				<span className="statusline-dot" aria-hidden="true" />
				{(() => {
					const lock = describeAutoLock(msUntilAutoLock);
					return (
						<span>
							{lock.lead}
							{lock.value !== undefined && <span className="num">{lock.value}</span>}
							{lock.trail}
						</span>
					);
				})()}
			</p>

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
					{/* First run. The one screen with nothing on it, so it is the one
					    place the mark can be large without competing with anything. */}
					<Logo size={54} drawIn />
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
					<button type="button" className="secondary" onClick={onRecover}>
						Recover from file
					</button>
				</div>
			) : (
				<ul className="accounts" ref={list}>
					{accounts.map((account) => {
						const code = byAccount.get(account.steamId64);
						const failure = failures.get(account.steamId64);
						const justCopied = copied?.steamId64 === account.steamId64;

						/* Steam Guard codes run on a thirty-second window. Set once per row
						   and inherited, so the drain under the glyphs and the ring around the
						   seconds can never disagree about how much time is left. */
						const remaining =
							code === undefined ? undefined : Math.max(0, Math.min(1, code.secondsRemaining / 30));

						return (
							<li
								key={account.steamId64}
								style={
									remaining === undefined
										? undefined
										: ({ '--remaining': remaining } as React.CSSProperties)
								}
							>
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
											>
												{/* One element per character, so each can land on its own
												    beat. Keyed on the code itself: React then rebuilds these
												    nodes when the code rotates — which replays the animation
												    exactly once every thirty seconds — and reuses them across
												    the once-a-second countdown tick, which must not. */}
												{[...code.code].map((glyph, at) => (
													<span
														key={`${code.code}-${at}`}
														className="glyph"
														style={{ '--g': at } as React.CSSProperties}
													>
														{glyph}
													</span>
												))}
											</span>
											{/* A ring rather than a bare number: the count and how much of
											    the window is left are one glance instead of two. The digits
											    alone stay in the accessible name, because "9" is the fact and
											    the ring is only how it is drawn. */}
											<span
												className={code.secondsRemaining <= 5 ? 'expiry expiring' : 'expiry'}
												role="img"
												aria-label={`expires in ${code.secondsRemaining} seconds`}
											>
												<span aria-hidden="true">{code.secondsRemaining}</span>
											</span>
											<button
												type="button"
												// **Confirms on the control that was pressed.** The sentence
												// below the row already said the copy worked, but it is under
												// the account name, several inches from the button and easy
												// to miss — so the click read as having done nothing.
												className={justCopied ? 'secondary copy copied' : 'secondary copy'}
												// The first copy after an unlock waits on the Steam clock
												// sync, which can take seconds. Without this the button
												// looked inert and invited a second click.
												disabled={copying === account.steamId64}
												onClick={() => {
													setCopyError(undefined);
													setCopying(account.steamId64);
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
														})
														.finally(() => setCopying(undefined));
												}}
											>
												{copying === account.steamId64
													? 'Copying…'
													: justCopied
														? 'Copied'
														: 'Copy'}
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
									{/* Reports what happened. Fire-and-forget made a cancelled save
									    dialog and a real failure look identical — both were silence,
									    which reads as the button not working. */}
									<button
										type="button"
										className="secondary"
										disabled={exporting === account.steamId64}
										onClick={() => {
											setExported(undefined);
											setExporting(account.steamId64);
											onExport(account)
												.then((result) => {
													setExported({
														steamId64: account.steamId64,
														message:
															result.state === 'saved'
																? `Saved as ${result.fileName}. Treat that file as a key to this account.`
																: 'Nothing was saved.'
													});
												})
												.catch((err: unknown) => {
													setExported({
														steamId64: account.steamId64,
														message: `It could not be saved: ${messageOf(err)}`
													});
												})
												.finally(() => setExporting(undefined));
										}}
										title="Save this account as a .maFile, readable by SDA and anything else in the ecosystem."
									>
										{exporting === account.steamId64 ? 'Saving…' : 'Export'}
									</button>
									<button
										type="button"
										className="secondary danger"
										onClick={() => onRemoveAccount(account)}
										title="Remove this account from the vault. Does not remove it from Steam."
									>
										Remove
									</button>
									{exported?.steamId64 === account.steamId64 && (
										<p className="hint">{exported.message}</p>
									)}
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

			{/*
				The publisher, on the screen people actually sit on.

				The About screen carries the full account of who builds this, but a
				person has to go looking for it — and the complaint that started this
				was that the application named its publisher nowhere you would see it.
				A mark at the foot of the list is where a desktop application usually
				says this, and it costs one line of a screen nobody scrolls to the
				bottom of twice.

				Deliberately quiet: the codes are the reason this window is open, and
				branding that competed with them would be the wrong trade. It is a
				button rather than a link because it opens a screen inside the app.
			*/}
			<footer className="app-foot">
				<button type="button" className="powered-mark" onClick={onAbout}>
					<span className="powered-lead">Powered by</span>
					<span className="powered-name">{branding.companyShort}</span>
				</button>
			</footer>
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

/**
 * The auto-lock countdown, split so the duration can be set apart.
 *
 * Returns parts rather than a sentence because the number wants the measuring
 * face and the words do not — and because a duration rendered in the text face
 * with proportional figures visibly reflowed the whole line once a second as the
 * digits changed width.
 */
function describeAutoLock(ms: number | null): { lead: string; value?: string; trail?: string } {
	if (ms === null) {
		return { lead: 'Locked.' };
	}
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return {
		lead: 'Locks automatically after ',
		value: minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`,
		trail: ' of inactivity'
	};
}
