import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('the shipping export ownership wiring', () => {
	const app = readFileSync(join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');
	const home = readFileSync(
		join(__dirname, '..', 'src', 'renderer', 'screens', 'VaultHome.tsx'),
		'utf8'
	);

	it('renders notices above the replaceable child screen', () => {
		const notices = app.indexOf('<ExportNotices');
		const child = app.indexOf('{screen()}');
		expect(notices).toBeGreaterThan(-1);
		expect(child).toBeGreaterThan(notices);
	});

	it('settles exports in App and leaves no result owner in VaultHome', () => {
		expect(app).toContain('settleAccountExport(account, mine, request, current');
		expect(home).not.toMatch(/setExported|setExportError/);
		expect(home).toContain('onClick={() => onExport(account)}');
	});
});
