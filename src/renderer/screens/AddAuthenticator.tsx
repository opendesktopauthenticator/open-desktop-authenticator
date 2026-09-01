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
	onMove,
	resume,
	requireProxies
}: {
	onBegin: (accountName: string, password: string, proxyUrl?: string) => Promise<EnrollBegin>;
	onEmailCode: (code: string) => Promise<EnrollBegin>;
	/**
	 * Whether the vault refuses to talk to Steam without a proxy.
	 *
	 * The main process already refuses a proxyless enrolment under this setting.
	 * Without it here the form said "optional" and offered a submit button that
	 * could only ever fail — inviting an action that cannot succeed, which is
	 * worse than not offering it.
	 */
	requireProxies: boolean;
	/** Drops the pending sign-in in the main process. Safe only before anything is attached. */
	onCancel: () => Promise<unknown>;
	onActivate: (
		steamId64: string,
		code: string
	) => Promise<{
		state: 'activated' | 'wantMore' | 'uncertain';
		guidance?: string;
		certain?: boolean;
	}>;
	/** Opens the revocation-code ceremony for the newly enrolled account. */
	onBackup: (steamId64: string, accountName: string) => void;
	onClose: () => void;
	/**
	 * Switch to moving an authenticator that already exists on a phone.
	 *
	 * Offered here rather than as another button on the accounts screen, because
	 * here is where the person who needs it actually arrives: they press "add",
	 * Steam refuses because the account already has one, and the error tells them
	 * to remove it from their phone — which is the fifteen-day mistake. The way
	 * out belongs next to the wall, not in a row of seven buttons they read
	 * before they knew they had a problem.
	 */
	onMove: () => void;
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
	/** A normal thing that happened, said in the ordinary voice rather than in red. */
	const [notice, setNotice] = useState<string | undefined>();
	/**
	 * The request reached Steam and the reply did not.
	 *
	 * Its own state rather than an error, because the difference is what the
	 * screen must *offer*: an error is something to try again, and this is the one
	 * outcome where trying again may attach or detach a second time. The form goes
	 * away and the guidance takes its place.
	 */
	const [uncertain, setUncertain] = useState<{ guidance: string; certain: boolean } | undefined>();
	const [emailDomain, setEmailDomain] = useState<string | undefined>();
	const [enrolled, setEnrolled] = useState<
		{ steamId64: string; accountName: string; phoneNumberHint?: string } | undefined
	>(resume);

	/** Both entry points land here, because both can finish the enrollment. */
	const applyOutcome = (outcome: EnrollBegin): void => {
		/*
		 * **The end of the flow, not a failure it can retry from.**
		 *
		 * `AddAuthenticator` is sent before anything can go wrong with the answer,
		 * so a lost reply — or a reply Steam answered `ok` without the secrets, or a
		 * vault write that failed after it — leaves the account possibly or
		 * definitely carrying an authenticator this machine cannot use. All of those
		 * arrived here as thrown errors, which `run` handles by clearing `busy` and
		 * putting the form back, live, under a message saying not to try again.
		 */
		if (outcome.state === 'uncertain') {
			setUncertain({ guidance: outcome.guidance, certain: outcome.certain === true });
			return;
		}
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
		setNotice(undefined);
		work()
			.catch((err: unknown) => setError(messageOf(err)))
			.finally(() => setBusy(false));
	};

	const submitCredentials = (event: React.FormEvent): void => {
		event.preventDefault();
		run(async () => {
			// **Cleared in a `finally`, so a throw clears them too.**
			//
			// The password is single-use — the refresh token Steam issues is what
			// keeps the account working — and the proxy URL routinely carries a
			// username and password of its own. Both used to be cleared only on the
			// success path, so a sign-in that *rejected* (an IPC failure, a schema
			// refusal, a dead proxy) left them in component state, and in the DOM,
			// for the rest of a flow that can sit open for fifteen minutes waiting on
			// an email. Retyping after a failure is the cost, and it is the right one.
			const outcome = await onBegin(
				accountName.trim(),
				password,
				proxyUrl.trim() || undefined
			).finally(() => {
				setPassword('');
				setProxyUrl('');
			});
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
			if (result.state === 'uncertain') {
				/*
				 * **A dead end on purpose.** The request reached Steam and the reply did
				 * not, so the authenticator may already be active. Trying the same code
				 * again is the one thing that must not happen, and this used to arrive
				 * as an ordinary error — which cleared `busy` and re-enabled the button
				 * that sends it, while the message said not to.
				 */
				setUncertain({
					guidance: result.guidance ?? 'Steam did not answer, so the outcome is unknown.',
					certain: result.certain === true
				});
				return;
			}
			if (result.state === 'wantMore') {
				// Not a failure, and it must not look like one. Steam accepted that code
				// and wants one from a later window, which is an ordinary part of its
				// flow — routing it through `setError` painted a working enrollment in
				// the red error style, at the step where the user is already worried
				// they have broken something irreversible.
				setCode('');
				setNotice(
					'Steam accepted that code and wants one more. Wait for the next one and enter it.'
				);
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
			{notice && <p className="hint">{notice}</p>}

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
							This screen is for an account with <strong>no</strong> authenticator yet. If the
							account already has one on a phone, do not remove it — move it across instead, using
							the link under the button below. Removing and re-adding costs fifteen days of no
							trading; moving does not.
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

						<label htmlFor="enroll-proxy">
							{requireProxies
								? 'Route this account through a proxy (required)'
								: 'Route this account through a proxy (optional)'}
						</label>
						<input
							id="enroll-proxy"
							type="text"
							value={proxyUrl}
							onChange={(event) => setProxyUrl(event.target.value)}
							placeholder="socks5://host:1080"
							autoComplete="off"
							spellCheck={false}
						/>
						{/* Offered here rather than only afterwards, and the reason is worth
						    stating: an account enrolled from one address and then routed
						    through another is linked to both, by Steam, through the account
						    itself. Adding routing later cannot undo the first request. */}
						{/* **SOCKS4 was on this list, and the transport has never taken it.**
						    `planProxy` refuses `socks4://` deliberately: the protocol carries an
						    address and not a hostname, so the client has to resolve first, and
						    every Steam host is then looked up by this machine, in the clear, on
						    whatever resolver the network hands out. That is the leak routing an
						    account exists to close.

						    The screen invited people into it anyway. They typed a socks4 address
						    into the field above and the main process turned them away with a
						    message contradicting the sentence directly beneath it — mid sign-in,
						    password already entered.

						    The reason is spelled out rather than left at "not supported", because
						    "not supported" reads as "not built yet" and earns a feature request
						    instead of a socks5 address. */}
						<p className="hint">
							<code>http</code>, <code>https</code> and <code>socks5</code> are accepted; the
							example is only an example. SOCKS4 is refused rather than merely unbuilt: it cannot
							ask a proxy to look a hostname up, so this machine would resolve every Steam address
							itself and your own network would see which accounts you are contacting.{' '}
							{/* The label above says required under this setting, and the main
							    process refuses an empty field. A hint still offering to leave
							    it empty contradicted both. */}
							{requireProxies
								? 'This vault requires a proxy, so it cannot be left empty.'
								: 'Leave empty to use this machine’s own connection.'}{' '}
							If you intend to route this account at all, <strong>set it now</strong> — Steam sees
							the address every request comes from, so enrolling here and routing later ties the two
							together permanently.
						</p>

						<div className="controls">
							<button
								type="submit"
								disabled={
									busy ||
									accountName.trim() === '' ||
									password === '' ||
									// Under `Require proxies` an empty field is a submission the
									// main process will refuse, so it is not offered.
									(requireProxies && proxyUrl.trim() === '')
								}
							>
								{busy ? 'Talking to Steam…' : 'Sign in and add authenticator'}
							</button>
						</div>

						<p className="hint">
							Already have an authenticator on your phone for this account?{' '}
							{/* **Disabled while a sign-in is in the air.** Submit was guarded by
							    `busy` and this was not, so pressing it during `onBegin` only
							    changed the view: the component unmounted, the main process
							    carried on, and Steam could attach an authenticator whose
							    ceremony — the revocation code the user must write down — had
							    no screen left to run on. */}
							<button type="button" className="link" onClick={onMove} disabled={busy}>
								Move it here instead
							</button>{' '}
							— adding a second one is not possible, and removing the first costs fifteen days of no
							trading.
						</p>
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

			{uncertain !== undefined && (
				<section className="ceremony">
					{/*
					 * **Two true headings rather than one that fits both.**
					 *
					 * This said "This may already have happened" for every case. Two of
					 * them are not maybes: Steam answered `ok` without the secrets, or it
					 * returned them and the vault write failed. Telling someone nothing
					 * can tell whether Steam acted, when it certainly did — and when the
					 * text below may be carrying the only copy of their revocation code —
					 * is false at the moment they most need a true sentence.
					 */}
					<h2>
						{uncertain.certain ? 'Steam has already done this' : 'This may already have happened'}
					</h2>
					<p>{uncertain.guidance}</p>
					<p>
						{uncertain.certain
							? 'This application will not send the request again. Follow the steps above before ' +
								'starting another enrollment for this account.'
							: 'Nothing here can tell whether Steam acted on the last request, so this ' +
								'application will not send it again. Check the Steam mobile app before doing ' +
								'anything else.'}
					</p>
					<div className="controls">
						<button type="button" onClick={onClose}>
							Close
						</button>
					</div>
				</section>
			)}

			{uncertain === undefined && step === 'activate' && enrolled && (
				<>
					<div className="notice">
						<strong>
							{resume
								? `${enrolled.accountName} has an authenticator, but it was never activated.`
								: `The authenticator is attached to ${enrolled.accountName}.`}
						</strong>
						<p className="hint">
							Steam has issued its secrets and this app has saved them.{' '}
							<strong>Write down the revocation code now</strong> — it is the one route back that
							depends on nothing else if you ever lose this vault, and Steam will not show it again.
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
