import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VaultHome } from '../src/renderer/screens/VaultHome';
import { AddAuthenticator } from '../src/renderer/screens/AddAuthenticator';
import { accountSummary, type AccountSummary } from '../src/shared/ipc';

/**
 * The control that opens the in-app browser.
 *
 * Rendered rather than reasoned about, because the whole class of bug here is a
 * feature that exists in the main process and never appears on a screen. Every
 * part of this — the session, the proxy, the cookie, the lock sweep — was built
 * and wired and tested before anything a user could press existed.
 *
 * These are markup assertions, not interaction ones: this suite has no DOM, and
 * the behaviour behind the click lives in `browser-window.test.ts` and
 * `browser-ipc.test.ts` where it can be tested without one.
 */

/** Built through the real schema, so the fixture cannot drift from the type. */
function account(overrides: Record<string, unknown> = {}): AccountSummary {
	return accountSummary.parse({
		steamId64: '76561198000000001',
		accountName: 'someone',
		status: 'active',
		hasRevocationCode: true,
		hasProxy: false,
		routing: 'off',
		autoConfirm: {
			marketListings: false,
			trades: false,
			pollIntervalSeconds: 30,
			notify: { enabled: false, detail: 'full' }
		},
		...overrides
	});
}

const noop = (): void => {};

function render(accounts: AccountSummary[], requireProxies = false): string {
	return renderToStaticMarkup(
		<VaultHome
			accounts={accounts}
			codes={undefined}
			msUntilAutoLock={null}
			onCopyCode={() => Promise.resolve({ clipboardClearsInSeconds: 30 })}
			onBackUpRevocationCode={noop}
			onChangeRouting={noop}
			onShowConfirmations={noop}
			requireProxies={requireProxies}
			onOpenBrowser={() => Promise.resolve({ signInRequired: false })}
			onRemoveAccount={noop}
			onMove={noop}
			onChangeAutoConfirm={noop}
			onImport={noop}
			onRecover={noop}
			onEnrol={noop}
			onFinishActivation={noop}
			onFinishRecoveryBackup={noop}
			onExport={noop}
			onSettings={noop}
			onAbout={noop}
			onActivity={noop}
			activityUrgent={false}
			onLock={noop}
		/>
	);
}

/** Every `<button>` on the page, with its attributes, as flat strings. */
function buttons(html: string): string[] {
	return [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);
}

/** The button that opens the browser — labelled differently when routed. */
const tradeButton = (html: string): string | undefined =>
	buttons(html).find((button) => />Trade(\s*\(proxied\))?</.test(button));

/** The second button a routed account gets, for going around its proxy. */
const directButton = (html: string): string | undefined =>
	buttons(html).find((button) => button.includes('>Direct<'));

/** The third: Steam through the proxy, everything else straight out. */
const steamOnlyButton = (html: string): string | undefined =>
	buttons(html).find((button) => button.includes('>Steam only<'));

describe('the trade button', () => {
	it('is on the row, and reachable without opening anything first', () => {
		const html = render([account()]);
		expect(tradeButton(html), 'the browser has no way in from the account list').toBeDefined();
	});

	it('appears once per account, not once per screen', () => {
		const two = render([account(), account({ steamId64: '76561198000000002' })]);
		expect(buttons(two).filter((button) => />Trade</.test(button))).toHaveLength(2);
	});

	/*
	 * **A routed account gets both answers, because both are reasonable.**
	 *
	 * A shared proxy address collects rate limits and Cloudflare challenges that
	 * a home connection never sees, so the routed window is sometimes the one
	 * that will not load. Somebody who wants to accept a single trade is better
	 * served by a choice than by a window that fails — and the choice has to be
	 * visible, or they will conclude the feature is broken.
	 */
	it('offers a direct alternative only to an account that is routed', () => {
		const routed = render([account({ hasProxy: true, routing: 'verified' })]);
		expect(tradeButton(routed)).toMatch(/proxied/i);
		expect(directButton(routed), 'a routed account has no way around its proxy').toBeDefined();

		const plain = render([account({ hasProxy: false })]);
		expect(
			directButton(plain),
			'an unrouted account was offered a pointless choice'
		).toBeUndefined();
		expect(tradeButton(plain)).not.toMatch(/proxied/i);
	});

	/*
	 * The direct button is the one that costs something, so it has to say so:
	 * it takes the account's proxy out of the path, and Steam then sees the
	 * address this machine browses from.
	 */
	it('warns that the direct window shows the machine’s own address', () => {
		const routed = render([account({ hasProxy: true, routing: 'verified' })]);
		expect(directButton(routed)).toMatch(/address this machine normally uses/i);
	});

	/**
	 * **And it does not promise a bare connection, because it does not make one.**
	 *
	 * Direct applies `{ mode: 'system' }`, not `direct` — deliberately, and
	 * `window.ts` gives both reasons: the token is minted the same way and the
	 * two halves must not disagree about which address Steam saw, and `direct`
	 * on a network that requires a proxy reaches nothing at all.
	 *
	 * The consequence is that behind a company proxy this button does not show
	 * Steam the machine's own address. The tooltip said it would. Launching
	 * Electron under `--proxy-server=http://127.0.0.1:9` resolves Steam to that
	 * proxy, so the sentence was measurably false for exactly the users most
	 * likely to be behind one.
	 */
	it('does not claim to bypass a system or company proxy', () => {
		const routed = render([account({ hasProxy: true, routing: 'verified' })]);
		expect(directButton(routed), 'the old overclaim is back').not.toMatch(
			/from this machine.s own address/i
		);
		expect(directButton(routed)).toMatch(/network settings still apply/i);
	});

	it('direct and unrouted trade explain how to handle an authenticated system proxy', () => {
		const routed = render([account({ hasProxy: true, routing: 'verified' })]);
		const plain = render([account({ hasProxy: false })]);
		expect(directButton(routed)).toMatch(/asks for a username and password/i);
		expect(directButton(routed)).toMatch(/Proxy field.*proxied route/i);
		expect(tradeButton(plain)).toMatch(/asks for a username and password/i);
		expect(tradeButton(plain)).toMatch(/Proxy field/i);
	});

	it('is not disabled when nothing is being opened', () => {
		expect(tradeButton(render([account()]))).not.toMatch(/disabled/);
	});

	/*
	 * **The third answer, and the one most people actually want.**
	 *
	 * Fully proxied is often the window that will not load, because a market
	 * page pulls far more from CDNs and third-party trade sites than from Steam
	 * itself and a shared proxy address collects every rate limit and Cloudflare
	 * interstitial going. Direct fixes the loading by putting this machine's
	 * address on the account — which is what the proxy was for. Steam-only is
	 * the answer that costs nothing, so it has to be on the row: a mode nobody
	 * can see is a mode nobody uses.
	 */
	it('offers Steam-only to a routed account', () => {
		const routed = render([account({ hasProxy: true, routing: 'verified' })]);
		expect(steamOnlyButton(routed), 'the third routing choice is on no screen').toBeDefined();
	});

	it('offers it only to an account that is routed', () => {
		// Nothing to send Steam *through*, so the mode is not a choice.
		expect(steamOnlyButton(render([account({ hasProxy: false })]))).toBeUndefined();
	});

	/*
	 * The claim that decides whether pressing it is safe. Unlike Direct, this
	 * one costs nothing — but only if it is true, and the user has no way to
	 * check it from here.
	 */
	it('says Steam still goes through the proxy, and says what does not', () => {
		const routed = render([account({ hasProxy: true, routing: 'verified' })]);
		expect(steamOnlyButton(routed)).toMatch(/Steam .*still going through the proxy/i);
		expect(steamOnlyButton(routed)).toMatch(/never sees your real address/i);
	});

	/*
	 * **The tooltip must not overpromise the direct half.**
	 *
	 * An earlier draft said "everything else goes direct", which was true of the
	 * first PAC and is not true of the one that ships: unrecognised hosts stay on
	 * the proxy so that a Steam domain nobody listed cannot leak. Somebody
	 * reading the old sentence would choose this mode expecting a fully fast
	 * window and conclude the feature was broken — or worse, believe a host they
	 * cared about was direct when it was not.
	 */
	it('does not claim everything else goes direct, because it does not', () => {
		const routed = render([account({ hasProxy: true, routing: 'verified' })]);
		expect(steamOnlyButton(routed)).not.toMatch(/everything else[^.]*direct/i);
		expect(steamOnlyButton(routed)).toMatch(/anything else still goes through the proxy/i);
	});

	/*
	 * Three, not two-with-a-toggle. The account list is where every other
	 * per-account decision is already made.
	 */
	it('puts all three routing choices on one row', () => {
		const routed = render([account({ hasProxy: true, routing: 'verified' })]);
		expect(tradeButton(routed)).toBeDefined();
		expect(steamOnlyButton(routed)).toBeDefined();
		expect(directButton(routed)).toBeDefined();
	});

	/*
	 * The one claim on this control that can be false.
	 *
	 * "Through its proxy" is the reassurance an anonymity feature must not give
	 * on faith — the account card already refuses to call an unverified proxy
	 * "routed" for exactly this reason. A tooltip that promises routing to an
	 * account with none would be the same lie in a smaller font.
	 */
	it('promises a proxy only to an account that has one', () => {
		expect(tradeButton(render([account({ hasProxy: true, routing: 'verified' })]))).toMatch(
			/through this account’s proxy/i
		);
		expect(tradeButton(render([account({ hasProxy: false })]))).not.toMatch(
			/through this account’s proxy/i
		);
	});

	/*
	 * The claim the user asked to be sure of. "Routed" must not quietly mean
	 * "routed except for a list nobody was shown".
	 */
	it('says the routed window routes everything', () => {
		expect(tradeButton(render([account({ hasProxy: true, routing: 'verified' })]))).toMatch(
			/everything in the window goes through it/i
		);
	});

	it('says where the window starts, so pressing it is not a guess', () => {
		expect(tradeButton(render([account()]))).toMatch(/trade offers/i);
	});

	/*
	 * The destination is the main process's decision. A URL rendered into this
	 * screen is a URL something that reaches the renderer can change, and the
	 * channel deliberately carries only an account id — so there is nothing here
	 * for the button to send even if it wanted to.
	 */
	it('carries no address of its own', () => {
		expect(tradeButton(render([account()]))).not.toMatch(/https?:/);
	});
});

/**
 * **The vault-wide switch, on the screen it changes.**
 *
 * `Require proxies` was in the vault schema with a docblock describing exactly
 * this behaviour, and nothing implemented it: the button stayed, the window
 * opened, and the setting was decoration. The main process is the control — see
 * `browser-ipc.test.ts` — but a button that only ever produces a refusal is its
 * own defect, so it goes too.
 */
describe('the account list when the vault requires proxies', () => {
	const routed = () => account({ hasProxy: true, routing: 'verified' });

	it('stops offering Direct', () => {
		expect(
			directButton(render([routed()], true)),
			'the way around the proxy is still on the row'
		).toBeUndefined();
	});

	/*
	 * Steam-only goes too. It keeps Steam on the proxy, and it sends a short list
	 * of trade sites straight out from this machine — which is a direct request,
	 * which is what the setting forbids. Leaving the button up would offer a
	 * choice the main process refuses.
	 */
	it('stops offering Steam-only as well', () => {
		expect(steamOnlyButton(render([routed()], true))).toBeUndefined();
	});

	it('keeps the fully routed button, which is the one that still works', () => {
		expect(tradeButton(render([routed()], true))).toBeDefined();
	});

	it('keeps all three when the setting is off', () => {
		const html = render([routed()], false);
		expect(tradeButton(html)).toBeDefined();
		expect(steamOnlyButton(html)).toBeDefined();
		expect(directButton(html)).toBeDefined();
	});

	it('leaves the row alone when the setting is off', () => {
		expect(directButton(render([routed()], false))).toBeDefined();
	});

	/*
	 * An unrouted account keeps its single button. Pressing it is refused by the
	 * main process with a message naming both ways out — which is a better
	 * outcome than a row with no controls at all and no explanation.
	 */
	it('still shows the button on an account with no proxy', () => {
		expect(tradeButton(render([account({ hasProxy: false })], true))).toBeDefined();
	});
});

/**
 * **A form that says "optional" for a field the main process requires.**
 *
 * Under `Require proxies` an enrolment or a transfer with an empty proxy is
 * refused before any credential is sent — correctly. Both screens still called
 * the field optional and offered a submit button, so the user was invited into
 * an action that could only fail.
 */
describe('the enrolment and transfer forms under Require proxies', () => {
	const enrolment = (requireProxies: boolean): string =>
		renderToStaticMarkup(
			<AddAuthenticator
				requireProxies={requireProxies}
				onBegin={() => Promise.resolve({ state: 'needsEmailCode' as const })}
				onEmailCode={() => Promise.resolve({ state: 'needsEmailCode' as const })}
				onCancel={() => Promise.resolve()}
				onResolve={() => Promise.resolve({ ok: true as const })}
				onClearStale={() => Promise.resolve()}
				onActivate={() => Promise.resolve({} as never)}
				onBackup={noop}
				onClose={noop}
				onMove={noop}
			/>
		);

	it('says the proxy is required when it is', () => {
		expect(enrolment(true)).toMatch(/through a proxy \(required\)/);
	});

	it('still says optional when it is not', () => {
		expect(enrolment(false)).toMatch(/through a proxy \(optional\)/);
	});

	/**
	 * **And the hint agrees with the label.**
	 *
	 * The label said "required" and the submit was correctly blocked, while the
	 * paragraph underneath still offered to leave the field empty and use this
	 * machine's own connection. Two instructions, one of them impossible — and
	 * the impossible one was the reassuring one.
	 */
	it('does not offer to leave the field empty when it is required', () => {
		expect(enrolment(true), 'the hint contradicts the label').not.toMatch(
			/Leave empty to use this machine/i
		);
		expect(enrolment(true)).toMatch(/cannot be left empty/i);
	});

	it('still offers it when the field is optional', () => {
		expect(enrolment(false)).toMatch(/Leave empty to use this machine/i);
	});
});
