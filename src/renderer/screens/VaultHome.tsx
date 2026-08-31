import { useEffect, useRef, useState } from 'react';
import { CompanyMark } from '../CompanyMark';
import { Logo } from '../Logo';
import { branding } from '../../shared/branding';
import type {
	AccountSummary,
	BrowserRoute,
	CodesList,
	ExportResult,
	OpenBrowserResult
} from '../../shared/ipc';
import { messageOf } from '../ipc-message';

/**
 * The unlocked view.
 *
 * Confirmations arrive with F5. What exists now is the account list with its
 * live Steam Guard codes, import, the lock control, and an honest auto-lock
 * countdown — a user who can see when the vault will lock is far less likely to
 * disable the timeout, which is the outcome that actually costs security.
 */
/**
 * Add one account to a set of in-flight operations, leaving the rest alone.
 *
 * Written as updater functions rather than inline object spreads so that two
 * presses landing in the same React batch cannot lose one another — each reads
 * the set it is actually applied to.
 */
export const running =
	(steamId64: string) =>
	(prev: ReadonlySet<string>): ReadonlySet<string> =>
		new Set(prev).add(steamId64);

/** And take it out again when it settles, however it settled. */
export const finished =
	(steamId64: string) =>
	(prev: ReadonlySet<string>): ReadonlySet<string> => {
		const next = new Set(prev);
		next.delete(steamId64);
		return next;
	};

/**
 * Record or clear one account's message, leaving every other row alone.
 *
 * **One object used to serve the whole list, twice over.** These messages are
 * rendered on the row they belong to, so two accounts never compete for the
 * slot — but a single object meant the second overwrote the first, and starting
 * anything on a third row cleared what was on screen. Two people pressed a
 * button, neither got what they asked for, and one of them was told nothing.
 *
 * Used for the browser's failures and for export results, which include the
 * warning that a plaintext copy is still on disk — the last message that should
 * be dismissible by somebody else's action.
 */
export const noted =
	(steamId64: string, message: string | undefined) =>
	(prev: ReadonlyMap<string, string>): ReadonlyMap<string, string> => {
		const next = new Map(prev);
		if (message === undefined) {
			next.delete(steamId64);
		} else {
			next.set(steamId64, message);
		}
		return next;
	};

export function VaultHome({
	accounts,
	codes,
	msUntilAutoLock,
	onCopyCode,
	onBackUpRevocationCode,
	onChangeRouting,
	onShowConfirmations,
	onOpenBrowser,
	requireProxies,
	onRemoveAccount,
	onChangeAutoConfirm,
	onImport,
	onRecover,
	onEnrol,
	onMove,
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
	/**
	 * Open a signed-in, routed browser for this account.
	 *
	 * Resolves with what happened rather than throwing it, because one outcome —
	 * Steam wanting a sign-in — is a step the caller can offer instead of an
	 * error this screen would only print. When it comes back `signInRequired` the
	 * caller has already taken over the screen, so nothing is shown here.
	 */
	onOpenBrowser: (account: AccountSummary, route: BrowserRoute) => Promise<OpenBrowserResult>;
	/**
	 * Whether the vault refuses unrouted browsing.
	 *
	 * Only removes the Direct button. The refusal itself lives in the main
	 * process — see `browser/ipc.ts` — because "the renderer stopped offering
	 * it" has never counted as a control here, and this screen is reloaded from
	 * a vault whose settings it does not own.
	 */
	requireProxies: boolean;
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
	/**
	 * Moving an authenticator that already exists on the Steam mobile app.
	 *
	 * Its own button rather than a branch inside "Add authenticator", because the
	 * two are different operations with different costs. Somebody with an
	 * authenticator on their phone who presses Add is told to remove it first —
	 * which is the fifteen-day path, and the exact mistake this offers a way past.
	 */
	onMove: () => void;
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
	/**
	 * Every account whose code is being copied right now — a set, not one name.
	 *
	 * **A single name only ever described the newest press.** Start a copy on one
	 * account, start another before it settles, and the first row's button came
	 * straight back to life still saying "Copy" while its request was very much
	 * in flight. Pressing it again ran a second one; the export version of the
	 * same bug opened a second save dialog.
	 *
	 * The `finally` below was already careful not to clear somebody else's flag,
	 * which made the completion path correct and left the *starting* path wrong.
	 */
	const [copying, setCopying] = useState<ReadonlySet<string>>(() => new Set());
	/**
	 * Which copy attempt owns the copy status slot.
	 *
	 * There is one `copied`/`copyError` pair for the whole list, so two attempts
	 * on different rows raced: the first copy after an unlock waits on the Steam
	 * clock sync and can take seconds, while another row's button stays live.
	 * Whichever settled last won — so an older failure could overwrite a newer
	 * success, leaving the row that actually worked showing another row's error.
	 */
	const copyAttempt = useRef(0);

	/**
	 * And which export attempt owns the export slot, which is a different slot.
	 *
	 * **One counter used to serve both, and that made them cancel each other.**
	 * Copy writes `copied`; export writes `exported`; they are rendered
	 * separately and neither is a reason to discard the other. Sharing the
	 * counter meant starting an export while a copy was still waiting on the
	 * clock sync made the copy — which then succeeded, and put a live Steam Guard
	 * code on the clipboard with a timer running — say nothing at all. The
	 * reverse silenced a save that had already written a file holding the keys to
	 * an account.
	 *
	 * The rule this file already applies to the browser button: a counter guards
	 * one status slot, and a separate slot gets a separate counter.
	 */
	const exportAttempt = useRef(new Map<string, number>());

	/** The same, for exports. See `copying`. */
	const [exporting, setExporting] = useState<ReadonlySet<string>>(() => new Set());
	/** What came of the last export. */
	const [exported, setExported] = useState<ReadonlyMap<string, string>>(() => new Map());

	/** The account whose browser is being opened, and why the last one was not. */
	const [opening, setOpening] = useState<ReadonlySet<string>>(() => new Set());
	/**
	 * Why each account's browser did not open, keyed by account.
	 *
	 * **One object served the whole list, and rows do not share failures.** The
	 * message is rendered on the row it belongs to, so two accounts failing meant
	 * the second overwrote the first: only one row explained itself, and starting
	 * any third browser cleared what was on screen. Both users pressed a button,
	 * neither browser opened, and one of them was told nothing at all.
	 */
	const [browserError, setBrowserError] = useState<ReadonlyMap<string, string>>(() => new Map());
	/**
	 * Its own counter, like copy's and export's.
	 *
	 * Same problem, same fix: one status slot for the whole list, so a slow
	 * failure on one row could land under another row's newer attempt. Separate
	 * because these are separate slots — opening a browser should not silence an
	 * export's result, which is still on screen and still true.
	 */
	const browserAttempt = useRef(new Map<string, number>());

	/**
	 * Claim the newest browser attempt **for one account**, and answer whether it
	 * is still the newest when it settles.
	 *
	 * **A single counter suppressed the wrong failures.** `browserError` is shown
	 * on the row it belongs to, so account A's failure and account B's compete
	 * for nothing — but one global counter made B's press "newer" than A's, and
	 * A's failure was then discarded as stale. A's browser had not opened and
	 * nothing on screen said why.
	 */
	const claimExport = (steamId64: string): (() => boolean) => {
		const mine = (exportAttempt.current.get(steamId64) ?? 0) + 1;
		exportAttempt.current.set(steamId64, mine);
		return () => exportAttempt.current.get(steamId64) === mine;
	};

	const claimBrowser = (steamId64: string): (() => boolean) => {
		const mine = (browserAttempt.current.get(steamId64) ?? 0) + 1;
		browserAttempt.current.set(steamId64, mine);
		return () => browserAttempt.current.get(steamId64) === mine;
	};

	/**
	 * Open the browser for one account by one route, and report the outcome on
	 * that account's row.
	 *
	 * Shared by all three buttons deliberately. It was written out per button
	 * while there were two, and the second copy had already lost the note
	 * explaining why `finally` clears one account's flag rather than all of
	 * them — three copies would have been three chances to lose the `newest()`
	 * check that keeps a stale failure off a row that has since succeeded.
	 */
	const openBrowserAs = (account: AccountSummary, route: BrowserRoute): void => {
		const newest = claimBrowser(account.steamId64);
		setBrowserError(noted(account.steamId64, undefined));
		setOpening(running(account.steamId64));
		onOpenBrowser(account, route)
			.catch((err: unknown) => {
				// A sign-in is not an error and never arrives here — it comes back
				// as a state and the caller shows the form. What reaches this is
				// routing that could not be applied, or Steam being unreachable.
				if (!newest()) {
					return;
				}
				setBrowserError(noted(account.steamId64, messageOf(err)));
			})
			.finally(() =>
				// Only this account's flag, for the reason the copy button
				// documents: clearing unconditionally re-enables a row whose own
				// open is still in flight.
				setOpening(finished(account.steamId64))
			);
	};

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
					{/* **Add is the one primary button.** A row of identical secondary
					    buttons gives the eye nowhere to land; adding an account is what a
					    new user is here to do, so it is what looks like an action.

					    Move sits immediately beside it, because the two are the same job
					    with different starting conditions — get an authenticator into this
					    app, whether it exists on a phone already or not. Grouping them is
					    what stops Move being lost among the tools that follow. */}
					<button type="button" onClick={onEnrol}>
						Add authenticator
					</button>
					<button type="button" className="secondary" onClick={onMove}>
						Move from phone
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
					<button type="button" className="secondary" onClick={onMove}>
						Move from phone
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
												disabled={copying.has(account.steamId64)}
												onClick={() => {
													const mine = (copyAttempt.current += 1);
													const newest = (): boolean => copyAttempt.current === mine;
													setCopyError(undefined);
													setCopying(running(account.steamId64));
													onCopyCode(account.steamId64)
														.then((result) => {
															if (!newest()) {
																return;
															}
															setCopied({
																steamId64: account.steamId64,
																seconds: result.clipboardClearsInSeconds
															});
														})
														.catch((err: unknown) => {
															if (!newest()) {
																return;
															}
															setCopied(undefined);
															// The shared helper, not a second copy of the same
															// regex: two of them drift, and this one had already
															// grown a variation the other did not have.
															setCopyError({
																steamId64: account.steamId64,
																message: messageOf(err)
															});
														})
														.finally(() =>
															// Only this account's entry. Clearing the whole set would
															// re-enable every button, including one whose own copy is
															// still in flight.
															setCopying(finished(account.steamId64))
														);
												}}
											>
												{copying.has(account.steamId64)
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
									{/* A browser, signed in as this account and routed like it.

									    The thing it replaces is the reason it exists: finishing a trade
									    used to mean signing in to Steam in an ordinary browser, which
									    puts the machine's own address on an account the user was
									    careful to route — and does it while they are logged in and
									    trading, which is the worst moment for it. */}
									{/* Three buttons when the account is routed, because all three
									    answers are reasonable and only the user knows which they want.

									    A shared proxy address collects rate limits and Cloudflare
									    challenges that a home connection never sees, so the fully routed
									    window is sometimes the one that will not load. Direct fixes that
									    by taking the account's proxy out of the path — which puts
									    whatever address this machine normally uses on the account, and
									    that is what the proxy was for.

									    Note "normally uses" rather than "its own": Direct applies the
									    machine's own network settings, system proxy included, because
									    the token is minted the same way and the two must not disagree.
									    `window.ts` explains at the `system` branch.

									    "Steam only" is the middle answer: Steam and everything
									    unrecognised keep going through the proxy, and a short list of
									    known third-party trade sites goes direct. Those are the pages
									    that make a proxied window unbearable, and none of them is where
									    the account lives. Unknown stays proxied on purpose — see
									    `steamOnlyBypass`. */}
									<button
										type="button"
										className="secondary"
										disabled={opening.has(account.steamId64)}
										title={
											account.hasProxy
												? 'Open a signed-in browser routed through this account’s proxy. Everything in the window goes through it. Starts at your trade offers.'
												: 'Open a signed-in browser for this account. Starts at your trade offers.'
										}
										onClick={() =>
											// A routed account's first button is the fully proxied one. An
											// unrouted account has no proxy to route through, so its only
											// button is the direct one — and saying that outright, rather
											// than passing a route meaning "proxy if there is one", keeps
											// the token mint on the same session the window will use.
											openBrowserAs(account, account.hasProxy ? 'proxy' : 'direct')
										}
									>
										{opening.has(account.steamId64)
											? 'Opening…'
											: account.hasProxy
												? 'Trade (proxied)'
												: 'Trade'}
									</button>
									{/* Both of the alternatives go under `Require proxies`, not just
									    Direct. "Steam only" keeps Steam on the proxy but sends a short
									    list of trade sites straight out from this machine, and a
									    deliberate direct request is the thing that setting forbids. The
									    main process refuses both; this only stops offering them. */}
									{account.hasProxy && !requireProxies && (
										<>
											<button
												type="button"
												className="secondary"
												disabled={opening.has(account.steamId64)}
												title="Open the same browser with Steam — including its image and video hosts — still going through the proxy, while a short list of known trade sites goes direct so they load at full speed. Anything else still goes through the proxy. Steam never sees your real address."
												onClick={() => openBrowserAs(account, 'steam-only')}
											>
												Steam only
											</button>
											<button
												type="button"
												className="secondary"
												disabled={opening.has(account.steamId64)}
												title="Open the same browser without this account’s proxy. Your machine’s own network settings still apply — including a system or company proxy, if this machine has one — so Steam sees whatever address this machine normally uses. Use it when a proxied page is rate-limited or stuck on a Cloudflare check."
												onClick={() => openBrowserAs(account, 'direct')}
											>
												Direct
											</button>
										</>
									)}
									{/* Last, and visually quietest of the three. It is the only one
									    here that destroys something. */}
									{/* Reports what happened. Fire-and-forget made a cancelled save
									    dialog and a real failure look identical — both were silence,
									    which reads as the button not working. */}
									<button
										type="button"
										className="secondary"
										disabled={exporting.has(account.steamId64)}
										onClick={() => {
											const newest = claimExport(account.steamId64);
											setExported(noted(account.steamId64, undefined));
											setExporting(running(account.steamId64));
											onExport(account)
												.then((result) => {
													if (!newest()) {
														return;
													}
													setExported(
														noted(
															account.steamId64,
															result.state === 'saved'
																? // The stale copy is named, because a second plaintext file
																	// nobody mentions is worse than one they can go and delete.
																	`Saved as ${result.fileName}. Treat that file as a key to this account.` +
																		(result.staleCopy
																			? ` The previous export could not be deleted — a file ending “.prev” is still beside it, holding the older secrets. Delete it when you can.`
																			: '')
																: 'Nothing was saved.'
														)
													);
												})
												.catch((err: unknown) => {
													if (!newest()) {
														return;
													}
													setExported(
														noted(account.steamId64, `It could not be saved: ${messageOf(err)}`)
													);
												})
												.finally(() => setExporting(finished(account.steamId64)));
										}}
										title="Save this account as a .maFile, readable by SDA and anything else in the ecosystem. It carries the authenticator secrets in plain text, and it does NOT carry this account's proxy or its Steam session — set the routing again after importing it somewhere else."
									>
										{exporting.has(account.steamId64) ? 'Saving…' : 'Export'}
									</button>
									<button
										type="button"
										className="secondary danger"
										onClick={() => onRemoveAccount(account)}
										title="Remove this account from the vault. Does not remove it from Steam."
									>
										Remove
									</button>
									{exported.has(account.steamId64) && (
										<p className="hint">{exported.get(account.steamId64)}</p>
									)}
									{browserError.has(account.steamId64) && (
										<p className="hint bad">{browserError.get(account.steamId64)}</p>
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
											// **Only approving earns the warning colour.** Watching an
											// account changes nothing without a person, so colouring it
											// the same as "trades are approved unattended" would spend
											// the one signal that ought to mean exactly that.
											account.autoConfirm.trades || account.autoConfirm.marketListings
												? 'flag warn actionable'
												: 'flag actionable'
										}
										onClick={() => onChangeAutoConfirm(account)}
										title="Approve trades or market listings without asking, or just be told about them. Both off by default."
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
					<CompanyMark size={30} className="powered-logo" />
					<span className="powered-words">
						<span className="powered-lead">Powered by</span>
						<span className="powered-name">{branding.companyShort}</span>
					</span>
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

/**
 * What this account does on its own.
 *
 * **Watching is a real state and used to read as "off".** With notifications
 * available on their own, an account being polled every fifteen seconds and
 * raising toasts printed `auto-confirm: off` — which is true about
 * auto-confirm and wrong about the account, and it is the reading that would
 * make somebody switch a feature on twice.
 *
 * Approving is named first wherever it applies, because it is the part with
 * consequences. Notifications are mentioned but never lead.
 */
export function describeAutoConfirm(settings: AccountSummary['autoConfirm']): string {
	const watching = settings.notify.enabled;

	if (settings.trades && settings.marketListings) {
		return watching ? 'auto-confirm: trades + market, notifying' : 'auto-confirm: trades + market';
	}
	// Trades first when only one is on: it is the consequential one.
	if (settings.trades) {
		return watching ? 'auto-confirm: trades, notifying' : 'auto-confirm: trades';
	}
	if (settings.marketListings) {
		return watching ? 'auto-confirm: market, notifying' : 'auto-confirm: market';
	}
	// Nothing is approved here, so the word "auto-confirm" would be misleading
	// whichever value followed it.
	return watching ? 'notifying, approving nothing' : 'auto-confirm: off';
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
