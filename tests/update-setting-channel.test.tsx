import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UpdateCheckSetting } from '../src/renderer/screens/Settings';

/**
 * What the settings screen offers, per Windows channel.
 *
 * The same binary reaches users two ways, and in one of them the update check
 * is refused before it reads this preference — so the toggle would change
 * nothing while its own help text described a request to GitHub that is never
 * made. That is the failure this screen already refuses elsewhere, in the notice
 * about vault options that exist in the format but are not implemented: a
 * control that appears to do something it does not.
 *
 * Rendered rather than inspected, because the mistake worth catching is a branch
 * that is present in the source and draws the wrong thing — or both things.
 */

const html = (installedFromStore: boolean): string =>
	renderToStaticMarkup(
		<UpdateCheckSetting
			installedFromStore={installedFromStore}
			checked
			onChange={() => undefined}
		/>
	);

describe('a Store build', () => {
	const markup = html(true);

	it('says Windows does the updating', () => {
		expect(markup).toContain('Microsoft Store');
		expect(markup).toContain('keeps it up to date');
	});

	it('draws no checkbox at all', () => {
		expect(markup, 'a switch that cannot do anything must not be rendered').not.toContain(
			'type="checkbox"'
		);
	});

	it('does not describe a GitHub request it will never make', () => {
		expect(markup).not.toContain('Asks GitHub');
		expect(markup).not.toContain('Tell me when a new version is released');
	});
});

describe('a direct-download build', () => {
	const markup = html(false);

	it('still offers the checkbox', () => {
		expect(markup).toContain('type="checkbox"');
		expect(markup).toContain('Tell me when a new version is released');
	});

	it('still states exactly what the request is', () => {
		// The README promises no telemetry, and this is the only non-Steam request
		// the application makes. The description is what makes that checkable, so
		// it must survive the channel split.
		expect(markup).toContain('Asks GitHub once every few hours');
		expect(markup).toContain('It never downloads or installs anything');
	});

	it('reflects the current value rather than a fixed one', () => {
		const off = renderToStaticMarkup(
			<UpdateCheckSetting installedFromStore={false} checked={false} onChange={() => undefined} />
		);
		expect(markup).toContain('checked=""');
		expect(off).not.toContain('checked=""');
	});
});
