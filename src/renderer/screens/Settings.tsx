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
	onChangePassphrase,
	onClose,
	installedFromStore = false
}: {
	onLoad: () => Promise<VaultSettingsView>;
	onSave: (settings: VaultSettingsView) => Promise<unknown>;
	onChangePassphrase: (current: string, next: string) => Promise<unknown>;
	onClose: () => void;
	/** Store builds are updated by Windows, so the update toggle does nothing there. */
	installedFromStore?: boolean;
}): React.JSX.Element {
	const [settings, setSettings] = useState<VaultSettingsView | undefined>();
	const [busy, setBusy] = useState(false);
	/**
	 * The passphrase rotation below has its own busy flag, and Back only knew
	 * about the settings save — so leaving mid-rotation looked like a cancel
	 * while scrypt carried on and committed. Held here so Back waits for both.
	 */
	const [rotating, setRotating] = useState(false);
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
				<button type="button" className="secondary" onClick={onClose} disabled={busy || rotating}>
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
						disabled={busy}
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
						disabled={busy}
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

			<h2>Change the vault passphrase</h2>
			<PassphraseChange onChange={onChangePassphrase} onBusy={setRotating} />

			<div className="notice">
				Launching at startup, starting minimised, and unlocking without the passphrase are in the
				vault format but not implemented, so they are not offered here. A switch that appears to
				work and does nothing is worse than no switch.
			</div>
		</main>
	);
}

/**
 * Rotating the passphrase, from the one screen a user would look for it on.
 *
 * The whole operation — service, IPC channel, preload bridge — existed with no
 * renderer calling it, so a weak or shoulder-surfed passphrase could not be
 * rotated without exporting every account and rebuilding the vault. The service
 * verifies the current passphrase against the file itself, so an unattended
 * unlocked machine is not enough to lock the real owner out; this form is just
 * the doorway to that check.
 *
 * Split out like `UpdateCheckSetting`, and for the same reason: `Settings`
 * renders nothing until its async load answers, so a static render of the whole
 * screen asserts on nothing.
 */
export function PassphraseChange({
	onChange,
	onBusy
}: {
	onChange: (current: string, next: string) => Promise<unknown>;
	/** Told while the rotation is in flight, so the screen can hold Back. */
	onBusy?: (busy: boolean) => void;
}): React.JSX.Element {
	const [current, setCurrent] = useState('');
	const [next, setNext] = useState('');
	const [confirm, setConfirm] = useState('');
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const submit = (event: React.FormEvent): void => {
		event.preventDefault();
		if (busy) {
			return;
		}
		// Checked here because only this screen has both copies. Everything else —
		// the current passphrase being right, the new one meeting the policy — is
		// the service's call, made against the file.
		if (next !== confirm) {
			setError('The new passphrase and its confirmation do not match.');
			return;
		}
		setBusy(true);
		onBusy?.(true);
		setError(undefined);
		setDone(false);
		onChange(current, next)
			.then(() => {
				setDone(true);
				// Passphrases have no business sitting in component state after the
				// change. The success line is what remains.
				setCurrent('');
				setNext('');
				setConfirm('');
			})
			.catch((err: unknown) => setError(messageOf(err)))
			.finally(() => {
				setBusy(false);
				onBusy?.(false);
			});
	};

	return (
		<form onSubmit={submit}>
			<p className="hint">
				Re-encrypts the vault under the new passphrase, with a fresh salt. The current one is
				checked against the vault file itself, so knowing it is required even while the vault is
				unlocked. There is no recovery: a forgotten passphrase is a locked vault.
			</p>

			<label htmlFor="passphrase-current">Current passphrase</label>
			<input
				id="passphrase-current"
				type="password"
				disabled={busy}
				autoComplete="current-password"
				value={current}
				onChange={(event) => setCurrent(event.target.value)}
			/>

			<label htmlFor="passphrase-next">New passphrase</label>
			<input
				id="passphrase-next"
				type="password"
				disabled={busy}
				autoComplete="new-password"
				value={next}
				onChange={(event) => setNext(event.target.value)}
			/>

			<label htmlFor="passphrase-confirm">New passphrase, again</label>
			<input
				id="passphrase-confirm"
				type="password"
				disabled={busy}
				autoComplete="new-password"
				value={confirm}
				onChange={(event) => setConfirm(event.target.value)}
			/>

			{error && <p className="error">{error}</p>}

			<div className="controls">
				<button type="submit" disabled={busy || !current || !next || !confirm}>
					{busy ? 'Re-encrypting…' : 'Change the passphrase'}
				</button>
				{done && (
					<span className="hint">Changed. The old passphrase no longer opens this vault.</span>
				)}
			</div>
		</form>
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
