import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AboutView } from '../src/renderer/screens/About';
import { attribution, branding } from '../src/shared/branding';
import type { AppInfo } from '../src/shared/ipc';

/**
 * The About screen, actually rendered.
 *
 * Rendered rather than read, because the bug this covers was precisely that the
 * values existed and nothing put them on screen. `app:info` had carried the
 * publisher and the attribution strings since the channel was written — the
 * handler calls itself metadata "for the About screen" — and no About screen
 * existed, so all of it crossed the bridge into nothing. A test that inspected
 * the branding module would have passed throughout.
 *
 * `react-dom/server` is used because it is already a dependency. Adding jsdom
 * and a component-testing stack to assert on one screen would be a much larger
 * change to a project that deliberately carries four runtime dependencies.
 */

const INFO: AppInfo = {
	productName: branding.productName,
	version: '1.2.3',
	company: branding.company,
	companyShort: branding.companyShort,
	companyWebsite: branding.companyWebsite,
	website: branding.website,
	repository: branding.repository,
	brandingUnresolved: false,
	platform: 'win32',
	installedFromStore: false,
	notificationsAvailable: true,
	attribution: { mckay: attribution.mckay, valve: attribution.valve },
	security: { sandbox: true, contextIsolation: true, nodeIntegration: false }
};

const render = (info?: AppInfo, error?: string) =>
	renderToStaticMarkup(<AboutView info={info} error={error} onClose={() => {}} />);

describe('the application names its publisher on screen', () => {
	it('says who powers it', () => {
		const html = render(INFO);
		// The whole element, so this can check how it is rendered and not merely
		// that the words exist somewhere in the document. Asserting on the strings
		// alone passed while the paragraph carried `hidden`, which is the one thing
		// that would put it back to where it started: present and invisible.
		const line = /<p class="powered-by"([^>]*)>([\s\S]*?)<\/p>/.exec(html);
		expect(line, 'the publisher line must be on the screen').not.toBeNull();
		expect(line?.[1] ?? '', 'and it must not be hidden').not.toMatch(/hidden|display:\s*none/);
		expect(line?.[2]).toContain('Powered by');
		expect(line?.[2]).toContain(branding.companyShort);
		// And the name is a link somebody can follow, not decoration.
		expect(line?.[2]).toMatch(
			new RegExp(`<a href="${branding.companyWebsite}"[^>]*>${branding.companyShort}</a>`)
		);
	});

	it('gives the full legal name too', () => {
		expect(render(INFO)).toContain(branding.company);
	});

	it('shows the product and version', () => {
		const html = render(INFO);
		expect(html).toContain(branding.productName);
		expect(html).toContain('1.2.3');
	});
});

describe('the chain a suspicious person walks', () => {
	it('links the official site and the source', () => {
		// §4: the running application names a company, the company can be looked
		// up, the repository read, the build checked against it. Both links are on
		// this screen or the chain starts nowhere.
		const html = render(INFO);
		expect(html).toContain(`href="${branding.website}"`);
		expect(html).toContain(`href="${branding.repository}"`);
	});

	it('reports the security posture from the live values', () => {
		const html = render(INFO);
		expect(html).toMatch(/Sandboxed renderer: yes/);
		expect(html).toMatch(/Context isolation: yes/);
		expect(html).toMatch(/Node in the renderer: no/);
	});

	it('says so loudly if a build shipped with placeholder branding', () => {
		const html = render({ ...INFO, brandingUnresolved: true });
		expect(html).toMatch(/should not have been\s+released/);
	});
});

describe('attribution is rendered word for word', () => {
	it('reproduces both strings exactly', () => {
		// §8. Worded to credit without implying endorsement — a distinction that
		// does not survive being reworded in a component, so the test compares
		// against the source of truth rather than a copy typed out here.
		const html = render(INFO);
		const unescape = (s: string) =>
			s
				.replace(/&#x27;/g, "'")
				.replace(/&quot;/g, '"')
				.replace(/&amp;/g, '&');
		expect(unescape(html)).toContain(attribution.mckay);
		expect(unescape(html)).toContain(attribution.valve);
	});

	it('keeps the disclaimers that make it credit rather than endorsement', () => {
		const html = render(INFO);
		expect(html).toContain('not affiliated with or endorsed by DoctorMcKay');
		expect(html).toContain('Not affiliated with, endorsed by, or sponsored by Valve');
	});
});

describe('before the data arrives', () => {
	it('shows a loading state rather than an empty screen', () => {
		expect(render(undefined)).toContain('Loading');
	});

	it('shows the error instead of loading forever', () => {
		const html = render(undefined, 'the bridge went away');
		expect(html).toContain('the bridge went away');
		expect(html).not.toContain('Loading');
	});
});
