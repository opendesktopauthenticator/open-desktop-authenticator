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

describe('ticket-service shutdown coordination', () => {
	const ticketServer = readFileSync(join(__dirname, '../tickets/server.mjs'), 'utf8');
	const ticketUnit = readFileSync(join(INFRA, 'systemd', 'tickets.service'), 'utf8');

	it('gives application cleanup time before systemd may force-kill it', () => {
		const applicationDeadline = /SHUTDOWN_DEADLINE_MS\s*=\s*([\d_]+)/.exec(ticketServer)?.[1];
		const systemdDeadline = /^TimeoutStopSec=(\d+)s$/m.exec(ticketUnit)?.[1];
		expect(applicationDeadline, 'the service has no bounded cleanup deadline').toBeDefined();
		expect(systemdDeadline, 'systemd can kill the service on its implicit default').toBeDefined();
		expect(ticketServer).toMatch(
			/function shutdownTicketServer\(\{ forceAfterMs = SHUTDOWN_DEADLINE_MS \} = \{\}\)/
		);

		const applicationMs = Number(applicationDeadline?.replaceAll('_', ''));
		const systemdMs = Number(systemdDeadline) * 1000;
		expect(applicationMs).toBeGreaterThan(0);
		expect(
			systemdMs,
			'systemd kills the service before its own cleanup can finish'
		).toBeGreaterThan(applicationMs);
	});
});

/*
 * The scheduled jobs have to survive the states a real box is actually in.
 */
describe('the backup job', () => {
	const backup = readFileSync(join(__dirname, '../infra/oda-backup.sh'), 'utf8');

	it('does not hand tar a directory that may not exist', () => {
		// The service creates `attachments/` lazily on the first upload. The
		// consistency design now turns either state into a manifest and gives tar
		// only the exact file list, so an absent directory is an ordinary empty
		// list rather than a missing tar operand.
		expect(backup).toContain('if [ -d "$attachments_dir" ]; then');
		expect(backup).toContain(': > "$snapshot/attachments.manifest"');
		expect(backup).toContain('--files-from="$snapshot/archive-files.list"');
		expect(backup).not.toMatch(/-C \/var\/lib\/tickets attachments/);
	});

	it('no longer hides tar failures on the reports archive', () => {
		const reports = backup.slice(backup.indexOf('# ── reports and attachments'));
		expect(reports).not.toContain('attachments 2>/dev/null');
	});

	/**
	 * **Retention must not fail open.**
	 *
	 * `! -newermt '90 days ago'` parses that string at runtime, and the first
	 * version of it ended `2>/dev/null || true` — which hides the error *and* the
	 * exit status. A findutils build or a locale that could not read the date
	 * would have turned ticket retention off permanently and silently, while the
	 * job went on logging success. A privacy page promising deletion in ninety
	 * days cannot be backed by a sweep that fails open.
	 */
	it('does not swallow a cutoff it could not compute', () => {
		const sweep = backup.slice(backup.indexOf('find "$dest" -name \'tickets-*.tar.gz\''));
		expect(
			sweep,
			'the ticket sweep hides its own failure, so an unparseable date disables retention ' +
				'for ever while the job still reports success'
		).not.toContain('2>/dev/null || true');
	});

	/*
	 * And the sense of the comparison, which one dropped character inverts:
	 * without the `!`, this deletes everything NEWER than the cutoff and keeps
	 * the old archives for ever — the exact opposite of a retention sweep.
	 */
	it('deletes what is older than the cutoff, not what is newer', () => {
		expect(backup, 'the retention sweep is inverted').toMatch(
			/find "\$dest" -name 'tickets-\*\.tar\.gz' ! -newermt "\$cutoff" -delete/
		);
	});

	/*
	 * The runtime check is what catches the rest of the family — a dropped "ago"
	 * resolves to a date in the *future*, which would delete every ticket archive
	 * on every run. Asserted here so the guard cannot be quietly removed.
	 */
	it('refuses to sweep with a cutoff that is not about ninety days old', () => {
		expect(backup, 'nothing checks the cutoff before it is used').toContain('cutoff_age');
		expect(backup).toMatch(/refusing to sweep/);
	});
});

describe('the health job', () => {
	const health = readFileSync(join(__dirname, '../infra/site-health.sh'), 'utf8');

	it('checks the ticket service, not only nginx and /', () => {
		// `/support` and `/admin` proxy_pass to 127.0.0.1:8787, so when the unit
		// is dead they 502 while `/` still answers 200 — and this job logged "ok"
		// through an outage of report submission, reporter access and the admin
		// queue alike.
		expect(health).toContain('systemctl is-active --quiet tickets');
		expect(health).toContain('/support');
	});
});

describe('the ticket health probe', () => {
	const health = readFileSync(join(__dirname, '../infra/site-health.sh'), 'utf8');
	const nginx = readFileSync(join(__dirname, '../infra/nginx/sites-available/oda'), 'utf8');

	it('probes a route nginx actually proxies', () => {
		// `/support` is served by `try_files` from support.html, so it answered
		// 200 with the ticket service dead. Only the ticket and admin sub-paths
		// reach Node.
		expect(health).toContain('/support/ticket/');
		expect(health).not.toMatch(/com\/support 2>/);
	});

	it('expects the answer only Node can give', () => {
		// A 404 for an unknown reference comes from the service; a dead or hung
		// one gives 502/504 from nginx instead.
		expect(health).toMatch(/"\$ticket" != "404"/);
	});

	it('probes a path the nginx config really sends upstream', () => {
		// The guard against picking another statically-served path next time.
		expect(nginx).toMatch(/support\/ticket/);
	});
});
