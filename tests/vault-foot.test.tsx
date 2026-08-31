import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VaultHome } from '../src/renderer/screens/VaultHome';
import { branding } from '../src/shared/branding';
import { accountSummary, type AccountSummary } from '../src/shared/ipc';

/**
 * The publisher mark at the foot of the vault screen.
 *
 * The About screen carries the full account of who builds this, but somebody has
 * to go looking for it — and the complaint was that the application named its
 * publisher nowhere a person would actually see. This is the screen people sit
 * on, so this is where the claim has to hold.
 *
 * Rendered rather than read, for the same reason as the About tests: the whole
 * class of bug here is a value that exists and is never put on screen.
 */

/*
 * Built from the schema rather than invented.
 *
 * The first version of this fixture was written from memory and had three
 * fields wrong — a status that is not in the enum, an object where `routing` is
 * a string, and a missing `pollIntervalSeconds`. Every assertion still passed,
 * because vitest does not type-check; only `tsc` caught it. Parsing a plausible
 * object through the real schema means the fixture cannot drift from the type
 * it claims to be.
 */
const ACCOUNT: AccountSummary = accountSummary.parse({
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
	}
});

const noop = (): void => {};
const render = (accounts: AccountSummary[]) =>
	renderToStaticMarkup(
		<VaultHome
			accounts={accounts}
			codes={undefined}
			msUntilAutoLock={null}
			onCopyCode={() => Promise.resolve({ clipboardClearsInSeconds: 30 })}
			onBackUpRevocationCode={noop}
			onChangeRouting={noop}
			onShowConfirmations={noop}
			requireProxies={false}
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

describe('the vault screen names its publisher', () => {
	it('shows the mark under the account list', () => {
		const html = render([ACCOUNT]);
		const foot = /<footer class="app-foot"([^>]*)>([\s\S]*?)<\/footer>/.exec(html);
		expect(foot, 'the foot must be on the screen').not.toBeNull();
		// Checked on the element rather than the strings: asserting the words appear
		// somewhere stays true while the element is hidden, which is the state this
		// is meant to have moved away from.
		expect(foot?.[1] ?? '').not.toMatch(/hidden|display:\s*none/);
		expect(foot?.[2]).toContain('Powered by');
		expect(foot?.[2]).toContain(branding.companyShort);
	});

	it('shows it on an empty vault too', () => {
		// A fresh install is the first thing a new user sees, and the first moment
		// somebody wonders who wrote the software now holding their Steam Guard.
		const html = render([]);
		expect(html).toMatch(/<footer class="app-foot"/);
		expect(html).toContain(branding.companyShort);
	});

	it('shows the company logo beside the words', () => {
		// The words alone were the first version. A mark is what makes it read as a
		// publisher's stamp rather than a line of small print, and it is the thing
		// somebody recognises before they read anything.
		const foot = /<footer class="app-foot"[^>]*>([\s\S]*?)<\/footer>/.exec(render([ACCOUNT]));
		expect(foot?.[1]).toMatch(/<svg[^>]*class="powered-logo"/);
		// Drawn inline rather than fetched: the renderer's policy allows
		// `img-src 'self' data:` only, and an <img> here would be one more thing
		// that can be missing at runtime while the code looks right.
		expect(foot?.[1]).not.toMatch(/<img/);
		expect(foot?.[1]).toMatch(/<path[^>]*fill="#00BE62"/);
	});

	it('does not announce the logo twice to a screen reader', () => {
		// The company name is already in the text beside it.
		const foot = /<footer class="app-foot"[^>]*>([\s\S]*?)<\/footer>/.exec(render([ACCOUNT]));
		expect(foot?.[1]).toMatch(/<svg[^>]*aria-hidden="true"/);
	});

	it('is a control that opens About rather than dead text', () => {
		const html = render([ACCOUNT]);
		expect(html).toMatch(/<button[^>]*class="powered-mark"/);
	});

	it('does not push itself ahead of the codes', () => {
		// The reason this window is open is the codes. If the brand ever renders
		// before the account list, the trade has gone the wrong way.
		const html = render([ACCOUNT]);
		expect(html.indexOf('app-foot')).toBeGreaterThan(html.indexOf('class="accounts"'));
	});
});
