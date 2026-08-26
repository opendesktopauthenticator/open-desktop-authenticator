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

const tradeButton = (html: string): string | undefined =>
	buttons(html).find((button) => button.includes('>Trade<'));

describe('the trade button', () => {
	it('is on the row, and reachable without opening anything first', () => {
		const html = render([account()]);
		expect(tradeButton(html), 'the browser has no way in from the account list').toBeDefined();
	});

	it('appears once per account, not once per screen', () => {
		const two = render([account(), account({ steamId64: '76561198000000002' })]);
		expect(buttons(two).filter((button) => button.includes('>Trade<'))).toHaveLength(2);
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
			/through its proxy/i
		);
		expect(tradeButton(render([account({ hasProxy: false })]))).not.toMatch(/proxy/i);
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
