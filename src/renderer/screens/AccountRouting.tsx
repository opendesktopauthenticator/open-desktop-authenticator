import { useState } from 'react';
import type { AccountSummary } from '../../shared/ipc';
import { messageOf } from '../ipc-message';

/**
 * Per-account network routing (§10.1).
 *
 * **Routing is optional and always removable.** An account with none connects
 * the way everything else on this machine does; nothing about the app requires a
 * proxy, and no feature is withheld from an account that has none. This screen
 * exists mostly so that the opposite is also true — a proxy that arrived inside
 * an imported maFile, possibly long dead, can be replaced or taken off entirely
 * rather than silently breaking that account forever.
 *
 * The address is never displayed back. It routinely contains a username and
 * password, and a field that helpfully shows you the credentials you saved is a
 * field that shows them to whoever is behind you. The screen reports only
 * *whether* routing is configured; changing it means typing the whole address
 * again, which is the honest cost of not storing it anywhere it can be read.
 */
export function AccountRouting({
	account,
	onSave,
	onClose
}: {
	account: AccountSummary;
	onSave: (proxyUrl: string | null) => Promise<unknown>;
	onClose: () => void;
}): React.JSX.Element {
	const [address, setAddress] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const save = (proxyUrl: string | null): void => {
		if (busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		onSave(proxyUrl)
			.then(() => onClose())
			.catch((err: unknown) => setError(messageOf(err)))
			.finally(() => setBusy(false));
	};

	return (
		<main className="shell">
			<header className="row">
				<h1>Routing</h1>
				<button type="button" className="secondary" onClick={onClose} disabled={busy}>
					Back
				</button>
			</header>

			<p className="muted">
				{account.accountName} <span className="muted">{account.steamId64}</span>
			</p>

			{/* What is **known**, not what is configured. `hasProxy` only says a URL is
			    stored; this screen used it to claim the account "currently connects
			    through a proxy", which is false when routing is blocked — the account
			    then connects to nothing at all, by design — and unfounded when nothing
			    has been checked yet. The home screen already draws this distinction,
			    so the two disagreed about the same account. */}
			<p className="muted">
				{!account.hasProxy
					? 'This account connects directly, like everything else on this machine.'
					: account.routing === 'verified'
						? `This account is routed, and that was checked${
								account.routedVia ? ` — traffic left through ${account.routedVia}` : ''
							}.`
						: account.routing === 'blocked'
							? 'This account is configured to route, and the route was refused, so it is ' +
								'connecting to nothing. It fails closed rather than falling back.'
							: 'This account is configured to route. Nothing has connected yet, so whether ' +
								'the proxy is actually applied is not yet known.'}
			</p>
			{account.routing === 'blocked' && account.routingProblem && (
				<p className="hint bad">{account.routingProblem}</p>
			)}

			{error && <p className="error">{error}</p>}

			<form
				onSubmit={(event) => {
					event.preventDefault();
					save(address.trim());
				}}
			>
				<label htmlFor="proxy-address">Proxy address</label>
				<input
					id="proxy-address"
					type="password"
					value={address}
					onChange={(event) => setAddress(event.target.value)}
					placeholder="socks5://host:1080"
					autoComplete="off"
					spellCheck={false}
					disabled={busy}
				/>
				<p className="hint">
					<code>http</code>, <code>https</code> or <code>socks5</code>. Masked as you type because
					it usually contains a password.
				</p>
				<p className="hint">
					If this proxy stops working, this account stops connecting — it will never quietly fall
					back to your own address.
				</p>

				<div className="controls">
					<button type="submit" disabled={busy || address.trim() === ''}>
						{busy ? 'Saving…' : 'Use this proxy'}
					</button>
					{account.hasProxy && (
						<button type="button" className="secondary" onClick={() => save(null)} disabled={busy}>
							Stop routing this account
						</button>
					)}
				</div>
			</form>

			<div className="notice">
				<strong>Whoever runs the proxy sees this account&rsquo;s traffic.</strong> They cannot read
				your codes or your vault, but they can see that a Steam account connects through them and
				when. Use one you would trust with that, or none at all.
			</div>
		</main>
	);
}
