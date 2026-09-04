import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(__dirname, '../infra/cloudflare-only.sh');
const bashCandidate =
	process.platform === 'win32'
		? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find(
				(path) => existsSync(path)
			)
		: 'bash';

if (bashCandidate === undefined) {
	throw new Error('Git Bash is required to test the server firewall script on Windows');
}
const BASH: string = bashCandidate;

const dirs: string[] = [];
const shellPath = (path: string): string => {
	const slashes = path.replaceAll('\\', '/');
	return process.platform === 'win32'
		? `/${slashes[0]?.toLowerCase()}${slashes.slice(2)}`
		: slashes;
};

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface StatusAnswer {
	output: string;
	exit?: number;
}

function run(
	statuses: StatusAnswer[],
	args: string[] = [],
	emptyIpv6 = false,
	fail2banAfterStatus = 0
): {
	status: number | null;
	stdout: string;
	stderr: string;
	ufwCalls: string[];
} {
	const dir = mkdtempSync(join(tmpdir(), 'oda-cloudflare-firewall-'));
	dirs.push(dir);
	const responses = join(dir, 'responses');
	const log = join(dir, 'ufw.log');
	writeFileSync(join(dir, 'status-count'), '0');
	writeFileSync(log, '');
	for (const [index, answer] of statuses.entries()) {
		writeFileSync(join(dir, `status-${index + 1}.out`), answer.output);
		writeFileSync(join(dir, `status-${index + 1}.exit`), String(answer.exit ?? 0));
	}
	// Once the prepared answers are exhausted, repeat the last one. This keeps a
	// test about the final property independent of how many stale rules precede it.
	writeFileSync(responses, String(statuses.length));

	const ufw = `#!/bin/bash
set -u
if [ "\${1:-}" = --force ] && [ "\${2:-}" = delete ] && [ "$FAIL2BAN_AFTER_STATUS" -gt 0 ] && [ ! -e "$UFW_DIR/fail2ban-inserted" ]; then
  inspected=$(cat "$UFW_DIR/status-count")
  if [ "$inspected" -ge "$FAIL2BAN_AFTER_STATUS" ]; then
    : > "$UFW_DIR/fail2ban-inserted"
    printf '%s\\n' 'external fail2ban: insert 1 deny from 198.51.100.9' >> "$UFW_LOG"
    if [[ "\${3:-}" =~ ^[0-9]+$ ]]; then
      echo 'a numbered delete targeted the wrong rule after fail2ban renumbered it' >&2
      exit 66
    fi
  fi
fi
printf '%s\\n' "$*" >> "$UFW_LOG"
if [ "\${1:-}" = status ] && [ "\${2:-}" = numbered ]; then
  n=$(cat "$UFW_DIR/status-count")
  n=$((n + 1))
  printf '%s' "$n" > "$UFW_DIR/status-count"
  if [ "$n" -gt 20 ]; then
    echo 'too many firewall-status calls' >&2
    exit 99
  fi
  max=$(cat "$UFW_DIR/responses")
  answer=$n
  if [ "$answer" -gt "$max" ]; then answer=$max; fi
  cat "$UFW_DIR/status-$answer.out"
  exit "$(cat "$UFW_DIR/status-$answer.exit")"
fi
if [ "\${1:-}" = app ] && [ "\${2:-}" = info ]; then
  case "\${3:-}" in
    'Custom Gateway') printf '%s\n' 'Profile: Custom Gateway' 'Ports:' '  79:81,443/tcp' ;;
    'OpenSSH') printf '%s\n' 'Profile: OpenSSH' 'Ports:' '  22/tcp' ;;
    'Broken Gateway') echo 'profile database unavailable' >&2; exit 7 ;;
    *) echo 'unknown application profile' >&2; exit 1 ;;
  esac
  exit 0
fi
exit 0
`;
	const curl = `#!/bin/bash
case "$*" in
  *ips-v4*)
    if [ "$EMPTY_IPV6" = 1 ]; then limit=15; else limit=8; fi
    for n in $(seq 1 "$limit"); do echo "192.0.2.$n/32"; done ;;
  *ips-v6*)
    if [ "$EMPTY_IPV6" != 1 ]; then
      for n in {1..7}; do echo "2001:db8::$n/128"; done
    fi ;;
  *) exit 22 ;;
esac
`;
	writeFileSync(join(dir, 'ufw'), ufw, 'utf8');
	writeFileSync(join(dir, 'curl'), curl, 'utf8');
	chmodSync(join(dir, 'ufw'), 0o755);
	chmodSync(join(dir, 'curl'), 0o755);

	const shellDir = shellPath(dir);
	const result = spawnSync(
		BASH,
		[
			'-c',
			'PATH="$TEST_STUB:/usr/bin:/bin"; export PATH; exec "$TEST_SCRIPT" "$@"',
			'firewall-test',
			...args
		],
		{
			encoding: 'utf8',
			env: {
				...process.env,
				TEST_STUB: shellDir,
				TEST_SCRIPT: shellPath(SCRIPT),
				UFW_DIR: shellDir,
				UFW_LOG: shellPath(log),
				EMPTY_IPV6: emptyIpv6 ? '1' : '0',
				FAIL2BAN_AFTER_STATUS: String(fail2banAfterStatus)
			}
		}
	);
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		ufwCalls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
	};
}

const ACTIVE = 'Status: active\n';
const CLOUDFLARE_V4 = Array.from({ length: 8 }, (_, index) => `192.0.2.${index + 1}/32`);
const CLOUDFLARE_V6 = Array.from({ length: 7 }, (_, index) => `2001:db8::${index + 1}/128`);

function cloudflareLines(v4 = CLOUDFLARE_V4, v6 = CLOUDFLARE_V6, firstNumber = 1): string {
	let number = firstNumber;
	const lines: string[] = [];
	for (const cidr of v4) {
		for (const port of [80, 443]) {
			lines.push(`[${String(number).padStart(2, ' ')}] ${port}/tcp ALLOW IN ${cidr} # cloudflare`);
			number += 1;
		}
	}
	for (const cidr of v6) {
		for (const port of [80, 443]) {
			lines.push(
				`[${String(number).padStart(2, ' ')}] ${port}/tcp (v6) ALLOW IN ${cidr} # cloudflare`
			);
			number += 1;
		}
	}
	return `${lines.join('\n')}\n`;
}

const RESTRICTED_V4 = `${ACTIVE}${cloudflareLines(CLOUDFLARE_V4, [])}`;
const RESTRICTED = `${ACTIVE}${cloudflareLines()}`;
const FAIL2BAN_RULE = '[ 1] Anywhere DENY IN 198.51.100.9 # fail2ban\n';
const RESTRICTED_AFTER_FAIL2BAN = `${ACTIVE}${FAIL2BAN_RULE}${cloudflareLines(
	CLOUDFLARE_V4,
	CLOUDFLARE_V6,
	2
)}`;
const OPEN =
	`${ACTIVE}[ 1] 80/tcp ALLOW IN Anywhere # http - acme challenge and redirect\n` +
	'[ 2] 443/tcp ALLOW IN Anywhere # https\n';
const OPEN_AFTER_FAIL2BAN =
	`${ACTIVE}${FAIL2BAN_RULE}` +
	'[ 2] 80/tcp ALLOW IN Anywhere # http - acme challenge and redirect\n' +
	'[ 3] 443/tcp ALLOW IN Anywhere # https\n';
const OPEN_PROFILE = `${ACTIVE}[ 4] Custom Gateway ALLOW IN Anywhere\n`;
// Git Bash process creation is substantially slower than native bash, and the
// production-property tests intentionally exercise many individual UFW calls.
const FIREWALL_TEST_TIMEOUT = process.platform === 'win32' ? 60_000 : 15_000;
// This one fixture performs three complete mutation-and-verification runs in
// sequence. It measured 74 seconds on a loaded Windows runner, so keep bounded
// headroom for process scheduling without relaxing any firewall assertion.
const FINAL_RESTRICTED_TEST_TIMEOUT = process.platform === 'win32' ? 120_000 : 30_000;

describe('the Cloudflare-only firewall switch', { timeout: FIREWALL_TEST_TIMEOUT }, () => {
	it('propagates a real status failure before changing the firewall', () => {
		for (const args of [[], ['--off']]) {
			const result = run([{ output: 'ufw backend failed\n', exit: 2 }], args);
			expect(result.status, args.join(' ') || 'enable').not.toBe(0);
			expect(result.stdout).not.toMatch(/origin (restricted|reopened)/);
			expect(result.ufwCalls, `${result.stderr}\n${result.stdout}`).toEqual(['status numbered']);
		}
	});

	it(
		'does not mistake an inactive or ambiguous firewall for success',
		() => {
			for (const [answer, args] of [
				[{ output: 'Status: inactive\n' }, []],
				[{ output: 'Status: inactive\n' }, ['--off']],
				[{ output: 'unexpected output\n' }, []],
				[{ output: 'unexpected output\n' }, ['--off']]
			] as const) {
				const result = run([answer], [...args]);
				expect(result.status).not.toBe(0);
				expect(result.stdout).not.toMatch(/origin (restricted|reopened)/);
			}
		},
		FIREWALL_TEST_TIMEOUT
	);

	it(
		'checks the final restricted state instead of trusting successful mutations',
		() => {
			const statusFailure = run([
				{ output: ACTIVE },
				{ output: RESTRICTED },
				{ output: 'ufw backend failed\n', exit: 2 }
			]);
			expect(statusFailure.status).not.toBe(0);
			expect(statusFailure.stdout).not.toContain('origin restricted');

			const becameInactive = run([
				{ output: ACTIVE },
				{ output: RESTRICTED },
				{ output: 'Status: inactive\n' }
			]);
			expect(becameInactive.status).not.toBe(0);
			expect(becameInactive.stdout).not.toContain('origin restricted');

			const lostIpv6 = run([{ output: ACTIVE }, { output: RESTRICTED }, { output: RESTRICTED_V4 }]);
			expect(lostIpv6.status).not.toBe(0);
			expect(lostIpv6.stderr).toContain('no IPv6 Cloudflare allow rule');
			expect(lostIpv6.stdout).not.toContain('origin restricted');

			const oneRangeMissing = `${ACTIVE}${cloudflareLines(CLOUDFLARE_V4.slice(0, -1))}`;
			const lostOneRange = run([
				{ output: ACTIVE },
				{ output: RESTRICTED },
				{ output: oneRangeMissing }
			]);
			expect(lostOneRange.status).not.toBe(0);
			expect(lostOneRange.stderr).toContain('192.0.2.8/32');
			expect(lostOneRange.stdout).not.toContain('origin restricted');
		},
		FINAL_RESTRICTED_TEST_TIMEOUT
	);

	it('refuses an apparently complete list that silently lost the IPv6 family', () => {
		const withOldIpv6 =
			`${RESTRICTED}[ 9] 80/tcp (v6) ALLOW IN 2001:db8:ffff::/48 # cloudflare\n` +
			'[10] 443/tcp (v6) ALLOW IN 2001:db8:ffff::/48 # cloudflare\n';
		const result = run(
			[{ output: ACTIVE }, { output: withOldIpv6 }, { output: RESTRICTED_V4 }],
			[],
			true
		);

		expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
		expect(result.stdout).not.toContain('origin restricted');
		expect(
			result.ufwCalls,
			'an incomplete range response must be refused before any firewall rule changes'
		).toEqual(['status numbered']);
	});

	it('checks the final reopened state too', () => {
		const result = run(
			[{ output: ACTIVE }, { output: 'ufw backend failed\n', exit: 2 }],
			['--off']
		);
		expect(result.status).not.toBe(0);
		expect(result.stdout).not.toContain('origin reopened');
	});

	it('refuses an unrestricted web application profile without deleting the profile rule', () => {
		const exposed = `${RESTRICTED}[ 3] Custom Gateway ALLOW IN Anywhere\n`;
		const result = run([{ output: ACTIVE }, { output: exposed }, { output: exposed }]);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('unrestricted web rule remains');
		expect(result.stdout).not.toContain('origin restricted');
		expect(result.ufwCalls).toContain('app info Custom Gateway');
		expect(
			result.ufwCalls,
			'an application profile can include unrelated ports, so the script must not delete it wholesale'
		).not.toContain('--force delete 3');
	});

	it('does not mistake an unrelated unrestricted application profile for web exposure', () => {
		const final = `${RESTRICTED}[ 3] OpenSSH ALLOW IN Anywhere\n`;
		const result = run([{ output: ACTIVE }, { output: final }, { output: final }]);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain('origin restricted to 15 Cloudflare ranges');
		expect(result.ufwCalls).toContain('app info OpenSSH');
	});

	it('propagates a profile-inspection failure instead of claiming the origin is restricted', () => {
		const ambiguous = `${RESTRICTED}[ 3] Broken Gateway ALLOW IN Anywhere\n`;
		const result = run([{ output: ACTIVE }, { output: ambiguous }, { output: ambiguous }]);

		expect(result.status).toBe(7);
		expect(result.stderr).toContain("could not inspect UFW application profile 'Broken Gateway'");
		expect(result.stdout).not.toContain('origin restricted');
		expect(result.ufwCalls).toContain('app info Broken Gateway');
	});

	it('removes a withdrawn range and reports that exact result', () => {
		const stale = RESTRICTED + '[99] 80/tcp ALLOW IN 203.0.113.0/24 # cloudflare\n';
		const result = run([{ output: ACTIVE }, { output: stale }, { output: RESTRICTED }]);

		expect(result.status).toBe(0);
		expect(result.ufwCalls).toContain(
			'--force delete allow from 203.0.113.0/24 to any port 80 proto tcp comment cloudflare'
		);
		expect(result.ufwCalls.some((call) => /^--force delete \d+$/.test(call))).toBe(false);
		expect(result.stdout).toContain('(1 withdrawn range(s) removed)');
	});

	it('cannot delete a live range when fail2ban inserts rule 1 during a refresh', () => {
		const stale = RESTRICTED + '[99] 80/tcp ALLOW IN 203.0.113.0/24 # cloudflare\n';
		const result = run(
			[{ output: ACTIVE }, { output: stale }, { output: RESTRICTED_AFTER_FAIL2BAN }],
			[],
			false,
			2
		);

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.ufwCalls).toContain('external fail2ban: insert 1 deny from 198.51.100.9');
		expect(result.ufwCalls).toContain(
			'--force delete allow from 203.0.113.0/24 to any port 80 proto tcp comment cloudflare'
		);
		expect(result.ufwCalls.some((call) => /^--force delete \d+$/.test(call))).toBe(false);
		expect(result.ufwCalls).not.toContain(
			'--force delete allow from 192.0.2.1/32 to any port 80 proto tcp comment cloudflare'
		);
		expect(result.stdout).toContain('(1 withdrawn range(s) removed)');
	});

	it(
		'removes every Cloudflare rule on --off and refuses an unnumbered one',
		() => {
			const oneRule = `${ACTIVE}[ 3] 80/tcp ALLOW IN 192.0.2.1/32 # cloudflare\n`;
			const removed = run([{ output: oneRule }, { output: ACTIVE }, { output: OPEN }], ['--off']);
			expect(removed.status).toBe(0);
			expect(removed.ufwCalls).toContain(
				'--force delete allow from 192.0.2.1/32 to any port 80 proto tcp comment cloudflare'
			);
			expect(removed.ufwCalls.some((call) => /^--force delete \d+$/.test(call))).toBe(false);

			const ambiguous = run(
				[{ output: `${ACTIVE}80/tcp ALLOW IN 192.0.2.1/32 # cloudflare\n` }],
				['--off']
			);
			expect(ambiguous.status).not.toBe(0);
			expect(ambiguous.stdout).not.toContain('origin reopened');
			expect(ambiguous.ufwCalls.some((call) => call.startsWith('--force delete'))).toBe(false);
		},
		FIREWALL_TEST_TIMEOUT
	);

	it('cannot delete the wrong rule when fail2ban renumbers UFW during --off', () => {
		const oneRule = `${ACTIVE}[ 7] 443/tcp ALLOW IN 192.0.2.1/32 # cloudflare\n`;
		const result = run(
			[
				{ output: oneRule },
				{ output: `${ACTIVE}${FAIL2BAN_RULE}` },
				{ output: OPEN_AFTER_FAIL2BAN }
			],
			['--off'],
			false,
			1
		);

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.ufwCalls).toContain('external fail2ban: insert 1 deny from 198.51.100.9');
		expect(result.ufwCalls).toContain(
			'--force delete allow from 192.0.2.1/32 to any port 443 proto tcp comment cloudflare'
		);
		expect(result.ufwCalls.some((call) => /^--force delete \d+$/.test(call))).toBe(false);
		expect(result.stdout).toContain('origin reopened to the world');
	});

	it(
		'treats no matching Cloudflare rule as a normal state',
		() => {
			const enable = run([{ output: ACTIVE }, { output: RESTRICTED }, { output: RESTRICTED }]);
			expect(enable.status).toBe(0);
			expect(enable.stdout).toContain('origin restricted to 15 Cloudflare ranges');

			const disable = run([{ output: ACTIVE }, { output: OPEN }], ['--off']);
			expect(disable.status).toBe(0);
			expect(disable.stdout).toContain('origin reopened to the world');
		},
		FIREWALL_TEST_TIMEOUT
	);

	it('recognises that --off reopened both web ports through an arbitrary application profile', () => {
		const oneRule = `${ACTIVE}[ 3] 80/tcp ALLOW IN 192.0.2.1/32 # cloudflare\n`;
		const result = run(
			[{ output: oneRule }, { output: ACTIVE }, { output: OPEN_PROFILE }],
			['--off']
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain('origin reopened to the world');
		expect(result.ufwCalls).toContain('app info Custom Gateway');
	});
});
