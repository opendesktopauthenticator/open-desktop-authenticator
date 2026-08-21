import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountSummary, ActivityList } from '../../shared/ipc';
import { messageOf } from '../ipc-message';

/**
 * What automatic confirmation did while nobody was watching.
 *
 * The order is not chronological-first: **held** entries come before everything
 * else, because a refused account-recovery confirmation means somebody may be
 * taking the account and it must not be N rows down a feed of routine approvals.
 *
 * This is deliberately a record of *what happened*, not a control surface. The
 * only action offered is going to the account, because deciding what to do about
 * a held confirmation happens on the confirmations screen where the deny button
 * lives.
 */
export function Activity({
	accounts,
	onLoad,
	onOpenAccount,
	onSeen,
	onClose
}: {
	accounts: AccountSummary[];
	onLoad: () => Promise<ActivityList>;
	onOpenAccount: (account: AccountSummary) => void;
	/**
	 * Discharge the "needs you" alert, for the snapshot just rendered and no more.
	 *
	 * @param upTo the loaded list's own high-water mark. Listing and acknowledging
	 * are separate round trips, and an automatic pass finishing between them must
	 * not be marked seen by somebody who was never shown it.
	 */
	onSeen: (upTo: number) => void;
	onClose: () => void;
}): React.JSX.Element {
	const [activity, setActivity] = useState<ActivityList | undefined>();
	const [error, setError] = useState<string | undefined>();

	// Held in a ref, effect run once: the parent re-renders every second and a
	// dependency on the prop identity would refetch at 1 Hz.
	const loadRef = useRef(onLoad);
	useEffect(() => {
		loadRef.current = onLoad;
	}, [onLoad]);

	// Once, on open. Held in a ref and depended on with an empty array for the
	// same reason the discard effect in the import screen is: the parent re-renders
	// every second and hands down a fresh closure, and re-running this on each of
	// those would be indistinguishable from acknowledging on a timer.
	const seenRef = useRef(onSeen);
	useEffect(() => {
		seenRef.current = onSeen;
	}, [onSeen]);
	/** So a re-render, or a retry after a success, cannot acknowledge twice. */
	const acknowledged = useRef(false);

	/**
	 * Whether this screen is still on screen. The mount effect has its own
	 * `cancelled` flag, but the retry path had nothing: press Try again, then
	 * Back before the promise resolves, and the continuation still acknowledged
	 * — React swallowed the state update, but the IPC ran, clearing a held
	 * account-recovery warning nobody was shown.
	 */
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	/** One place both load paths go through, so neither can forget. */
	const markSeen = useCallback((upTo: number): void => {
		// Never after unmount. Both load paths funnel through here, so this is the
		// one place the guard cannot be forgotten by a future third path.
		if (acknowledged.current || !alive.current) {
			return;
		}
		acknowledged.current = true;
		seenRef.current(upTo);
	}, []);

	/**
	 * Shared by the first load and the retry, because a failed load must offer the
	 * way out of itself. Without one the screen showed an error over a permanent
	 * "Loading…" and the only control was Back.
	 */
	const load = useCallback((): void => {
		setError(undefined);
		loadRef
			.current()
			.then((loaded) => {
				if (!alive.current) {
					return;
				}
				setActivity(loaded);
				// **Acknowledged here too.** This is the "Try again" the error state
				// offers, and it was the one path that rendered entries without ever
				// discharging the alert — so a first load that failed left the "needs
				// you" badge lit for the rest of the session, however many times the
				// user read the list.
				markSeen(loaded.seq);
			})
			.catch((err: unknown) => setError(messageOf(err)));
	}, [markSeen]);

	useEffect(() => {
		let cancelled = false;
		loadRef
			.current()
			.then((loaded) => {
				if (!cancelled) {
					setActivity(loaded);
					// **Acknowledged here, with the entries in hand — not in an effect of
					// its own.**
					//
					// It used to sit in a separate effect declared above this one, so
					// React ran it first and the alert was cleared before the list had
					// even been requested. A load that failed, hung, or was abandoned by
					// pressing Back cleared it anyway — and what it clears is the marker
					// saying an account-recovery confirmation was held back.
					//
					// Clearing it now is honest: `setActivity` has the data, so this
					// render draws it.
					// `loaded.seq`, not "now": this is the extent of what is on screen.
					markSeen(loaded.seq);
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
		// `markSeen` is stable — empty deps, refs inside — so naming it here costs
		// nothing and keeps the mount effect from re-running.
	}, [markSeen]);

	const nameOf = (steamId64: string): string =>
		accounts.find((entry) => entry.steamId64 === steamId64)?.accountName ?? steamId64;

	const open = (steamId64: string): void => {
		const account = accounts.find((entry) => entry.steamId64 === steamId64);
		if (!account) {
			// The log outlives the accounts it describes — entries survive an account
			// being removed, which is often exactly what somebody is here to read
			// about. The button then pointed at nothing and did nothing at all, with
			// no way to tell that from the app being broken.
			setError(
				`${steamId64} is no longer in this vault, so there is nothing to open. Its entries stay ` +
					'here so you can still see what happened.'
			);
			return;
		}
		setError(undefined);
		onOpenAccount(account);
	};

	const entries = activity?.entries ?? [];
	const urgent = entries.filter(
		({ entry }) =>
			(entry.kind === 'held' && entry.confirmation.securityCritical) ||
			entry.kind === 'halted' ||
			// An entry that failed to parse has no type, so it cannot be ruled out as
			// the account-recovery confirmation. It belongs with the things a person
			// has to look at, not in the ordinary list below.
			entry.kind === 'unreadable'
	);
	const rest = entries.filter((candidate) => !urgent.includes(candidate));

	return (
		<main className="shell">
			<header className="row">
				<h1>Activity</h1>
				<button type="button" className="secondary" onClick={onClose}>
					Back
				</button>
			</header>

			<p className="muted">
				Kept in memory only, and only for this session — it answers &ldquo;what happened while I was
				away&rdquo;, not &ldquo;what did I trade last month&rdquo;. Nothing here is written to disk.
			</p>

			{error && <p className="error">{error}</p>}

			{urgent.map(({ steamId64, entry }, index) => (
				<div className="ceremony" key={`${index}-${entry.at}`}>
					{entry.kind === 'held' ? (
						<>
							<h2>{entry.confirmation.typeName} was NOT approved — check this</h2>
							<p>
								{nameOf(steamId64)} · {formatTime(entry.at)}
							</p>
							<p>{entry.reason}</p>
							<p>If you did not start this yourself, deny it and change your Steam password now.</p>
						</>
					) : entry.kind === 'unreadable' ? (
						<>
							<h2>
								{entry.count === 1
									? 'A confirmation could not be read'
									: `${entry.count} confirmations could not be read`}
							</h2>
							<p>
								{nameOf(steamId64)} · {formatTime(entry.at)}
							</p>
							<p>
								Steam sent {entry.count === 1 ? 'a confirmation' : 'confirmations'} in a shape this
								version does not recognise, so automatic confirmation skipped{' '}
								{entry.count === 1 ? 'it' : 'them'}. This app may need an update.
							</p>
							<p>
								<strong>Open the account and check by hand.</strong> Nothing here can tell what the
								skipped {entry.count === 1 ? 'confirmation was' : 'confirmations were'}, which is
								why it is being shown to you rather than passed over.
							</p>
						</>
					) : (
						// Narrowed explicitly: the filtered list keeps the full union, and
						// only these kinds reach this block.
						entry.kind === 'halted' && (
							<>
								<h2>Automatic confirmation stopped</h2>
								<p>
									{nameOf(steamId64)} · {formatTime(entry.at)}
								</p>
								<p>{entry.reason}</p>
							</>
						)
					)}
					<div className="controls">
						<button type="button" onClick={() => open(steamId64)}>
							Open {nameOf(steamId64)}
						</button>
					</div>
				</div>
			))}

			{/* Suppressed when the load failed. A request that has already finished,
			    shown as still in flight, is what makes a screen read as hung. */}
			{activity === undefined ? (
				error === undefined ? (
					<p className="muted">Loading…</p>
				) : (
					<div className="controls">
						<button type="button" className="secondary" onClick={load}>
							Try again
						</button>
					</div>
				)
			) : entries.length === 0 ? (
				<div className="empty">
					<h2>Nothing yet</h2>
					<p>
						Automatic confirmation has not done anything. If you have not switched it on for an
						account, it never will — that is the default.
					</p>
				</div>
			) : (
				rest.length > 0 && (
					<>
						<h2>Earlier</h2>
						<ul className="accounts">
							{rest.map(({ steamId64, entry }, index) => (
								<li key={`${index}-${entry.at}`}>
									<div>
										<strong>{nameOf(steamId64)}</strong>
										<span className="muted"> {formatTime(entry.at)}</span>
										<p className="hint">{describe(entry)}</p>
									</div>
								</li>
							))}
						</ul>
					</>
				)
			)}
		</main>
	);
}

function describe(entry: ActivityList['entries'][number]['entry']): string {
	switch (entry.kind) {
		case 'approved':
			return `Approved ${entry.confirmations.length}: ${entry.confirmations
				.map((confirmation) => confirmation.headline ?? confirmation.typeName)
				.join(', ')}`;
		case 'held':
			return `Held back — ${entry.reason}`;
		case 'failed':
			return `Could not check — ${entry.reason}`;
		case 'unreadable':
			// Reached only if this kind stops being treated as urgent above. Written
			// out rather than left to the `default`, which assumed every remaining
			// kind carries a `reason`.
			return entry.count === 1
				? 'One confirmation could not be read and was skipped'
				: `${entry.count} confirmations could not be read and were skipped`;
		default:
			return entry.reason;
	}
}

/** Local time, seconds included: "when exactly" is the question being asked. */
function formatTime(iso: string): string {
	const at = new Date(iso);
	return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}
