import { DynamicError } from '../DynamicError';

/**
 * The Steam session was saved, but the browser did not open.
 *
 * This is deliberately not `SteamSignIn`: asking for the password again would
 * repeat work that already succeeded and misdescribe a browser-window failure
 * as an authentication failure. The only retry here repeats the browser open.
 */
export function BrowserOpenRetry({
	accountName,
	busy,
	error,
	onRetry,
	onCancel
}: {
	accountName: string;
	busy: boolean;
	error?: string;
	onRetry: () => void;
	onCancel: () => void;
}): React.JSX.Element {
	return (
		<main className="shell">
			<div className="ceremony">
				<h2>
					{busy
						? 'Steam signed in. Opening the browser…'
						: 'Steam signed in, but the browser did not open'}
				</h2>
				<p>
					The saved Steam session for {accountName} is ready. You do not need to enter the password
					again.
				</p>
			</div>

			{error && <DynamicError id="browser-open-retry-error">{error}</DynamicError>}

			<div className="controls">
				<button type="button" onClick={onRetry} disabled={busy}>
					{busy ? 'Opening…' : 'Try opening the browser again'}
				</button>
				<button type="button" className="secondary" onClick={onCancel} disabled={busy}>
					Back
				</button>
			</div>
		</main>
	);
}
