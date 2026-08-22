import { useCallback, useEffect, useRef, useState } from 'react';
import type {
	AccountSummary,
	ConfirmationsList,
	ConfirmationSummary,
	SignInResult
} from '../../shared/ipc';
import { messageOf } from '../ipc-message';
import { SteamSignIn } from './SteamSignIn';

/**
 * Pending mobile confirmations for one account (§12 F5).
 *
 * Two things shape this screen, both from F-12:
 *
 *  - **An account-recovery confirmation is not a list item.** It means somebody
 *    may be taking the account, and it is the strongest warning this application
 *    will ever be able to give. It gets its own block, above everything else,
 *    and it can only be acted on by itself.
 *  - **The type shown is ours.** Steam sends its own label; a name the server
 *    chooses is a name an attacker can choose, and this is the text the user
 *    reads before approving something.
 *
 * Approving in bulk is offered only for ordinary confirmations. That is the same
 * rule the main process enforces — this just avoids presenting a button that
 * would be refused.
 */
/**
 * The warning that the list on this screen is not all of it.
 *
 * Exported and pure so it can be asserted directly. The screen derives `count`
 * from a fetch inside an effect, and the renderer tests here render statically —
 * so a warning reachable only through that effect is a warning no test can see,
 * on the one piece of this screen whose entire job is to be seen.
 *
 * Renders nothing at zero rather than making every caller guard, so "no
 * unreadable entries" cannot accidentally draw an empty box.
 */
export function IncompleteListNotice({ count }: { count: number }): React.JSX.Element | null {
	if (count <= 0) {
		return null;
	}

	const one = count === 1;
	return (
		<div className="notice">
			<strong>
				{one ? 'One confirmation could not be read' : `${count} confirmations could not be read`}
			</strong>
			<p>
				Steam sent {one ? 'a confirmation' : 'confirmations'} in a shape this version does not
				recognise, so {one ? 'it is' : 'they are'} not shown here. That usually means Steam has
				changed something and this app needs an update — check Settings.
			</p>
			<p>
				Until then, <strong>treat this list as incomplete.</strong> If you were not expecting any
				activity on this account, check it in the Steam mobile app as well.
			</p>
		</div>
	);
}

export function Confirmations({
	account,
	onList,
	onAct,
	onSignIn,
	onClose
}: {
	account: AccountSummary;
	onList: () => Promise<ConfirmationsList>;
	onAct: (action: 'allow' | 'cancel', ids: string[]) => Promise<unknown>;
	onSignIn: (password: string) => Promise<SignInResult>;
	onClose: () => void;
}): React.JSX.Element {
	const [confirmations, setConfirmations] = useState<ConfirmationSummary[] | undefined>();
	/**
	 * Starts true, because this screen always fetches on mount.
	 *
	 * Refresh used to be pressable during that first fetch, so the two raced and
	 * the last writer won — a slow first list could overwrite, and hide, an
	 * account-recovery confirmation Refresh had already put on screen. Starting
	 * busy disables the button for exactly as long as the fetch runs, without a
	 * synchronous `setState` inside the effect.
	 */
	const [busy, setBusy] = useState(true);
	/**
	 * How many lists are in flight, readable without a render.
	 *
	 * `busy` drives the button; this is what `refresh` actually tests, so the
	 * guard holds even on a re-fetch triggered by the account changing, where
	 * state has not been re-raised.
	 *
	 * **A count, not a boolean.** A boolean was cleared by whichever fetch
	 * finished first, and under StrictMode the mount effect runs twice — so the
	 * first run's `finally` unlocked the guard while the second run's fetch was
	 * still going, reopening the very race this closes. Starts at one because
	 * the mount effect below is already counted.
	 */
	const listing = useRef(1);
	/** Whether the mount effect below is on its first run — see `listing`. */
	const first = useRef(true);
	const [error, setError] = useState<string | undefined>();
	/**
	 * Set when Steam says the saved session is gone. Kept separate from `error`
	 * because it is not a failure to report — it is a thing the user can fix, and
	 * the screen turns into the way to fix it.
	 */
	const [signInReason, setSignInReason] = useState<string | undefined>();
	/**
	 * Confirmations Steam sent that this build could not read.
	 *
	 * Shown rather than logged. Every other state on this screen describes a list
	 * we can vouch for; this is the one that says the list is incomplete, and a
	 * user deciding whether anything is wrong with their account needs to know
	 * that before they read "Nothing pending" as an all-clear.
	 */
	const [unreadable, setUnreadable] = useState(0);

	/**
	 * The callbacks live in a ref, and the effect below depends on the **account**
	 * rather than on them.
	 *
	 * The parent re-renders once a second — it polls vault status to drive the
	 * auto-lock countdown — and hands down a fresh arrow function each time. An
	 * effect depending on that identity re-ran every second, so simply having this
	 * screen open asked Steam for the confirmation list **once per second**.
	 * Steam rate-limits mobileconf; an authenticator that hammers it is one that
	 * gets its user throttled.
	 */
	const listRef = useRef(onList);
	useEffect(() => {
		listRef.current = onList;
	}, [onList]);

	/**
	 * Fetch the list. **Does not touch `busy`**, and that separation is the point.
	 *
	 * `act` used to finish by calling the busy-guarded `refresh`, which only worked
	 * because the callback it captured had been created on a render where `busy`
	 * was still false. Had that closure ever been current, `refresh` would have
	 * seen `busy === true`, returned immediately, and left the flag set — Back and
	 * Refresh disabled for as long as the screen stayed open, with no way to clear
	 * it. Every caller now owns its own busy handling and shares this.
	 */
	const load = useCallback(async (): Promise<void> => {
		const result = await listRef.current();
		// **`undefined`, not the empty array the handler sends.** When Steam wants a
		// sign-in the response carries `confirmations: []` — not a list, an absence.
		// Storing it as a list meant that the moment `signInReason` cleared, the
		// screen rendered "Nothing pending — this was checked just now" about an
		// account it had not been able to ask.
		setConfirmations(result.signInRequired ? undefined : result.confirmations);
		setSignInReason(result.signInRequired ? (result.reason ?? '') : undefined);
		setUnreadable(result.signInRequired ? 0 : result.unreadable);
	}, []);

	/** Used by the Refresh button, where showing "working" is the whole point. */
	const refresh = useCallback((): void => {
		if (busy || listing.current > 0) {
			return;
		}
		listing.current += 1;
		setBusy(true);
		setError(undefined);
		load()
			.catch((err: unknown) => setError(messageOf(err)))
			.finally(() => {
				listing.current -= 1;
				setBusy(false);
			});
	}, [busy, load]);

	// Fetch once per account. The screen already says "Asking Steam…" while
	// `confirmations` is undefined, so no busy flag is set synchronously here.
	const steamId64 = account.steamId64;
	useEffect(() => {
		let cancelled = false;
		// The ref, not `setBusy` — a synchronous `setState` in an effect triggers
		// a cascading render, and `busy` already starts true (and the count at
		// one) for the mount case. This covers the re-fetch when the account
		// changes, and the second run of StrictMode's double invoke.
		if (!first.current) {
			listing.current += 1;
		}
		first.current = false;
		listRef
			.current()
			.then((result) => {
				if (!cancelled) {
					// Guarded exactly as `load` guards it. This path stored the empty
					// array the sign-in response carries, so the moment `signInReason`
					// cleared the screen said "Nothing pending — checked just now" about
					// an account it had never managed to ask. `load` was fixed for that
					// and the first fetch was left behind.
					setConfirmations(result.signInRequired ? undefined : result.confirmations);
					setSignInReason(result.signInRequired ? (result.reason ?? '') : undefined);
					setUnreadable(result.signInRequired ? 0 : result.unreadable);
				}
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setError(messageOf(err));
				}
			})
			.finally(() => {
				listing.current -= 1;
				if (!cancelled) {
					setBusy(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [steamId64]);

	const act = (action: 'allow' | 'cancel', ids: string[]): void => {
		if (busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		// One `finally`, covering both the action and the reload after it. The
		// previous shape cleared the flag in the failure branch and relied on
		// `refresh` to clear it in the success branch, which put the only path out
		// of "Working…" inside a function that could decline to run.
		onAct(action, ids)
			.then(() => load())
			.catch((err: unknown) => setError(messageOf(err)))
			.finally(() => setBusy(false));
	};

	const critical = confirmations?.filter((entry) => entry.securityCritical) ?? [];
	const ordinary = confirmations?.filter((entry) => !entry.securityCritical) ?? [];

	// Kept in state and ticked slowly, rather than read during render — reading
	// the clock while rendering is impure, and React is right to object. Half a
	// minute is ample: this drives "12 minutes ago", which does not need
	// per-second resolution, and a frozen value would age into a lie while the
	// screen sits open.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, []);

	return (
		<main className="shell">
			<header className="row">
				<h1>Confirmations</h1>
				<div className="controls">
					<button type="button" className="secondary" onClick={refresh} disabled={busy}>
						{busy ? 'Working…' : 'Refresh'}
					</button>
					{/* Disabled while an approve or deny is in flight. Leaving does not
					    recall it — Steam has already been told — and letting the user
					    walk away believing otherwise is the worst of both. */}
					<button type="button" className="secondary" onClick={onClose} disabled={busy}>
						Back
					</button>
				</div>
			</header>

			<p className="muted">
				{account.accountName} <span className="muted">{account.steamId64}</span>
			</p>

			{error && (
				<>
					<p className="error">{error}</p>
					{/* A failed load must offer the way out of itself. The header Refresh
					    does the same job, but it reads as a routine control rather than
					    the answer to the red text directly above it — and a screen whose
					    only visible options are an error and Back reads as broken. */}
					<div className="controls">
						<button type="button" className="secondary" onClick={refresh} disabled={busy}>
							{busy ? 'Working…' : 'Try again'}
						</button>
					</div>
				</>
			)}

			{signInReason !== undefined && (
				<SteamSignIn
					accountName={account.accountName}
					{...(signInReason === '' ? {} : { reason: signInReason })}
					onSignIn={async (password) => {
						const result = await onSignIn(password);
						// **Only on success.** A failure is now returned rather than
						// thrown, so advancing unconditionally would clear the form and
						// reload as though the sign-in had worked — the outcome reported
						// back to `SteamSignIn`, which shows it, would never be seen.
						if (!result.ok) {
							return result;
						}
						// Straight into the list the user came here for, rather than
						// leaving them on a form that has served its purpose.
						//
						// Cleared together. Leaving the old list in place while the reload
						// runs shows a stale answer under a fresh heading — and when the
						// old "list" is the empty array the sign-in response carried, that
						// stale answer is "Nothing pending, checked just now" about an
						// account this app had not been able to ask.
						setConfirmations(undefined);
						setSignInReason(undefined);
						refresh();
						return result;
					}}
					onCancel={onClose}
				/>
			)}

			{/* Above the confirmations, not below them: this says the list underneath
			    is incomplete, and a warning placed after the list has already let the
			    reader finish forming their conclusion. Suppressed during sign-in,
			    where there is no list for it to qualify. */}
			{signInReason === undefined && <IncompleteListNotice count={unreadable} />}

			{critical.map((entry) => (
				<div className="ceremony" key={entry.id}>
					<h2>{entry.typeName} — check this carefully</h2>
					<p>
						Somebody is asking to change something about this account&rsquo;s security. If that was
						not you, <strong>deny it</strong> and change your Steam password immediately.
					</p>
					{entry.headline && <p>{entry.headline}</p>}
					{entry.summary?.map((line, index) => (
						<p key={`${index}-${line.slice(0, 24)}`} className="hint">
							{line}
						</p>
					))}
					<ConfirmationDetail entry={entry} now={now} />
					<div className="controls">
						<button type="button" onClick={() => act('cancel', [entry.id])} disabled={busy}>
							Deny — this was not me
						</button>
						<button
							type="button"
							className="secondary"
							onClick={() => act('allow', [entry.id])}
							disabled={busy}
						>
							Approve — I asked for this
						</button>
					</div>
				</div>
			))}

			{/* Three states, not two, and the third one matters more than it looks.

			    A failed load used to leave `confirmations` undefined, which rendered
			    "Asking Steam…" underneath the error — a request that had already
			    finished, shown as still in flight, so the screen read as hung.

			    The obvious repair is to set an empty list on failure, and it is worse:
			    the empty state says "Nothing pending — this was checked just now", and
			    an authenticator that reports no pending trades when it does not know is
			    making a false statement about exactly the thing it exists to report.

			    So the loading line is suppressed when there is an error, and neither
			    the list nor the empty state is shown. The error and its Try again are
			    the whole answer. */}
			{signInReason !== undefined ? null : confirmations === undefined ? (
				error === undefined ? (
					<p className="muted">Asking Steam…</p>
				) : null
			) : confirmations.length === 0 && error === undefined && unreadable === 0 ? (
				// **`unreadable === 0` is part of the condition, not decoration.** This
				// block states that nothing is pending and that the answer is fresh. With
				// entries we could not read, the first half is a claim this screen is in
				// no position to make — the warning above is the whole answer instead.
				<div className="empty">
					<h2>Nothing pending</h2>
					<p>
						Trades and market listings waiting for approval show up here. This was checked just now
						— it is not a cached answer.
					</p>
				</div>
			) : (
				ordinary.length > 0 && (
					<>
						<h2>Waiting for you</h2>
						<ul className="accounts">
							{ordinary.map((entry) => (
								<li key={entry.id}>
									<div>
										<strong>{entry.typeName}</strong>
										{entry.headline && <span className="muted"> {entry.headline}</span>}
										{entry.summary?.map((line, index) => (
											<p key={`${index}-${line.slice(0, 24)}`} className="hint">
												{line}
											</p>
										))}
										<ConfirmationDetail entry={entry} now={now} />
									</div>
									<div className="controls">
										<button
											type="button"
											className="secondary"
											onClick={() => act('allow', [entry.id])}
											disabled={busy}
										>
											Approve
										</button>
										<button
											type="button"
											className="secondary"
											onClick={() => act('cancel', [entry.id])}
											disabled={busy}
										>
											Deny
										</button>
									</div>
								</li>
							))}
						</ul>

						{ordinary.length > 1 && (
							<div className="controls">
								<button
									type="button"
									onClick={() =>
										act(
											'allow',
											ordinary.map((entry) => entry.id)
										)
									}
									disabled={busy}
								>
									Approve all {ordinary.length}
								</button>
								<p className="hint">
									Only the ordinary ones above. Anything security-related has to be handled on its
									own.
								</p>
							</div>
						)}
					</>
				)
			)}
		</main>
	);
}

/**
 * Everything Steam told us about a confirmation, laid out as facts.
 *
 * The protocol carries more than a headline and a summary, and hiding the rest
 * costs the user the two things most likely to reveal a confirmation they did
 * not create: **when it appeared**, and **who it is from**. A trade that showed
 * up at 04:00 while you were asleep is the shape of an account takeover, and no
 * amount of item detail says that as clearly as a timestamp.
 *
 * Two deliberate omissions:
 *
 * - **Steam's own type label is shown, but never as the title.** A name the
 *   server chooses is a name an attacker can choose. Ours comes from the
 *   numeric type via S16's table and is what the heading says; Steam's is
 *   reported beside it, attributed, so a mismatch is visible rather than
 *   authoritative.
 * - **The item image is not rendered.** Steam sends a CDN URL, and an `<img>`
 *   is a request the renderer makes itself — outside the per-account transport,
 *   so from the user's real address for a routed account, telling Valve's CDN
 *   which confirmations were being looked at. The main process therefore sends
 *   only whether an image exists.
 */
function ConfirmationDetail({
	entry,
	now
}: {
	entry: ConfirmationSummary;
	now: number;
}): React.JSX.Element {
	const facts: { label: string; value: string; title?: string }[] = [];

	if (entry.createdAtMs !== undefined) {
		facts.push({
			label: 'Requested',
			value: describeAge(entry.createdAtMs, now),
			title: new Date(entry.createdAtMs).toLocaleString()
		});
	}
	if (entry.creatorId !== undefined) {
		facts.push({ label: 'From', value: entry.creatorId });
	}
	if (entry.multi === true) {
		facts.push({ label: 'Covers', value: 'several items' });
	}
	if (entry.steamTypeName !== undefined && entry.steamTypeName !== entry.typeName) {
		facts.push({
			label: 'Steam calls this',
			value: entry.steamTypeName,
			title:
				'Steam’s own label for this confirmation. We classify it ourselves from the ' +
				'numeric type, because a name the server chooses is a name an attacker can choose.'
		});
	}
	facts.push({ label: 'Type', value: String(entry.type) });
	facts.push({ label: 'ID', value: entry.id });

	return (
		<dl className="facts">
			{facts.map((fact) => (
				<div key={fact.label}>
					<dt>{fact.label}</dt>
					<dd title={fact.title}>{fact.value}</dd>
				</div>
			))}
			{entry.hasIcon && (
				<div>
					<dt>Image</dt>
					<dd title="Loading it would send a request to Steam's CDN from this machine, outside this account's routing.">
						not loaded, on purpose
					</dd>
				</div>
			)}
		</dl>
	);
}

/**
 * "3 hours ago", from a timestamp.
 *
 * Relative rather than absolute because the question a user is actually asking
 * is "was I awake when this happened", and an exact time makes them do that
 * subtraction themselves. The exact time is on the `title` for when it matters.
 */
function describeAge(atMs: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - atMs) / 1000));
	if (seconds < 60) {
		return 'just now';
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 48) {
		return `${hours} hour${hours === 1 ? '' : 's'} ago`;
	}
	return `${Math.round(hours / 24)} days ago`;
}
