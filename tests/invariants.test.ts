import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Tripwires for promises made in docs/THREAT_MODEL.md.
 *
 * A trust document that says "X never appears in this codebase" is only worth
 * something if breaking it fails the build. Otherwise the doc quietly becomes
 * fiction and nobody notices until a reader checks.
 *
 * Some of these guard code that does not exist yet. That is deliberate — the
 * tripwire should be armed before the code arrives, not bolted on after.
 */

const ROOT = join(__dirname, '..');

function sourceFiles(dir: string, acc: string[] = []): string[] {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return acc;
	}
	for (const entry of entries) {
		if (entry === 'node_modules' || entry === 'dist' || entry === 'out') continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			sourceFiles(full, acc);
		} else if (/\.(ts|tsx)$/.test(entry)) {
			acc.push(full);
		}
	}
	return acc;
}

/** Application source plus the spike, which does use steamcommunity today. */
const files = [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'spike', 'src'))];

/**
 * Strip comments before scanning.
 *
 * Without this, these checks fire on the comments that explain *why* the
 * forbidden calls are forbidden — punishing exactly the documentation we want.
 * The `://` guard keeps URLs in string literals from truncating a line.
 */
function code(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Files whose executable code matches, ignoring comments. */
function offenders(pattern: RegExp): string[] {
	return files.filter((f) => pattern.test(code(readFileSync(f, 'utf8'))));
}

describe('S16 — auto-confirm type allowlist (THREAT_MODEL §3.1)', () => {
	it('scans a non-trivial number of files', () => {
		// Guards against the whole suite silently passing because the walker broke.
		expect(files.length).toBeGreaterThan(10);
	});

	it('never calls acceptAllConfirmations', () => {
		// It accepts everything the list returns, by design — including the
		// account-recovery confirmations (type 6) that mobileconf also serves.
		// Using it would auto-approve account takeovers.
		expect(offenders(/\bacceptAllConfirmations\s*\(/)).toEqual([]);
	});

	it('never calls acceptConfirmationForObject', () => {
		// Same hazard: the convenience helper acts on whatever it matches, with no
		// opportunity to filter by confirmation type.
		expect(offenders(/\bacceptConfirmationForObject\s*\(/)).toEqual([]);
	});

	it('the comment stripper does not blind the scan', () => {
		// If code() ever over-stripped, every check above would pass vacuously.
		expect(code('const x = 1; // acceptAllConfirmations(')).toContain('const x = 1;');
		expect(code('foo(); /* acceptAllConfirmations( */ bar();')).toContain('bar();');
		expect(code("const u = 'https://x'; acceptAllConfirmations();")).toContain(
			'acceptAllConfirmations()'
		);
	});
});

describe('§7.2 — non-goals stay out of the codebase', () => {
	it('does not depend on steam-user', () => {
		for (const manifest of ['package.json', 'spike/package.json']) {
			const pkg = JSON.parse(readFileSync(join(ROOT, manifest), 'utf8')) as {
				dependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
			};
			const all = { ...pkg.dependencies, ...pkg.devDependencies };
			// A full Steam client for bots. Forbidden surface, explicitly (§9.2).
			expect(Object.keys(all), manifest).not.toContain('steam-user');
			// Abandoned; §9.2 forbids it by name.
			expect(Object.keys(all), manifest).not.toContain('keytar');
		}
	});

	it('ships no analytics or telemetry dependency', () => {
		const forbidden = [
			'@sentry/electron',
			'@sentry/node',
			'posthog-node',
			'mixpanel',
			'analytics-node',
			'@amplitude/analytics-node'
		];
		const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
		for (const name of forbidden) {
			expect(all, `${name} is telemetry; §7.2 forbids it including opt-in`).not.toContain(name);
		}
	});
});
