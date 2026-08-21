import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PassphraseChange } from '../src/renderer/screens/Settings';

/*
 * The passphrase-change form actually reaches the screen.
 *
 * The complete operation — service, IPC channel, preload bridge — existed with
 * no renderer calling it, so there was no legitimate way to rotate a weak or
 * shoulder-surfed passphrase short of exporting every account and rebuilding
 * the vault. The form itself renders here; the wiring assertions prove the
 * screen mounts it and the app hands it the real bridge.
 */

const html = renderToStaticMarkup(<PassphraseChange onChange={() => Promise.resolve()} />);

describe('the passphrase-change form', () => {
	it('asks for the current passphrase and the new one twice', () => {
		expect(html).toContain('id="passphrase-current"');
		expect(html).toContain('id="passphrase-next"');
		expect(html).toContain('id="passphrase-confirm"');
	});

	it('masks every field', () => {
		expect(html.match(/type="password"/g) ?? []).toHaveLength(3);
	});

	it('starts disabled, so an empty submit is not offered', () => {
		expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
	});

	it('says plainly that there is no recovery', () => {
		expect(html).toMatch(/no recovery/i);
	});
});
