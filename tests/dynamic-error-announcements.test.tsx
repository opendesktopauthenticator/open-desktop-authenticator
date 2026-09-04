import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DynamicError } from '../src/renderer/DynamicError';
import { VaultHome } from '../src/renderer/screens/VaultHome';
import { accountSummary, type AccountSummary } from '../src/shared/ipc';

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

const noop = (): void => undefined;

describe('dynamic error announcements', () => {
	it('renders one assertive announcement without redundant live-region attributes', () => {
		const html = renderToStaticMarkup(
			<DynamicError id="field-error">Could not save.</DynamicError>
		);
		expect(html.match(/role="alert"/g)).toHaveLength(1);
		expect(html).toContain('aria-atomic="true"');
		expect(html).not.toContain('aria-live=');
		expect(html).toContain('id="field-error"');
	});

	it('announces a code-list failure on the account row exactly once', () => {
		const html = renderToStaticMarkup(
			<VaultHome
				accounts={[ACCOUNT]}
				codes={{
					codes: [],
					failures: [{ steamId64: ACCOUNT.steamId64, reason: 'The saved secret is unreadable.' }],
					clockUnverified: false
				}}
				msUntilAutoLock={null}
				onCopyCode={() => Promise.resolve({ clipboardClearsInSeconds: 30 })}
				onBackUpRevocationCode={noop}
				onChangeRouting={noop}
				onShowConfirmations={noop}
				requireProxies={false}
				onOpenBrowser={() => Promise.resolve({ signInRequired: false })}
				onRemoveAccount={noop}
				onChangeAutoConfirm={noop}
				onImport={noop}
				onRecover={noop}
				onEnrol={noop}
				onMove={noop}
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

		expect(html).toContain('The saved secret is unreadable.');
		expect(html.match(/role="alert"/g)).toHaveLength(1);
	});
});
