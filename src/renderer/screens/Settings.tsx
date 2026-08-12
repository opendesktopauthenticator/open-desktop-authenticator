import { useCallback, useEffect, useRef, useState } from 'react';
import type { VaultSettingsView } from '../../shared/ipc';
import { messageOf } from '../ipc-message';

/**
 * The two timings a user can change (§10.3).
 *
 * Both of these were previously fixed at their defaults with no way to reach
 * them, and the auto-lock one matters more than it looks. THREAT_MODEL argues
 * that people who find unlocking painful lengthen their timeout — that is meant
 * to be the pressure valve which stops them disabling locking altogether. With
 * no control, someone who found ten minutes too short had nowhere to go.
 *
 * So the screen states the trade rather than hiding it: a longer timeout is a
 * longer window in which an unattended machine is an unlocked vault, and that is
 * the user's call to make knowingly.
 *
 * Nothing here is a secret, which is why this screen has no passphrase gate —
 * unlike routing, removal, or the revocation reveal.
 */
export function Settings({
	onLoad,
	onSave,
	onClose,
	installedFromStore = false
}: {
	onLoad: () => Promise<VaultSettingsView>;
	onSave: (settings: VaultSettingsView) => Promise<unknown>;
	onClose: () => void;
	/** Store builds are updated by Windows, so the update toggle does nothing there. */
	installedFromStore?: boolean;
}): React.JSX.Element {
	const [settings, setSettings] = useState<VaultSettingsView | undefined>();
	const [busy, setBusy] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | undefined>();

	// The parent re-renders every second to drive the auto-lock countdown, so the
	// loader is held in a ref and the effect runs once. Depending on the prop
	// identity would re-read the settings — and stamp over what the user is
	// currently typing — once per second.
	const loadRef = useRef(onLoad);
	useEffect(() => {
		loadRef.current = onLoad;
	}, [onLoad]);

	/** Shared by the first load and the retry. See the Activity screen for why. */
	const load = useCallback((): void => {
		setError(undefined);
		loadRef
			.current()
			.then((loaded) => setSettings(loaded))
			.catch((err: unknown) => setError(messageOf(err)));
	}, []);

	useEffect(() => {
		let cancelled = false;
		loadRef
			.current()
			.then((loaded) => {
				if (!cancelled) {
					setSettings(loaded);
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

	const submit = (event: React.FormEvent): void => {
		event.preventDefault();
		if (busy || !settings) {
			return;
		}
		setBusy(true);
		setError(undefined);
		setSaved(false);
		onSave(settings)
			.then(() => setSaved(true))
			.catch((err: unknown) => setError(messageOf(err)))
			.finally(() => setBusy(false));
	};

	const change = (patch: Partial<VaultSettingsView>): void => {
		setSaved(false);
		setSettings((previous) => (previous ? { ...previous, ...patch } : previous));
	};

	return (
		<main className="shell">
			<header className="row">
				<h1>Settings</h1>
				<button type="button" className="secondary" onClick={onClose} disabled={busy}>
					Back
				</button>
			</header>

			{error && <p className="error">{error}</p>}

			{settings === undefined ? (
				error === undefined ? (
					<p className="muted">Loading…</p>
				) : (
					<div className="controls">
						<button type="button" className="secondary" onClick={load}>
							Try again
						</button>
					</div>
				)
			) : (
				<form onSubmit={submit}>
					<label htmlFor="auto-lock">Lock the vault after</label>
					<input
						id="auto-lock"
						type="number"
						min={1}
						max={240}
						value={settings.autoLockMinutes}
						onChange={(event) =>
							change({ autoLockMinutes: Number.parseInt(event.target.value, 10) || 1 })
						}
					/>
					<p className="hint">
						Minutes of no interaction, between 1 and 240. A longer setting means a longer window in
						which walking away leaves the vault open — but it is better than finding unlocking so
						tedious that you stop locking at all.
					</p>

					<label htmlFor="clipboard-clear">Clear a copied code after</label>
					<input
						id="clipboard-clear"
						type="number"
						min={5}
						max={300}
						value={settings.clipboardClearSeconds}
						onChange={(event) =>
							change({ clipboardClearSeconds: Number.parseInt(event.target.value, 10) || 5 })
						}
					/>
					<p className="hint">
						Seconds, between 5 and 300. Only ever clears the code we put there — anything you copied
						since is left alone.
					</p>

					<h2>Update checks</h2>
					<UpdateCheckSetting
						installedFromStore={installedFromStore}
						checked={settings.updateCheck}
						onChange={(updateCheck) => change({ updateCheck })}
					/>

					<div className="controls">
						<button type="submit" disabled={busy}>
							{busy ? 'Saving…' : 'Save'}
						</button>
						{saved && <span className="hint">Saved.</span>}
					</div>
				</form>
			)}

			<div className="notice">
				Launching at startup, starting minimised, and unlocking without the passphrase are in the
				vault format but not implemented, so they are not offered here. A switch that appears to
				work and does nothing is worse than no switch.
			</div>
		</main>
	);
}

/**
 * The update-check control, or the reason there is not one.
 *
 * Split out of the screen so it can be rendered on its own in a test. `Settings`
 * loads asynchronously and shows nothing until its first answer arrives, so
 * `renderToStaticMarkup` of the whole screen returns a loading state and asserts
 * on nothing — the same reason `About` was split into a loader and a view. Only
 * the branching part is extracted here rather than the whole form, because only
 * the branching part has two outcomes worth proving.
 *
 * **No toggle in a Store build.** The check is refused before it ever reads this
 * preference, so the switch would change nothing and the text beside it would
 * describe a request to GitHub that is never made. It is the same reasoning as
 * the notice at the foot of this screen: a control that appears to do something
 * it does not is worse than no control at all.
 */
export function UpdateCheckSetting({
	installedFromStore,
	checked,
	onChange
}: {
	installedFromStore: boolean;
	checked: boolean;
	onChange: (value: boolean) => void;
}): React.JSX.Element {
	if (installedFromStore) {
		return (
			<p className="hint">
				This copy came from the Microsoft Store, so Windows keeps it up to date and installs new
				versions itself. Nothing is asked of GitHub, and there is nothing to switch on here.
			</p>
		);
	}

	return (
		<label className="checkbox">
			<input
				type="checkbox"
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
			/>
			<span>
				Tell me when a new version is released
				{/* Stated exactly, because this is the only request this app makes
				    that is not to Steam, and the README promises no telemetry. The
				    honest description is what makes that promise checkable. */}
				<p className="hint">
					Asks GitHub once every few hours whether a newer release exists. It sends nothing about
					you or your accounts — it is the same question any visitor to the releases page asks.
					GitHub will see your IP address and that this application is running.
				</p>
				<p className="hint">
					It never downloads or installs anything. When there is a new version you get a link, and
					you go and get it yourself — that is the point.
				</p>
			</span>
		</label>
	);
}
