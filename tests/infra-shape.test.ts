import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The files that go onto the box, checked for the things that break silently.
 *
 * `infra/` is the rebuild source. Nothing here is compiled, linted or run by the
 * test suite, so a file in this directory can be wrong for weeks and the only
 * symptom appears on a server at 03:00.
 *
 * Three failures already happened, and all three are covered here:
 *
 *   A **zero-byte unit file.** `oda-backup.service` was empty in the repository
 *   while a working copy existed only on the live box. Rebuilding from the repo
 *   would have installed an enabled daily timer pointing at a service that does
 *   nothing — and a timer with no work to do reports a perfectly healthy
 *   schedule while producing no backups.
 *
 *   **CRLF line endings.** Deploying a script written on Windows gave the kernel
 *   a shebang of `#!/bin/bash` with a carriage return glued to it, which is not
 *   a path to anything. systemd reported `203/EXEC` and the backup did not run.
 *   `.gitattributes` normalises on commit, but deployment copies the working
 *   tree — so committed-LF is not the property that matters, on-disk LF is.
 *
 *   **A unit pointing at a name that moved.** The improved script was deployed
 *   as `oda-backup` while the unit still called `oda-backup.sh`, so the timer
 *   went on running an older copy — the one with no ticket-database backup in
 *   it — and reported success every night for doing half the job.
 */

const INFRA = join(__dirname, '..', 'infra');
const CR = String.fromCharCode(13);
const SEP = String.fromCharCode(92);

/** Every regular file under infra/, recursively. */
function filesUnder(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? filesUnder(path) : [path];
	});
}

const files = filesUnder(INFRA);
const relative = (p: string) =>
	p
		.slice(INFRA.length + 1)
		.split(SEP)
		.join('/');
const named = (list: string[]) => list.map((f) => [relative(f), f] as const);

describe('what gets copied to the server', () => {
	it('finds the infra directory at all', () => {
		// If this ever reads an empty directory the rest of the file passes
		// vacuously, which is the failure mode these tests exist to catch.
		expect(files.length).toBeGreaterThan(5);
	});

	it.each(named(files))('%s has no carriage returns', (_name, path) => {
		expect(readFileSync(path, 'utf8')).not.toContain(CR);
	});

	it.each(named(files))('%s is not empty', (_name, path) => {
		expect(statSync(path).size).toBeGreaterThan(0);
	});

	it.each(named(files.filter((f) => f.endsWith('.sh'))))(
		'%s starts with a usable shebang',
		(_name, path) => {
			const first = readFileSync(path, 'utf8').split('\n')[0];
			expect(first).toMatch(/^#!\/(usr\/)?bin\/(env )?(ba)?sh$/);
		}
	);

	it('every unit a timer activates exists and runs something', () => {
		const timers = files.filter((f) => f.endsWith('.timer'));
		expect(timers.length, 'there is at least one timer to check').toBeGreaterThan(0);

		for (const timer of timers) {
			const service = timer.replace(/\.timer$/, '.service');
			expect(files, `${relative(timer)} activates a unit that is not in the repo`).toContain(
				service
			);
			expect(readFileSync(service, 'utf8'), `${relative(service)} runs nothing`).toMatch(
				/^ExecStart=\S/m
			);
		}
	});

	it('every ExecStart names a script that is in the repo', () => {
		const scripts = new Set(files.filter((f) => f.endsWith('.sh')).map(relative));
		const prefix = '/usr/local/sbin/';
		let checked = 0;

		for (const unit of files.filter((f) => f.endsWith('.service'))) {
			for (const line of readFileSync(unit, 'utf8').split('\n')) {
				const command = /^ExecStart=(\S+)/.exec(line)?.[1];
				if (!command?.startsWith(prefix)) continue;
				checked += 1;
				const name = command.slice(prefix.length);
				expect(
					scripts.has(`${name}.sh`) || scripts.has(name),
					`${relative(unit)} runs ${command}, which has no source in infra/`
				).toBe(true);
			}
		}

		expect(checked, 'no ExecStart was examined, so this proved nothing').toBeGreaterThan(0);
	});
});
