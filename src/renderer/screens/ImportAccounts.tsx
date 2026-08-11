import { useCallback, useEffect, useRef, useState } from 'react';
import type {
	ImportCandidate,
	ImportOutcome,
	ImportReport,
	ImportSelection
} from '../../shared/ipc';
import { messageOf } from '../ipc-message';

/**
 * Importing existing SDA maFiles (§12 F2).
 *
 * The screen's job is to make the user's decision an informed one before
 * anything is written. Three things are shown that other tools hide:
 *
 *  - **what each file was missing** — above all a missing revocation code, which
 *    is the difference between recovering an account yourself and needing Steam
 *    Support;
 *  - **where the SteamID came from**, because "taken from the file name" is a
 *    guess and the user should know it was made;
 *  - **that the file itself is a credential** (F-11), said after the import
 *    rather than before, when it is finally actionable.
 *
 * Nothing here ever holds a secret. Each candidate is an opaque staging id plus
 * booleans; the secrets stay in the main process from the picker to the vault.
 */
export function ImportAccounts({
	onScan,
	onUnlock,
	onCommit,
	onDiscard,
	onClose
}: {
	onScan: () => Promise<ImportReport>;
	onUnlock: (passphrase: string) => Promise<ImportReport>;
	// The shared type rather than a restatement of it. Spelling the shape out here
	// is how this drifted from the IPC schema in the first place.
	onCommit: (selections: ImportSelection[]) => Promise<{ outcomes: ImportOutcome[] }>;
	onDiscard: () => Promise<unknown>;
	onClose: () => void;
}): React.JSX.Element {
	const [report, setReport] = useState<ImportReport | undefined>();
	/** The SDA passphrase, held only while the prompt is on screen. */
	const [passphrase, setPassphrase] = useState('');
	const [selected, setSelected] = useState<Set<string>>(new Set());
	/** Rows whose file-supplied proxy the user has explicitly opted into. Never pre-ticked. */
	const [adopted, setAdopted] = useState<Set<string>>(new Set());
	const [outcomes, setOutcomes] = useState<ImportOutcome[] | undefined>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	// Leaving with files still staged drops them. Staged maFiles are plaintext
	// secrets held in main-process memory; walking away from this screen should
	// end that, not leave it waiting for a timeout.
	//
	// Held in a ref and depended on with an empty array deliberately. Depending on
	// `onDiscard` itself would re-run the effect whenever the parent re-rendered
	// with a fresh closure — and its cleanup would discard the files the user had
	// just chosen, a second after choosing them. This must fire on unmount, and
	// only on unmount.
	const discardRef = useRef(onDiscard);
	useEffect(() => {
		discardRef.current = onDiscard;
	}, [onDiscard]);
	useEffect(() => {
		return () => {
			void discardRef.current();
		};
	}, []);

	const scan = useCallback((): void => {
		if (busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		setOutcomes(undefined);
		onScan()
			.then((next) => {
				setReport(next.cancelled ? undefined : next);
				// Pre-tick only what is unambiguous. A file that would overwrite an
				// account already in the vault starts unticked — replacing stored
				// secrets is never something to arrive at by not reading.
				setSelected(
					new Set(
						next.candidates
							.filter((candidate) => candidate.importable && candidate.duplicate === undefined)
							.map((candidate) => candidate.stagingId)
					)
				);
				// A previous scan's opt-ins must not carry over to different files.
				setAdopted(new Set());
				setPassphrase('');
			})
			.catch((err: unknown) => setError(messageOf(err)))
			.finally(() => setBusy(false));
	}, [busy, onScan]);

	/**
	 * Decrypt the encrypted files and merge them into the report.
	 *
	 * The selection is deliberately **not** rebuilt from scratch afterwards: the
	 * staging ids of files already listed survive an unlock, so anything the user
	 * had ticked before typing the passphrase stays ticked. Newly decrypted rows
	 * are added on the same terms as a fresh scan — pre-ticked only when
	 * unambiguous.
	 */
	const unlock = useCallback((): void => {
		if (busy || passphrase === '') {
			return;
		}
		setBusy(true);
		setError(undefined);
		onUnlock(passphrase)
			.then((next) => {
				setReport(next);
				setSelected((previous) => {
					const merged = new Set(previous);
					for (const candidate of next.candidates) {
						if (
							!previous.has(candidate.stagingId) &&
							candidate.importable &&
							candidate.duplicate === undefined
						) {
							merged.add(candidate.stagingId);
						}
					}
					// Anything that is no longer in the report cannot be committed.
					const live = new Set(next.candidates.map((candidate) => candidate.stagingId));
					for (const id of merged) {
						if (!live.has(id)) merged.delete(id);
					}
					return merged;
				});
				// Cleared on success and on failure alike. A wrong passphrase left in
				// the field invites pressing the button again unchanged, and a right one
				// has no reason to stay in renderer memory once it has been used.
				setPassphrase('');
			})
			.catch((err: unknown) => {
				setError(messageOf(err));
				setPassphrase('');
			})
			.finally(() => setBusy(false));
	}, [busy, onUnlock, passphrase]);

	const commit = useCallback((): void => {
		if (!report || busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		onCommit(
			report.candidates
				.filter((candidate) => selected.has(candidate.stagingId))
				.map((candidate) => ({
					stagingId: candidate.stagingId,
					// Ticking a row that is already in the vault *is* the consent to
					// replace it — the row says so in as many words.
					replaceExisting: candidate.duplicate === 'vault',
					// Never inferred from the file having one. Off unless separately asked
					// for, and the control only exists on rows where there is a proxy.
					adoptProxy: adopted.has(candidate.stagingId)
				}))
		)
			.then((result) => {
				setOutcomes(result.outcomes);
				setReport(undefined);
				setSelected(new Set());
				setAdopted(new Set());
			})
			.catch((err: unknown) => setError(messageOf(err)))
			.finally(() => setBusy(false));
	}, [adopted, busy, onCommit, report, selected]);

	const toggle = (stagingId: string): void => {
		setSelected((previous) => {
			const next = new Set(previous);
			if (!next.delete(stagingId)) {
				next.add(stagingId);
			}
			return next;
		});
	};

	const toggleProxy = (stagingId: string): void => {
		setAdopted((previous) => {
			const next = new Set(previous);
			if (!next.delete(stagingId)) {
				next.add(stagingId);
			}
			return next;
		});
	};

	return (
		<main className="shell">
			<header className="row">
				<h1>Import accounts</h1>
				{/* Disabled mid-commit: leaving does not undo a write that is already
				    happening, and the staged secrets are cleared by the commit itself. */}
				<button type="button" className="secondary" onClick={onClose} disabled={busy}>
					Back
				</button>
			</header>

			<p className="muted">
				Choose the <code>.maFile</code> files from your Steam Desktop Authenticator install. They
				are read, never moved or changed.
			</p>
			<p className="hint">
				If you turned SDA’s encryption on, select <code>manifest.json</code> from the same folder as
				well — it holds the settings needed to decrypt them, and they cannot be read without it.
			</p>

			{error && <p className="error">{error}</p>}

			{outcomes && <ImportResults outcomes={outcomes} />}

			{!report && (
				<button type="button" onClick={scan} disabled={busy}>
					{busy ? 'Working…' : 'Choose files…'}
				</button>
			)}

			{report && (
				<>
					{report.locked.length > 0 && (
						<LockedFiles
							locked={report.locked}
							passphrase={passphrase}
							onPassphrase={setPassphrase}
							onUnlock={unlock}
							busy={busy}
						/>
					)}

					{report.candidates.length > 0 && (
						<>
							<h2>Found</h2>
							<ul className="accounts">
								{report.candidates.map((candidate) => (
									<CandidateRow
										key={candidate.stagingId}
										candidate={candidate}
										checked={selected.has(candidate.stagingId)}
										onToggle={() => toggle(candidate.stagingId)}
										adoptProxy={adopted.has(candidate.stagingId)}
										onToggleProxy={() => toggleProxy(candidate.stagingId)}
									/>
								))}
							</ul>
						</>
					)}

					{report.rejected.length > 0 && (
						<>
							<h2>Not imported</h2>
							<ul className="accounts">
								{/* Indexed: two files chosen from different folders can share a
								    base name, and the name alone would be a duplicate key. */}
								{report.rejected.map((rejection, index) => (
									<li key={`${index}-${rejection.sourceName}`}>
										<div>
											<strong>{rejection.sourceName}</strong>
											<p className="hint bad">{rejection.reason}</p>
										</div>
									</li>
								))}
							</ul>
						</>
					)}

					{report.candidates.length === 0 &&
						report.rejected.length === 0 &&
						report.locked.length === 0 && (
							<p className="muted">Nothing usable was found in what you chose.</p>
						)}

					<div className="controls">
						<button type="button" onClick={commit} disabled={busy || selected.size === 0}>
							{busy
								? 'Working…'
								: `Import ${selected.size} account${selected.size === 1 ? '' : 's'}`}
						</button>
						<button
							type="button"
							className="secondary"
							onClick={() => {
								void onDiscard();
								setReport(undefined);
								setSelected(new Set());
								setAdopted(new Set());
								setPassphrase('');
							}}
							disabled={busy}
						>
							Cancel
						</button>
					</div>
				</>
			)}
		</main>
	);
}

/**
 * The passphrase prompt for encrypted SDA files.
 *
 * Two failures are possible and they have completely different fixes, so they
 * are never merged into one message:
 *
 *  - **wrong passphrase** — retry, which is why the files stay listed here
 *    rather than moving to "Not imported";
 *  - **no `manifest.json` chosen** — no passphrase can help, because SDA keeps
 *    the IV and salt in the manifest rather than in the maFile. Nothing about a
 *    decryption failure would ever lead a user to that conclusion, so it is said
 *    outright.
 */
function LockedFiles({
	locked,
	passphrase,
	onPassphrase,
	onUnlock,
	busy
}: {
	locked: ImportReport['locked'];
	passphrase: string;
	onPassphrase: (value: string) => void;
	onUnlock: () => void;
	busy: boolean;
}): React.JSX.Element {
	const decryptable = locked.filter((file) => file.decryptable);
	const orphaned = locked.filter((file) => !file.decryptable);

	return (
		<>
			<h2>Encrypted</h2>
			<ul className="accounts">
				{locked.map((file) => (
					<li key={file.sourceName}>
						<div>
							<strong>{file.sourceName}</strong>
							<p className="hint">
								{file.decryptable
									? 'Encrypted by Steam Desktop Authenticator.'
									: 'Encrypted, but the manifest.json that holds this file’s decryption ' +
										'settings was not among the files you chose. Choose the files again, ' +
										'including manifest.json from the same folder.'}
							</p>
						</div>
					</li>
				))}
			</ul>

			{decryptable.length > 0 && (
				<form
					className="stack"
					onSubmit={(event) => {
						event.preventDefault();
						onUnlock();
					}}
				>
					<label htmlFor="sda-passphrase">
						The password you set in Steam Desktop Authenticator
					</label>
					<input
						id="sda-passphrase"
						type="password"
						autoComplete="off"
						spellCheck={false}
						value={passphrase}
						onChange={(event) => onPassphrase(event.target.value)}
						disabled={busy}
					/>
					<p className="hint">
						This is SDA’s encryption password, not the passphrase for this app’s vault and not your
						Steam password. It is used to decrypt the files and is not stored.
					</p>
					<button type="submit" disabled={busy || passphrase === ''}>
						{busy ? 'Working…' : `Decrypt ${decryptable.length} file${plural(decryptable.length)}`}
					</button>
				</form>
			)}

			{decryptable.length === 0 && orphaned.length > 0 && (
				<p className="hint bad">
					None of these can be decrypted without <code>manifest.json</code>.
				</p>
			)}
		</>
	);
}

function plural(count: number): string {
	return count === 1 ? '' : 's';
}

function CandidateRow({
	candidate,
	checked,
	onToggle,
	adoptProxy,
	onToggleProxy
}: {
	candidate: ImportCandidate;
	checked: boolean;
	onToggle: () => void;
	adoptProxy: boolean;
	onToggleProxy: () => void;
}): React.JSX.Element {
	const blocked = !candidate.importable || candidate.duplicate === 'selection';

	return (
		<li>
			<label className="checkbox">
				<input type="checkbox" checked={checked} onChange={onToggle} disabled={blocked} />
				<span>
					<strong>{candidate.accountName}</strong>{' '}
					<span className="muted">{candidate.steamId64 ?? 'no SteamID'}</span>
					<span className="muted"> · {candidate.sourceName}</span>
					{candidate.warnings.map((warning, index) => (
						<p
							key={`${index}-${warning.slice(0, 24)}`}
							className={warning.startsWith('NO REVOCATION') ? 'hint bad' : 'hint'}
						>
							{warning}
						</p>
					))}
					{candidate.duplicate === 'vault' && (
						<p className="hint bad">
							This account is already in the vault. Ticking it replaces the stored copy — anything
							this file does not contain is kept.
						</p>
					)}
					{candidate.duplicate === 'selection' && (
						<p className="hint">Another file you chose is the same account. This one is ignored.</p>
					)}
				</span>
			</label>

			{/* Only when the file actually carries one, and only when the account is
			    being imported at all. Off unless asked for: a proxy inside a maFile is
			    frequently one the user stopped paying for years ago, and routing fails
			    closed — so adopting a dead one silently means the account cannot reach
			    Steam at all, with nothing on screen to connect the two. */}
			{candidate.hasProxy && checked && !blocked && (
				<label className="checkbox nested">
					<input type="checkbox" checked={adoptProxy} onChange={onToggleProxy} />
					<span>
						Also route this account through the proxy saved in the file
						<p className="hint">
							Leave this off unless you know the proxy still works. If it does not, this account
							will not connect to Steam at all — it will not fall back to your own connection. You
							can add or change routing later.
						</p>
					</span>
				</label>
			)}

			<div className="flags">
				{!candidate.hasRevocationCode && (
					<span className="flag bad" title="This account cannot be self-recovered.">
						no revocation code
					</span>
				)}
				{candidate.steamIdSource === 'filename' && (
					<span className="flag warn">SteamID from file name</span>
				)}
				{candidate.hasSession && <span className="flag">session included</span>}
				{candidate.hasProxy && <span className="flag">routed</span>}
			</div>
		</li>
	);
}

function ImportResults({ outcomes }: { outcomes: ImportOutcome[] }): React.JSX.Element {
	const stored = outcomes.filter((outcome) => outcome.result !== 'skipped').length;

	return (
		<>
			<h2>Result</h2>
			<ul className="accounts">
				{outcomes.map((outcome) => (
					<li key={outcome.stagingId}>
						<div>
							<strong>{outcome.accountName}</strong>
							<span className="muted"> {outcome.result}</span>
							{outcome.reason && <p className="hint">{outcome.reason}</p>}
						</div>
					</li>
				))}
			</ul>

			{stored > 0 && (
				<div className="ceremony">
					<h2>Those files are still keys to your accounts</h2>
					<p>
						A maFile holds the same secrets this app now stores, and often a live Steam session too.
						Anyone who copies one can generate your codes.
					</p>
					<p>
						Keep them somewhere offline — a USB stick or an encrypted archive — and delete the
						copies sitting in your Downloads folder, your cloud drive, and your chat history.
					</p>
				</div>
			)}
		</>
	);
}
