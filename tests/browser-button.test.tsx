import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VaultHome } from '../src/renderer/screens/VaultHome';
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
		autoConfirm: { marketListings: false, trades: false, pollIntervalSeconds: 30 },
		...overrides
	});
}

const noop = (): void => {};

function render(accounts: AccountSummary[]): string {
	return renderToStaticMarkup(
		<VaultHome
			accounts={accounts}
			codes={undefined}
			msUntilAutoLock={null}
			onCopyCode={() => Promise.resolve({ clipboardClearsInSeconds: 30 })}
			onBackUpRevocationCode={noop}
			onChangeRouting={noop}
			onShowConfirmations={noop}
			onOpenBrowser={() => Promise.resolve({ signInRequired: false })}
			onRemoveAccount={noop}
			onMove={noop}
			onChangeAutoConfirm={noop}
			onImport={noop}
			onRecover={noop}
			onEnrol={noop}
			onFinishActivation={noop}
			onExport={() => Promise.resolve({ written: false } as never)}
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
	 * it puts this machine's address on an account the user chose to route.
	 */
	it('warns that the direct window shows the real address', () => {
		const routed = render([account({ hasProxy: true, routing: 'verified' })]);
		expect(directButton(routed)).toMatch(/real address/i);
	});

	it('is not disabled when nothing is being opened', () => {
		expect(tradeButton(render([account()]))).not.toMatch(/disabled/);
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
		expect(tradeButton(render([account({ hasProxy: false })]))).not.toMatch(/proxy/i);
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
