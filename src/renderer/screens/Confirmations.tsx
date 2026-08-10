import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountSummary, ConfirmationsList, ConfirmationSummary } from '../../shared/ipc';
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
	onSignIn: (password: string) => Promise<unknown>;
	onClose: () => void;
}): React.JSX.Element {
	const [confirmations, setConfirmations] = useState<ConfirmationSummary[] | undefined>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	/**
	 * Set when Steam says the saved session is gone. Kept separate from `error`
	 * because it is not a failure to report — it is a thing the user can fix, and
	 * the screen turns into the way to fix it.
	 */
	const [signInReason, setSignInReason] = useState<string | undefined>();

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

	/** Used by the Refresh button, where showing "working" is the whole point. */
	const refresh = useCallback((): void => {
		if (busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		listRef
			.current()
			.then((result) => {
				setConfirmations(result.confirmations);
				setSignInReason(result.signInRequired ? (result.reason ?? '') : undefined);
			})
			.catch((err: unknown) => setError(messageOf(err)))
			.finally(() => setBusy(false));
	}, [busy]);

	// Fetch once per account. The screen already says "Asking Steam…" while
	// `confirmations` is undefined, so no busy flag is set synchronously here.
	const steamId64 = account.steamId64;
	useEffect(() => {
		let cancelled = false;
		listRef
			.current()
			.then((result) => {
				if (!cancelled) {
					setConfirmations(result.confirmations);
					setSignInReason(result.signInRequired ? (result.reason ?? '') : undefined);
				}
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setError(messageOf(err));
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
		onAct(action, ids)
			.then(() => refresh())
			.catch((err: unknown) => {
				setError(messageOf(err));
				setBusy(false);
			});
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

			{error && <p className="error">{error}</p>}

			{signInReason !== undefined && (
				<SteamSignIn
					accountName={account.accountName}
					{...(signInReason === '' ? {} : { reason: signInReason })}
					onSignIn={async (password) => {
						await onSignIn(password);
						// Straight into the list the user came here for, rather than
						// leaving them on a form that has served its purpose.
						setSignInReason(undefined);
						refresh();
					}}
					onCancel={onClose}
				/>
			)}

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

			{signInReason !== undefined ? null : confirmations === undefined ? (
				<p className="muted">Asking Steam…</p>
			) : confirmations.length === 0 ? (
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
