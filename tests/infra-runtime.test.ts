import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const BACKUP = readFileSync(join(ROOT, 'infra', 'oda-backup.sh'), 'utf8');
const HEALTH = readFileSync(join(ROOT, 'infra', 'site-health.sh'), 'utf8');
const BASH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const roots: string[] = [];
const HEALTH_TEST_TIMEOUT_MS = 15_000;
const BACKUP_PROCESS_TIMEOUT_MS = 45_000;
const BACKUP_TEST_TIMEOUT_MS = 60_000;

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function posix(path: string): string {
	const slash = path.replaceAll('\\', '/');
	return process.platform === 'win32'
		? slash.replace(/^([A-Za-z]):/, (_all, drive: string) => `/${drive.toLowerCase()}`)
		: slash;
}

/** A Windows-native absolute path Bash and the programs it launches both accept. */
function native(path: string): string {
	return path.replaceAll('\\', '/');
}

function temp(name: string): string {
	// Git Bash is sandboxed from writing through its /c mount in the desktop
	// runner. Keep the executable fixture inside this writable workspace.
	//
	// **And create it.** `tmp/` is gitignored, so it exists on a machine that has
	// run this before and never in a fresh clone — which is every CI checkout.
	// Nineteen cases here failed as `ENOENT ... mkdtemp` on windows-latest, before
	// reaching a single assertion, the first time this file ran anywhere but its
	// author's desktop.
	mkdirSync(join(ROOT, 'tmp'), { recursive: true });
	const value = mkdtempSync(join(ROOT, 'tmp', `${name}-`));
	roots.push(value);
	return value;
}

function executable(path: string, body: string): void {
	writeFileSync(path, `#!/bin/bash\n${body}`, 'utf8');
	chmodSync(path, 0o755);
}

function commonEnv(bin: string): NodeJS.ProcessEnv {
	// Windows treats `Path` and `PATH` as the same key but Node can carry both.
	// Remove the inherited spelling so CreateProcess cannot choose it over the
	// isolated command directory below.
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path')
	);
	const pathName = process.platform === 'win32' ? 'Path' : 'PATH';
	return {
		...inherited,
		[pathName]: `${posix(bin)}:/usr/bin:/bin`,
		REAL_NODE: native(process.execPath)
	};
}

function health(mode: string, value = '42') {
	expect(HEALTH, 'the health script has no testable certificate path').toContain('ODA_CERT_FILE');
	const root = temp('oda-health');
	const bin = join(root, 'bin');
	mkdirSync(bin);
	const log = join(root, 'health.log');
	const cert = join(root, 'cert.pem');
	const bashEnv = join(root, 'bash-env');
	writeFileSync(cert, 'certificate');
	executable(join(bin, 'systemctl'), 'exit 0\n');
	executable(join(bin, 'ufw'), "printf 'Status: active\\n'\n");
	executable(
		join(bin, 'curl'),
		"case \"$*\" in *support/ticket*) printf '404';; *) printf '200';; esac\n"
	);
	executable(join(bin, 'openssl'), "printf 'notAfter=Jan 1 00:00:00 2035 GMT\\n'\n");
	executable(join(bin, 'logger'), 'printf \'%s\\n\' "$*" >> "$TEST_LOG"\n');
	executable(
		join(bin, 'df'),
		`case "$TEST_DF_MODE" in
  fail) exit 7 ;;
  empty) exit 0 ;;
  text) printf 'Use%%\\n 8x%%\\n' ;;
  internal) printf 'Use%%\\n 8 1%%\\n' ;;
  internal-tab) printf 'Use%%\\n 8\\t1%%\\n' ;;
  tabs) printf 'Use%%\\n\\t081%%\\t\\n' ;;
  *) printf 'Use%%\\n %s%%\\n' "$TEST_DF_VALUE" ;;
esac
`
	);
	// Git for Windows prefers a later `curl.exe`/`df.exe` over an earlier
	// extensionless script. BASH_ENV functions are the portable interception
	// point and exercise the shipped script unchanged.
	writeFileSync(
		bashEnv,
		`systemctl() { return 0; }
ufw() { printf 'Status: active\\n'; }
curl() { case "$*" in *support/ticket*) printf '404';; *) printf '200';; esac; }
openssl() { printf 'notAfter=Jan 1 00:00:00 2035 GMT\\n'; }
logger() { printf '%s\\n' "$*" >> "$TEST_LOG"; }
df() {
  case "$TEST_DF_MODE" in
    fail) return 7 ;;
    empty) return 0 ;;
    text) printf 'Use%%\\n 8x%%\\n' ;;
    internal) printf 'Use%%\\n 8 1%%\\n' ;;
    internal-tab) printf 'Use%%\\n 8\\t1%%\\n' ;;
    tabs) printf 'Use%%\\n\\t081%%\\t\\n' ;;
    *) printf 'Use%%\\n %s%%\\n' "$TEST_DF_VALUE" ;;
  esac
}
`
	);
	return {
		log,
		result: spawnSync(BASH, [posix(join(ROOT, 'infra', 'site-health.sh'))], {
			encoding: 'utf8',
			env: {
				...commonEnv(bin),
				BASH_ENV: posix(bashEnv),
				ODA_CERT_FILE: posix(cert),
				TEST_DF_MODE: mode,
				TEST_DF_VALUE: value,
				TEST_LOG: posix(log)
			}
		})
	};
}

describe('the health job disk measurement', { timeout: HEALTH_TEST_TIMEOUT_MS }, () => {
	it.each([
		['a failed command', 'fail', '42'],
		['empty output', 'empty', '42'],
		['non-numeric output', 'text', '42'],
		['internal whitespace', 'internal', '42'],
		['an internal tab', 'internal-tab', '42'],
		['an out-of-range value', 'value', '101']
	])('fails health for %s', (_label, mode, value) => {
		const run = health(mode, value);
		expect(run.result.status).toBe(1);
		expect(readFileSync(run.log, 'utf8')).toMatch(/disk usage probe/i);
	});

	it('warns, but stays healthy, above eighty percent', () => {
		const run = health('value', '81');
		const log = readFileSync(run.log, 'utf8');
		expect(run.result.status, log).toBe(0);
		expect(log).toContain('warning disk 81% full');
	});

	it('accepts tab padding without treating a leading zero as octal', () => {
		const run = health('tabs');
		const log = readFileSync(run.log, 'utf8');
		expect(run.result.status, log).toBe(0);
		expect(log).toContain('warning disk 81% full');
	});

	it('fails above ninety percent', () => {
		const run = health('value', '91');
		expect(run.result.status).toBe(1);
		expect(readFileSync(run.log, 'utf8')).toContain('err disk 91% full');
	});
});

const HOOK_ID = 'a'.repeat(32);

function backup(
	interleave: '' | 'upload-after-snapshot' | 'delete-before-archive' = '',
	fixture: 'consistent' | 'missing' | 'orphan' = 'consistent',
	configFault: '' | 'partial' | 'corrupt' | 'collision' = ''
) {
	expect(BACKUP, 'the backup cannot be executed against an isolated root').toContain(
		'ODA_BACKUP_DEST'
	);
	const root = temp('oda-backup');
	const bin = join(root, 'bin');
	const config = join(root, 'config');
	const tickets = join(root, 'tickets');
	const attachments = join(tickets, 'attachments');
	const destination = join(root, 'backups');
	mkdirSync(bin);
	mkdirSync(attachments, { recursive: true });
	for (const dir of [
		'etc/letsencrypt',
		'etc/nginx',
		'etc/ufw',
		'etc/fail2ban',
		'etc/ssh/sshd_config.d',
		'etc/sysctl.d',
		'usr/local/sbin'
	]) {
		mkdirSync(join(config, dir), { recursive: true });
	}
	writeFileSync(join(config, 'etc/sysctl.d/99-hardening.conf'), 'safe');

	const databasePath = join(tickets, 'tickets.db');
	const db = new DatabaseSync(databasePath);
	db.exec(`CREATE TABLE attachments (id TEXT PRIMARY KEY);`);
	db.prepare('INSERT INTO attachments (id) VALUES (?)').run(HOOK_ID);
	db.close();
	writeFileSync(join(attachments, HOOK_ID), 'attachment');
	if (fixture === 'missing') {
		rmSync(join(attachments, HOOK_ID));
	}
	if (fixture === 'orphan') {
		writeFileSync(join(attachments, 'c'.repeat(32)), 'untracked attachment');
	}

	const state = join(root, 'service-state');
	const trace = join(root, 'trace.log');
	const hook = join(root, 'hook.mjs');
	const bashEnv = join(root, 'bash-env');
	writeFileSync(state, 'active');
	writeFileSync(
		hook,
		`import { DatabaseSync } from 'node:sqlite';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [action, database, files, id] = process.argv.slice(2);
const db = new DatabaseSync(database);
if (action === 'upload') {
  db.prepare('INSERT INTO attachments (id) VALUES (?)').run(id);
  writeFileSync(join(files, id), 'late upload');
} else {
  db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  rmSync(join(files, id), { force: true });
}
db.close();
`
	);

	executable(
		join(bin, 'systemctl'),
		`case "$1" in
  is-active) grep -qx active "$TEST_SERVICE_STATE" ;;
  stop) printf 'stop\\n' >> "$TEST_TRACE"; printf 'stopped' > "$TEST_SERVICE_STATE" ;;
  start) printf 'start\\n' >> "$TEST_TRACE"; printf 'active' > "$TEST_SERVICE_STATE" ;;
  *) exit 2 ;;
esac
`
	);
	executable(join(bin, 'chown'), 'exit 0\n');
	executable(
		join(bin, 'runuser'),
		`while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ "$#" -gt 0 ] && shift
exec "$@"
`
	);
	executable(join(bin, 'logger'), 'printf \'logger %s\\n\' "$*" >> "$TEST_TRACE"\n');
	executable(
		join(bin, 'node'),
		`"$REAL_NODE" "$@"
status=$?
if [ "$status" -eq 0 ] && [ "$TEST_INTERLEAVE" = "upload-after-snapshot" ] && [ ! -e "$TEST_HOOK_DONE" ]; then
  : > "$TEST_HOOK_DONE"
  "$REAL_NODE" "$TEST_HOOK" upload "$TEST_DB" "$TEST_FILES" "$TEST_LATE_ID"
fi
exit "$status"
`
	);
	executable(
		join(bin, 'tar'),
		`if [ "$1" = "-czf" ] && printf '%s\\n' "$(basename "$2")" | grep -q '^\\.config-'; then
  case "$TEST_CONFIG_TAR" in
    partial) printf 'partial archive' > "$2"; exit 7 ;;
    corrupt) printf 'corrupt archive' > "$2"; exit 0 ;;
    collision)
      /usr/bin/tar "$@" || exit $?
      stage_name=$(basename "$2")
      stamp=${'${'}stage_name#.config-}
      stamp=${'${'}stamp%.*.tar.gz}
      printf 'existing archive' > "$(dirname "$2")/config-$stamp.tar.gz"
      exit 0
      ;;
  esac
fi
if printf '%s\\n' "$*" | grep -q 'tickets.db' && [ "$TEST_INTERLEAVE" = "delete-before-archive" ] && [ ! -e "$TEST_HOOK_DONE" ]; then
  : > "$TEST_HOOK_DONE"
  "$REAL_NODE" "$TEST_HOOK" delete "$TEST_DB" "$TEST_FILES" "$TEST_LATE_ID"
fi
printf 'tar %s\\n' "$*" >> "$TEST_TRACE"
exec /usr/bin/tar "$@"
`
	);
	writeFileSync(
		bashEnv,
		`systemctl() {
  case "$1" in
    is-active) grep -qx active "$TEST_SERVICE_STATE" ;;
    stop) printf 'stop\\n' >> "$TEST_TRACE"; printf 'stopped' > "$TEST_SERVICE_STATE" ;;
    start) printf 'start\\n' >> "$TEST_TRACE"; printf 'active' > "$TEST_SERVICE_STATE" ;;
    *) return 2 ;;
  esac
}
chown() { return 0; }
runuser() {
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
  [ "$#" -gt 0 ] && shift
  "$@"
}
logger() { printf 'logger %s\\n' "$*" >> "$TEST_TRACE"; }
node() {
  printf 'snapshot\\n' >> "$TEST_TRACE"
  "$REAL_NODE" "$@"
  status=$?
  if [ "$status" -eq 0 ] && [ "$TEST_INTERLEAVE" = "upload-after-snapshot" ] && [ ! -e "$TEST_HOOK_DONE" ]; then
    : > "$TEST_HOOK_DONE"
    "$REAL_NODE" "$TEST_HOOK" upload "$TEST_DB" "$TEST_FILES" "$TEST_LATE_ID"
  fi
  return "$status"
}
tar() {
  if [ "$1" = "-czf" ] && printf '%s\\n' "$(basename "$2")" | grep -q '^\\.config-'; then
    case "$TEST_CONFIG_TAR" in
      partial) printf 'partial archive' > "$2"; return 7 ;;
      corrupt) printf 'corrupt archive' > "$2"; return 0 ;;
      collision)
        /usr/bin/tar "$@" || return $?
        stage_name=$(basename "$2")
        stamp=${'${'}stage_name#.config-}
        stamp=${'${'}stamp%.*.tar.gz}
        printf 'existing archive' > "$(dirname "$2")/config-$stamp.tar.gz"
        return 0
        ;;
    esac
  fi
  if printf '%s\\n' "$*" | grep -q 'tickets.db' && [ "$TEST_INTERLEAVE" = "delete-before-archive" ] && [ ! -e "$TEST_HOOK_DONE" ]; then
    : > "$TEST_HOOK_DONE"
    "$REAL_NODE" "$TEST_HOOK" delete "$TEST_DB" "$TEST_FILES" "$TEST_LATE_ID"
  fi
  printf 'tar %s\\n' "$*" >> "$TEST_TRACE"
  /usr/bin/tar "$@"
}
`
	);

	const result = spawnSync(BASH, [posix(join(ROOT, 'infra', 'oda-backup.sh'))], {
		encoding: 'utf8',
		timeout: BACKUP_PROCESS_TIMEOUT_MS,
		env: {
			...commonEnv(bin),
			BASH_ENV: posix(bashEnv),
			ODA_BACKUP_DEST: posix(destination),
			ODA_CONFIG_ROOT: posix(config),
			ODA_TICKETS_DIR: posix(tickets),
			ODA_TICKETS_UNIT: 'tickets',
			TEST_DB: posix(databasePath),
			TEST_FILES: posix(attachments),
			TEST_HOOK: posix(hook),
			TEST_HOOK_DONE: posix(join(root, 'hook-done')),
			TEST_CONFIG_TAR: configFault,
			TEST_INTERLEAVE: interleave,
			TEST_LATE_ID: interleave === 'upload-after-snapshot' ? 'b'.repeat(32) : HOOK_ID,
			TEST_SERVICE_STATE: posix(state),
			TEST_TRACE: posix(trace)
		}
	});
	if (result.error !== undefined) throw result.error;
	if (result.signal !== null) throw new Error(`backup harness ended on signal ${result.signal}`);
	return { attachments, destination, result, state, trace };
}

describe('configuration backup publication', { timeout: BACKUP_TEST_TIMEOUT_MS }, () => {
	it(
		'publishes one private archive only after it can be read back',
		() => {
			const run = backup();
			expect(run.result.status, run.result.stderr).toBe(0);
			const names = readdirSync(run.destination);
			const configs = names.filter((name) => /^config-.*\.tar\.gz$/.test(name));
			expect(configs).toHaveLength(1);
			expect(names.some((name) => name.startsWith('.config-'))).toBe(false);
			if (process.platform !== 'win32') {
				expect(statSync(join(run.destination, configs[0]!)).mode & 0o777).toBe(0o600);
			}
			const readBack = spawnSync(
				BASH,
				['-c', `tar -tzf "${posix(join(run.destination, configs[0]!))}"`],
				{
					encoding: 'utf8',
					timeout: BACKUP_PROCESS_TIMEOUT_MS
				}
			);
			expect(readBack.status, readBack.stderr).toBe(0);
			expect(readBack.stdout).toContain('etc/nginx/');
		},
		BACKUP_TEST_TIMEOUT_MS
	);

	it.each(['partial', 'corrupt'] as const)(
		'removes every visible archive after a %s configuration write',
		(fault) => {
			const run = backup('', 'consistent', fault);
			expect(run.result.status).not.toBe(0);
			expect(readdirSync(run.destination)).toEqual([]);
		}
	);

	it('does not overwrite another run that already owns the final name', () => {
		const run = backup('', 'consistent', 'collision');
		expect(run.result.status).not.toBe(0);
		const names = readdirSync(run.destination);
		const final = names.filter((name) => /^config-.*\.tar\.gz$/.test(name));
		expect(final).toHaveLength(1);
		expect(readFileSync(join(run.destination, final[0]!), 'utf8')).toBe('existing archive');
		expect(names.some((name) => name.startsWith('.config-'))).toBe(false);
	});
});

describe('a consistent ticket backup', { timeout: BACKUP_TEST_TIMEOUT_MS }, () => {
	it(
		'freezes the snapshot and files before writes resume, and includes the checked manifest',
		() => {
			const run = backup();
			expect(run.result.stderr).toBe('');
			expect(run.result.status).toBe(0);
			expect(readFileSync(run.state, 'utf8')).toBe('active');
			const calls = readFileSync(run.trace, 'utf8');
			expect(calls.indexOf('stop')).toBeLessThan(calls.indexOf('snapshot'));
			expect(calls.indexOf('snapshot')).toBeLessThan(calls.indexOf('start'));
			expect(calls.indexOf('start')).toBeLessThan(calls.indexOf('tickets.db'));
			const archive = readdirSync(run.destination).find((name) =>
				/^tickets-.*\.tar\.gz$/.test(name)
			);
			expect(archive).toBeDefined();
			const listed = spawnSync(
				BASH,
				['-c', `tar -tzf "${posix(join(run.destination, archive!))}"`],
				{
					encoding: 'utf8',
					timeout: BACKUP_PROCESS_TIMEOUT_MS
				}
			);
			expect(listed.error).toBeUndefined();
			expect(listed.signal).toBeNull();
			expect(listed.status).toBe(0);
			expect(listed.stdout).toContain('attachments.manifest');
			expect(listed.stdout).toContain(`attachments/${HOOK_ID}`);
		},
		BACKUP_TEST_TIMEOUT_MS
	);

	it('rejects an upload that lands after the database snapshot', () => {
		const run = backup('upload-after-snapshot');
		expect(run.result.status).not.toBe(0);
		expect(run.result.stderr).toMatch(/attachment manifest/i);
		expect(readFileSync(run.state, 'utf8')).toBe('active');
	});

	it(
		'keeps the snapshotted bytes when a deletion lands immediately before archival',
		() => {
			const run = backup('delete-before-archive');
			expect(run.result.status).toBe(0);
			expect(readFileSync(run.state, 'utf8')).toBe('active');
			const archive = readdirSync(run.destination).find((name) =>
				/^tickets-.*\.tar\.gz$/.test(name)
			);
			const listed = spawnSync(
				BASH,
				['-c', `tar -tzf "${posix(join(run.destination, archive!))}"`],
				{
					encoding: 'utf8',
					timeout: BACKUP_PROCESS_TIMEOUT_MS
				}
			);
			expect(listed.error).toBeUndefined();
			expect(listed.signal).toBeNull();
			expect(listed.status).toBe(0);
			expect(listed.stdout).toContain(`attachments/${HOOK_ID}`);
		},
		BACKUP_TEST_TIMEOUT_MS
	);

	it.each([
		['a missing file', 'missing'],
		['an orphan file', 'orphan']
	] as const)('rejects %s rather than reporting a partial backup', (_label, fixture) => {
		const run = backup('', fixture);
		expect(run.result.status).not.toBe(0);
		expect(run.result.stderr).toMatch(/attachment manifest/i);
		expect(readFileSync(run.state, 'utf8')).toBe('active');
	});
});
