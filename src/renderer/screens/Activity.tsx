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
	onClose
}: {
	accounts: AccountSummary[];
	onLoad: () => Promise<ActivityList>;
	onOpenAccount: (account: AccountSummary) => void;
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

	/**
	 * Shared by the first load and the retry, because a failed load must offer the
	 * way out of itself. Without one the screen showed an error over a permanent
	 * "Loading…" and the only control was Back.
	 */
	const load = useCallback((): void => {
		setError(undefined);
		loadRef
			.current()
			.then((loaded) => setActivity(loaded))
			.catch((err: unknown) => setError(messageOf(err)));
	}, []);

	useEffect(() => {
		let cancelled = false;
		loadRef
			.current()
			.then((loaded) => {
				if (!cancelled) {
					setActivity(loaded);
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
	}, []);

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
			(entry.kind === 'held' && entry.confirmation.securityCritical) || entry.kind === 'halted'
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
					) : (
						// Narrowed explicitly: the filtered list keeps the full union, and
						// only `held` and `halted` reach this block.
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
		default:
			return entry.reason;
	}
}

/** Local time, seconds included: "when exactly" is the question being asked. */
function formatTime(iso: string): string {
	const at = new Date(iso);
	return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}
