#!/usr/bin/env node
/**
 * scrypt work-factor benchmark (Q6).
 *
 * §10.3 proposes N=131072, r=8, p=1 and asks for a benchmark on low-end hardware
 * before the value is final. Run this on the SLOWEST machine you expect a user to
 * have — the number that matters is how long an unlock takes for them, not for a
 * developer workstation.
 *
 *   node scripts/benchmark-kdf.mjs
 *
 * What you are trading:
 *   Higher N  -> slower for an attacker guessing offline against a stolen vault
 *             -> slower for the user on every single unlock
 *
 * A vault stores its own parameters, so raising N later is a migration rather
 * than a break. Erring slightly low now is recoverable; erring so high that
 * people disable the auto-lock to avoid re-entering a passphrase is not.
 */
import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);

/** Roughly what an unlock should cost on the machine being tested. */
const TARGET_MS = { comfortable: 500, tolerable: 1500 };

const PASSPHRASE = 'benchmark passphrase, length representative of a real one';
const R = 8;
const P = 1;

function memoryMiB(n, r) {
	return (128 * n * r) / 1024 / 1024;
}

async function time(n) {
	const salt = randomBytes(32);
	const maxmem = Math.max(256 * 1024 * 1024, 256 * n * r());
	// One warm-up, then take the best of three: we want the floor cost, not a
	// number polluted by whatever else the machine was doing.
	const runs = [];
	for (let i = 0; i < 4; i++) {
		const started = process.hrtime.bigint();
		await derive(PASSPHRASE, salt, 32, { N: n, r: R, p: P, maxmem });
		const ms = Number(process.hrtime.bigint() - started) / 1e6;
		if (i > 0) runs.push(ms);
	}
	return Math.min(...runs);
}

function r() {
	return R;
}

console.log(`node ${process.version} on ${process.platform}/${process.arch}`);
console.log(`cpus: ${(await import('node:os')).cpus()[0]?.model ?? 'unknown'}`);
console.log(`\n  ${'N'.padStart(8)}  ${'memory'.padStart(9)}  ${'per unlock'.padStart(11)}`);
console.log(`  ${'-'.repeat(8)}  ${'-'.repeat(9)}  ${'-'.repeat(11)}`);

const results = [];
for (const exponent of [14, 15, 16, 17, 18]) {
	const n = 2 ** exponent;
	const ms = await time(n);
	results.push({ n, ms });
	const flag =
		ms <= TARGET_MS.comfortable ? '' : ms <= TARGET_MS.tolerable ? '  <- noticeable' : '  <- slow';
	console.log(
		`  ${String(n).padStart(8)}  ${`${memoryMiB(n, R).toFixed(0)} MiB`.padStart(9)}  ` +
			`${`${ms.toFixed(0)} ms`.padStart(11)}${flag}`
	);
}

const specified = results.find((x) => x.n === 131072);
const best = [...results].reverse().find((x) => x.ms <= TARGET_MS.tolerable);

console.log('\nRecommendation');
if (specified) {
	console.log(
		`  §10.3's N=131072 costs ${specified.ms.toFixed(0)} ms and ${memoryMiB(131072, R).toFixed(0)} MiB here.`
	);
}
if (best) {
	console.log(`  Highest N staying under ${TARGET_MS.tolerable} ms on this machine: ${best.n}.`);
}
console.log(
	'\n  Decide from the SLOWEST machine you tested, not this one. Record the choice\n' +
		'  in §1 and update SCRYPT_DEFAULTS in src/shared/vault-format.ts.'
);
