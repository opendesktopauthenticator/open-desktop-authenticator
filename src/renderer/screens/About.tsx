import { useEffect, useState } from 'react';
import type { AppInfo } from '../../shared/ipc';

/**
 * Who made this, what it is, and how to check both.
 *
 * ## Why this screen exists
 *
 * The application knew all of it and showed none of it. `app:info` has carried
 * the publisher, the attribution strings and the security posture since the
 * channel was written — the handler even calls itself "metadata for the About
 * screen" — and there was no About screen, so every one of those values went
 * over the bridge and into nothing.
 *
 * That is a real gap rather than a missing nicety. §4's answer to the clone
 * problem is a chain a suspicious person can walk: the thing running on their
 * machine names a company, the company can be looked up, the repository can be
 * read, the build can be checked against it. An authenticator that will not say
 * who publishes it is asking for exactly the trust it tells people not to give.
 *
 * ## Why the attribution is not paraphrased
 *
 * The two strings come over the wire and are rendered verbatim (§8). They are
 * worded to credit without implying endorsement, which is a distinction that
 * does not survive being reworded in a component.
 */
export function About({
	onClose,
	onLoad
}: {
	onClose: () => void;
	onLoad: () => Promise<AppInfo>;
}): React.JSX.Element {
	const [info, setInfo] = useState<AppInfo | undefined>();
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		let cancelled = false;
		onLoad()
			.then((loaded) => {
				if (!cancelled) setInfo(loaded);
			})
			.catch((err: unknown) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [onLoad]);

	return <AboutView info={info} error={error} onClose={onClose} />;
}

/**
 * The screen itself, given everything it needs.
 *
 * Split from the loading so it can be rendered and asserted on without a DOM,
 * an event loop or a bridge — `react-dom/server` is already a dependency, and
 * this project does not carry a component-testing stack. Without the split the
 * only way to check that the publisher is actually on the screen would be to
 * read the file and believe it.
 */
export function AboutView({
	info,
	error,
	onClose
}: {
	info?: AppInfo;
	error?: string;
	onClose: () => void;
}): React.JSX.Element {
	return (
		<main className="shell">
			<header className="row">
				<h1>About</h1>
				<button type="button" className="secondary" onClick={onClose}>
					Back
				</button>
			</header>

			{error && <p className="error">{error}</p>}

			{info === undefined ? (
				error === undefined ? (
					<p className="muted">Loading…</p>
				) : null
			) : (
				<>
					<p className="lede">
						{info.productName} {info.version}
					</p>

					{/*
						The publisher, named and followable. Links open in the browser
						through the main process; both domains had to be added to the
						external-link allowlist, which did not previously include our own.
					*/}
					<p className="powered-by">
						Powered by{' '}
						<a href={info.companyWebsite} target="_blank" rel="noreferrer">
							{info.companyShort}
						</a>
					</p>
					<p className="hint">
						Published by {info.company}. Everything here is open source — the point of naming a
						company is that you can check it exists, and the point of publishing the source is that
						you do not have to take its word for anything.
					</p>

					<h2>Check this build is ours</h2>
					<ul className="plain">
						<li>
							<a href={info.website} target="_blank" rel="noreferrer">
								{info.website.replace(/^https:\/\//, '')}
							</a>{' '}
							— the official site, and the list of domains that are ours
						</li>
						<li>
							<a href={info.repository} target="_blank" rel="noreferrer">
								the source repository
							</a>{' '}
							— every line, including the parts that hold your secrets
						</li>
					</ul>

					<h2>Credit</h2>
					{/* Verbatim (§8). Not reworded here, and not summarised. */}
					<p className="hint">{info.attribution.mckay}</p>
					<p className="hint">{info.attribution.valve}</p>

					<h2>How this process is running</h2>
					{/*
						Read back from the live values rather than restated, so this reports
						what the process is actually doing rather than what it intended to.
					*/}
					<ul className="plain">
						<li>Sandboxed renderer: {info.security.sandbox ? 'yes' : 'no'}</li>
						<li>Context isolation: {info.security.contextIsolation ? 'yes' : 'no'}</li>
						<li>Node in the renderer: {info.security.nodeIntegration ? 'yes' : 'no'}</li>
						<li>Platform: {info.platform}</li>
					</ul>

					{info.brandingUnresolved && (
						<p className="error">
							This build has unresolved branding placeholders and should not have been released.
						</p>
					)}
				</>
			)}
		</main>
	);
}
