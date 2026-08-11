import { useState } from 'react';
import type { EnrollBegin } from '../../shared/ipc';
import { messageOf } from '../ipc-message';

/**
 * Adding an authenticator to an account that has none (§12 F3).
 *
 * ## The shape of the screen follows the shape of the risk
 *
 * There is exactly one irreversible moment in this flow, and it is not the one
 * users expect. Pressing the button that signs in is what causes Steam to attach
 * an authenticator and issue secrets it will never reissue — so the screen says
 * so **before** it, in the plainest terms available, and stops pretending the
 * step afterwards is where the commitment happens.
 *
 * After that point the wording changes deliberately: no more "cancel", because
 * cancelling is no longer a thing that exists. The account has an authenticator
 * whether or not the user finishes, and the only useful instruction left is
 * "write the revocation code down".
 *
 * ## Two codes, from two places
 *
 * The account has no authenticator yet, so Steam Guard cannot ask for one —
 * it emails a code instead. Then activation needs a second code, texted to the
 * phone on the account. Users conflate them constantly, so each step names where
 * its code is coming from rather than saying "enter the code".
 */
export function AddAuthenticator({
	onBegin,
	onEmailCode,
	onCancel,
	onActivate,
	onBackup,
	onClose,
	resume
}: {
	onBegin: (accountName: string, password: string, proxyUrl?: string) => Promise<EnrollBegin>;
	onEmailCode: (code: string) => Promise<EnrollBegin>;
	/** Drops the pending sign-in in the main process. Safe only before anything is attached. */
	onCancel: () => Promise<unknown>;
	onActivate: (steamId64: string, code: string) => Promise<{ state: 'activated' | 'wantMore' }>;
	/** Opens the revocation-code ceremony for the newly enrolled account. */
	onBackup: (steamId64: string, accountName: string) => void;
	onClose: () => void;
	/**
	 * An account that is already enrolled but not activated, to resume.
	 *
	 * Enrollment used to be a one-shot wizard whose state died with the component,
	 * so leaving the screen — including by going to write the revocation code
	 * down, which the screen *tells* you to do — stranded the account as
	 * `ACTIVATION INCOMPLETE` with no way back in. Resuming makes the flow
	 * survive that, which it has to: the account already has an authenticator.
	 */
	resume?: { steamId64: string; accountName: string } | undefined;
}): React.JSX.Element {
	const [step, setStep] = useState<'credentials' | 'emailCode' | 'activate' | 'done'>(
		resume ? 'activate' : 'credentials'
	);
	const [accountName, setAccountName] = useState('');
	const [password, setPassword] = useState('');
	const [proxyUrl, setProxyUrl] = useState('');
	const [code, setCode] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [emailDomain, setEmailDomain] = useState<string | undefined>();
	const [enrolled, setEnrolled] = useState<
		{ steamId64: string; accountName: string; phoneNumberHint?: string } | undefined
	>(resume);

	/** Both entry points land here, because both can finish the enrollment. */
	const applyOutcome = (outcome: EnrollBegin): void => {
		if (outcome.state === 'needsEmailCode') {
			setEmailDomain(outcome.emailDomain);
			setCode('');
			setStep('emailCode');
			return;
		}
		const details: { steamId64: string; accountName: string; phoneNumberHint?: string } = {
			steamId64: outcome.steamId64,
			accountName: outcome.accountName
		};
		if (outcome.phoneNumberHint !== undefined) details.phoneNumberHint = outcome.phoneNumberHint;
		setEnrolled(details);
		setCode('');
		setStep('activate');
	};

	const run = (work: () => Promise<void>): void => {
		if (busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		work()
			.catch((err: unknown) => setError(messageOf(err)))
			.finally(() => setBusy(false));
	};

	const submitCredentials = (event: React.FormEvent): void => {
		event.preventDefault();
		run(async () => {
			const outcome = await onBegin(accountName.trim(), password, proxyUrl.trim() || undefined);
			// Dropped the instant it has been used. It is never needed again — the
			// refresh token Steam issued is what keeps this account working.
			setPassword('');
			applyOutcome(outcome);
		});
	};

	const submitEmailCode = (event: React.FormEvent): void => {
		event.preventDefault();
		run(async () => applyOutcome(await onEmailCode(code)));
	};

	const submitActivation = (event: React.FormEvent): void => {
		event.preventDefault();
		if (!enrolled) {
			return;
		}
		run(async () => {
			const result = await onActivate(enrolled.steamId64, code);
			if (result.state === 'wantMore') {
				// Not a failure. Steam accepted that code and wants one from a later
				// window, which is a normal part of its flow.
				setCode('');
				setError('Steam wants one more code. Wait for the next text and enter it.');
				return;
			}
			setStep('done');
		});
	};

	return (
		<main className="shell">
			<header className="row">
				<h1>Add an authenticator</h1>
				{/* Three different exits, because at three points in this flow the honest
				    thing to say is different.

				    Before sign-in: Cancel. Nothing has happened.

				    Waiting on the emailed code: still Cancel — Steam has authenticated
				    nothing and attached nothing. This step had *no* control at all, so a
				    mistyped account name left force-quitting or waiting out the idle
				    lock as the only ways out, with a live LoginSession running behind
				    the screen the whole time. It now tells the main process to drop it.

				    After the authenticator is attached: not a cancel, because there is
				    nothing left to cancel. "Finish later" matches what the copy on that
				    step already promises and what resuming actually does. Its absence
				    meant the only exits were activating successfully or the revocation
				    button beside it. */}
				{step === 'credentials' && (
					<button type="button" className="secondary" onClick={onClose} disabled={busy}>
						Cancel
					</button>
				)}
				{step === 'emailCode' && (
					<button
						type="button"
						className="secondary"
						onClick={() => {
							void onCancel();
							onClose();
						}}
						disabled={busy}
					>
						Cancel
					</button>
				)}
				{step === 'activate' && (
					<button type="button" className="secondary" onClick={onClose} disabled={busy}>
						Finish later
					</button>
				)}
			</header>

			{error && <p className="error">{error}</p>}

			{step === 'credentials' && (
				<>
					<div className="notice">
						<strong>This changes your Steam account, and it cannot be undone from here.</strong>
						<p className="hint">
							Signing in below tells Steam to attach a new authenticator. From that moment the
							account needs this app — or the revocation code — to log in. Steam issues that code
							once and never again, and the very next screen shows it to you.
						</p>
					</div>

					<div className="ceremony">
						<h2>Before you start</h2>
						<p className="hint">
							The account must not already have an authenticator. If it has one on a phone, remove
							it there first — this app will not detach it for you.
						</p>
						<p className="hint">
							A phone number is <strong>not</strong> required. If the account has one, Steam texts
							the activation code; if it does not, Steam emails it instead.
						</p>
					</div>

					<form onSubmit={submitCredentials}>
						<label htmlFor="enroll-account">Steam account name</label>
						<input
							id="enroll-account"
							type="text"
							value={accountName}
							onChange={(event) => setAccountName(event.target.value)}
							autoComplete="off"
							spellCheck={false}
						/>

						<label htmlFor="enroll-password">Steam password</label>
						<input
							id="enroll-password"
							type="password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							autoComplete="off"
						/>
						<p className="hint">
							Used once, to sign in, and never stored. What is kept is the session Steam gives back.
						</p>

						<label htmlFor="enroll-proxy">Route this account through a proxy (optional)</label>
						<input
							id="enroll-proxy"
							type="text"
							value={proxyUrl}
							onChange={(event) => setProxyUrl(event.target.value)}
							placeholder="socks5://user:password@host:1080"
							autoComplete="off"
							spellCheck={false}
						/>
						{/* Offered here rather than only afterwards, and the reason is worth
						    stating: an account enrolled from one address and then routed
						    through another is linked to both, by Steam, through the account
						    itself. Adding routing later cannot undo the first request. */}
						<p className="hint">
							Leave empty to use this machine&rsquo;s own connection. If you intend to route this
							account at all, <strong>set it now</strong> — Steam sees the address every request
							comes from, so enrolling here and routing later ties the two together permanently.
						</p>

						<div className="controls">
							<button type="submit" disabled={busy || accountName.trim() === '' || password === ''}>
								{busy ? 'Talking to Steam…' : 'Sign in and add authenticator'}
							</button>
						</div>
					</form>
				</>
			)}

			{step === 'emailCode' && (
				<form onSubmit={submitEmailCode}>
					<div className="ceremony">
						<h2>Check your email</h2>
						<p>
							This account has no authenticator yet, so Steam sent a code to your email
							{emailDomain === undefined ? '' : ` at ${emailDomain}`} rather than to an app.
						</p>
					</div>

					<label htmlFor="enroll-email-code">Code from your email</label>
					<input
						id="enroll-email-code"
						type="text"
						value={code}
						onChange={(event) => setCode(event.target.value)}
						autoComplete="off"
						spellCheck={false}
					/>
					<p className="hint">
						Nothing has changed on your account yet. Getting this wrong costs you nothing — you can
						try the code again.
					</p>

					<div className="controls">
						<button type="submit" disabled={busy || code.trim() === ''}>
							{busy ? 'Checking…' : 'Continue'}
						</button>
					</div>
				</form>
			)}

			{step === 'activate' && enrolled && (
				<>
					<div className="notice">
						<strong>
							{resume
								? `${enrolled.accountName} has an authenticator, but it was never activated.`
								: `The authenticator is attached to ${enrolled.accountName}.`}
						</strong>
						<p className="hint">
							Steam has issued its secrets and this app has saved them.{' '}
							<strong>Write down the revocation code now</strong> — it is the only way back if you
							ever lose this vault, and Steam will not show it again.
						</p>
						<div className="controls">
							<button
								type="button"
								onClick={() => onBackup(enrolled.steamId64, enrolled.accountName)}
								disabled={busy}
							>
								Show my revocation code
							</button>
						</div>
					</div>

					<form onSubmit={submitActivation}>
						<h2>Finish activating</h2>
						{/* Where the code came from is decided by whether Steam returned a
						    phone hint — never assumed. An account with no phone enrols
						    perfectly well and Steam emails the code instead (F-10, settled
						    by live run). Telling somebody to check a phone they do not have
						    is how a working flow reads as broken. */}
						{resume ? (
							// Resumed from the account list: the delivery method was not
							// carried across. Naming both beats confidently naming the wrong one.
							<p className="hint">
								Enter the activation code Steam sent when this authenticator was added — by email if
								the account has no phone number, by text if it has one.
							</p>
						) : enrolled.phoneNumberHint === undefined ? (
							<p className="hint">
								There is no phone number on this account, so Steam sent the code to its{' '}
								<strong>email address</strong> — nothing was texted. Entering it proves the secrets
								arrived intact.
							</p>
						) : (
							<p className="hint">
								Steam has texted a code to the phone ending {enrolled.phoneNumberHint}. Entering it
								proves the secrets arrived intact.
							</p>
						)}

						<label htmlFor="enroll-sms-code">
							{resume
								? 'Activation code'
								: enrolled.phoneNumberHint === undefined
									? 'Code from your email'
									: 'Code from the text message'}
						</label>
						<input
							id="enroll-sms-code"
							type="text"
							value={code}
							onChange={(event) => setCode(event.target.value)}
							autoComplete="off"
							spellCheck={false}
						/>

						<div className="controls">
							<button type="submit" disabled={busy || code.trim() === ''}>
								{busy ? 'Activating…' : 'Activate'}
							</button>
						</div>
						<p className="hint">
							If you close this before activating, the account stays in your vault and you can
							finish later — but it is already using this authenticator either way.
						</p>
					</form>
				</>
			)}

			{step === 'done' && enrolled && (
				<div className="ceremony">
					<h2>{enrolled.accountName} is ready</h2>
					<p>
						Steam Guard codes for this account now come from here. Steam will ask for one the next
						time you sign in anywhere.
					</p>
					<p className="hint">
						If you have not written the revocation code down yet, do it before you close this.
					</p>
					<div className="controls">
						<button
							type="button"
							onClick={() => onBackup(enrolled.steamId64, enrolled.accountName)}
						>
							Show my revocation code
						</button>
						<button type="button" className="secondary" onClick={onClose}>
							Done
						</button>
					</div>
				</div>
			)}
		</main>
	);
}
