# Phase 0 spike

A plain Node + TypeScript CLI that proves the Steam loop works before any
Electron code exists (§19 Phase 0). **This is not the product.** It is reference
code, kept per §10.2 and never shipped.

Its whole job is to answer one question on real accounts:

> Do `steam-session`, `steam-totp`, and `steamcommunity` behave the way §10.4
> assumes they do?

## Where secrets live

The spike keeps **no store of its own** — no vault, no session cache, no account
database, no logs. An "account" is just a `.maFile` you already have.

The one exception is **token write-back**: after a successful login the refreshed
tokens are written back into the same maFile they came from. That file already
holds the `shared_secret`, `identity_secret` and `revocation_code`, so this adds
no new secret to the disk and creates no new file — it just keeps the session in
the place that already has one. It is what makes the password prompt a
once-per-expiry event instead of once-per-run.

Session selection, cheapest first:

1. **Valid refresh token** → mints an access token, no password.
2. **Valid mobile-scoped stored session** → used when there is no refresh token
   (some files in the wild are like that — see F-11).
3. **Password** → only when neither of the above is usable.

Turn write-back off with `SPIKE_NO_WRITEBACK=1`.

### How the write is made safe

A maFile is frequently the only copy of an account's revocation code, so a
botched write does not lose a token, it loses the ability to recover the account.
Therefore:

- **No JSON round-trip.** Text is edited surgically. Parsing and re-serialising
  would rewrite SDA's unquoted SteamID into a different account's ID (F-01) and
  silently drop every field the schema does not model.
- **Atomic.** Temp file, `fsync`, rename. A crash mid-write leaves the original.
- **Backed up.** The previous version is kept as `<file>.bak`.
- **Verified, then rolled back.** The result is re-read and re-parsed; on any
  problem the original is restored.

If another program has the maFile open, the write can fail — it fails safe and
says so, leaving the file untouched.

## Setup

```bash
npm ci
npm run build
```

Optionally, `cp .env.example .env` and point `SPIKE_MAFILE_DIR` at your maFile
folder so you can refer to accounts by name instead of by path. `.env` is
gitignored (§11 S15).

## Commands

```bash
node dist/cli.js import <maFile|directory> [...]      # parse and report; changes nothing
node dist/cli.js code <account> [--watch]             # Steam Guard code; no login needed
node dist/cli.js login <account>                      # prove the handshake; masked token
node dist/cli.js confirmations <account>              # list outstanding confirmations
node dist/cli.js accept <account> <id> [--deny]       # act on one — irreversible
```

`<account>` is a path to a `.maFile`, or — with `SPIKE_MAFILE_DIR` set — an
account name or SteamID64 to look up in that folder.

Passwords are prompted for and not echoed. Set `SPIKE_STEAM_PASSWORD` in `.env`
only if retyping gets annoying; the prompt is the safer default (§11 S8).

## Proxy routing

Set `SPIKE_PROXY_<ACCOUNT>` (or `SPIKE_PROXY` for all accounts) to route an
account's Steam traffic through an HTTP or SOCKS proxy:

```
SPIKE_PROXY_TRADERONE=socks5h://user:pass@host:1080
```

**Every** Steam request goes through it — not just the login. That includes
`steam-totp`'s time-sync call, which uses a bare `https.request` with no proxy
option at all and is also invoked from inside `steamcommunity`'s enrollment code.
Config alone cannot cover it; the spike injects a shared agent at the
`http(s).request` entry point instead. See `../docs/PHASE0_FINDINGS.md` F-08.

If any transport cannot be proxied, the command refuses to run rather than
leaking on the part it does not cover — checked before the password prompt, so a
misconfiguration costs you nothing.

Every command ends with an egress audit, so coverage is something you can check
rather than take on faith:

```
── Egress audit
  api.steampowered.com           1 request(s)  via proxy
  steamcommunity.com             4 request(s)  via proxy
  all 5 request(s) went through the proxy.
```

Prefer `socks5h://` over `socks5://`: it resolves DNS at the proxy, so your local
resolver never sees the Steam hostnames.

**Pick a proxy you actually trust.** Its operator sees every host you connect to.
Contents stay TLS-encrypted — unless you install that proxy's CA certificate,
which you should not do.

To verify it is really working, check Steam's own recent-sessions list for the
account after a `login`; it shows the IP Valve saw. The spike deliberately makes
no third-party "what is my IP" calls.

## The Phase 0 gate `[FOUNDER]`

§19 gates every later milestone on this passing against **two real accounts**.
Nothing about Electron should start until it does.

Run, per account:

1. **`import`** — point it at your maFile folder first. This is also the cheapest
   way to survey your whole collection:

   ```bash
   node dist/cli.js import "C:\path\to\your\maFiles"
   ```

   Read the warnings. Note how many files have no revocation code, and whether
   any `device_id` prints `DIFFERENT` rather than `MATCH` (finding F-02).

2. **`code`** — compare against the Steam mobile app for the same account. It
   must match, digit for digit, in the same time window.

   ```bash
   node dist/cli.js code <account>
   ```

3. **`login`** — confirms credentials → TOTP → refresh token works unattended.

   ```bash
   node dist/cli.js login <account>
   ```

   If this fails saying Steam still requires action, **stop and read finding
   F-07** in `../docs/PHASE0_FINDINGS.md`. That result changes the plan.

4. **`confirmations`** — list. Have something pending (a market listing is the
   cheapest way to create one).

   ```bash
   node dist/cli.js confirmations <account>
   ```

5. **`accept`** — act on exactly one, and verify in Steam that it actually took
   effect. This is irreversible and prompts before doing anything.
   ```bash
   node dist/cli.js accept <account> <id>
   ```

**Exit criteria (§19):** all five succeed on both accounts. Anything that behaved
differently than expected goes into `../docs/PHASE0_FINDINGS.md` before Phase 1
starts.

## Tests

```bash
npm test
```

Offline only — maFile parsing, the SteamID precision guard, and the redaction
wrapper. Fixtures in `fixtures/` are synthetic; the secrets in them are SHA-1
digests of fixed strings and belong to no account.
