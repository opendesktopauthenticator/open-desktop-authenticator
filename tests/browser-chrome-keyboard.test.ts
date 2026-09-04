import { describe, expect, it } from 'vitest';
import { CHROME_HTML } from '../src/main/browser/chrome-html';

/**
 * The real Electron smoke drives these handlers. This suite pins their semantic
 * surface in the ordinary unit gate, so removing one keyboard branch cannot wait
 * for a packaged-browser run to be noticed.
 */
describe('in-app browser tab semantics', () => {
	it('exposes a named tablist with selected, roving tabs', () => {
		expect(CHROME_HTML).toContain('role="tablist" aria-label="Browser tabs"');
		expect(CHROME_HTML).toContain("select.setAttribute('role', 'tab')");
		expect(CHROME_HTML).toContain("select.setAttribute('aria-selected'");
		expect(CHROME_HTML).toContain('select.tabIndex = tab.active ? 0 : -1');
		expect(CHROME_HTML).toContain("select.setAttribute('aria-label'");
	});

	it('supports spatial focus, explicit activation and keyboard closing', () => {
		for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
			expect(CHROME_HTML).toContain(`event.key === '${key}'`);
		}
		expect(CHROME_HTML).toContain("event.key === 'Enter' || event.key === ' '");
		expect(CHROME_HTML).toContain('window.odaBrowser.selectTab(tab.id, true)');
		expect(CHROME_HTML).toContain("event.key === 'Delete'");
		expect(CHROME_HTML).toContain('choices[destination].focus()');
	});

	it('uses a labelled native button for close and repairs focus after it', () => {
		expect(CHROME_HTML).toContain("var close = document.createElement('button')");
		expect(CHROME_HTML).toContain("close.setAttribute('aria-label'");
		expect(CHROME_HTML).toContain('focusAfterClose = neighbour ? String(neighbour.id)');
		expect(CHROME_HTML).toContain('window.odaBrowser.closeTab(tab.id, true)');
		expect(CHROME_HTML).toContain('candidate.focus()');
	});

	it('keeps the existing pointer and middle-click paths', () => {
		expect(CHROME_HTML).toContain('event.button === 1');
		expect(CHROME_HTML).toContain('window.odaBrowser.closeTab(tab.id)');
		expect(CHROME_HTML).toContain('window.odaBrowser.selectTab(tab.id)');
	});
});
