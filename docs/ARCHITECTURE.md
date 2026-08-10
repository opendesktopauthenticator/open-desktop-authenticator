# Architecture

A map of the codebase and the reasoning behind the shapes that look unusual.
For what we defend against, read [THREAT_MODEL.md](THREAT_MODEL.md) first.

## Process model

```
┌──────────────────────── Electron main process ────────────────────────┐
│                                                                       │
│  Holds every long-lived secret. Owns all network I/O.                 │
│                                                                       │
│    security.ts     posture: CSP, permissions, navigation lock         │
│    ipc/router.ts   every channel, zod-validated at the boundary       │
│                                                                       │
│            vault/  scrypt + AES-256-GCM, atomic writes, auto-lock     │
│            import/ maFile parsing and staging. Reads the disk;        │
│                    the renderer never names a path                    │
│    (0.1+)  steam/  the ONLY place that talks to Valve                 │
│    confirmations/auto.ts  the poller: decides WHEN to ask,            │
│                           never what may be approved                  │
│                                                                       │
└────────────────────────────────┬──────────────────────────────────────┘
                                 │  contextBridge — typed, allowlisted
┌────────────────────────────────┴──────────────────────────────────────┐
│  preload/  the entire attack surface between the two. Tiny on purpose.│
├───────────────────────────────────────────────────────────────────────┤
│  renderer/  dumb UI. No Node. No network. No persistent state.        │
│             sandbox: true, contextIsolation: true, nodeIntegration:   │
│             false, connect-src 'none'                                 │
└───────────────────────────────────────────────────────────────────────┘
```

## Layout

```
src/
  main/        privileged. secrets, network, filesystem
    ipc/       the validated boundary
    vault/     the encrypted store and its session
    import/    maFile parsing, staging, and the commit into the vault
    codes/     Steam Guard code generation and the clipboard rules
    confirmations/  confirmation keys, the S16 type allowlist, mobileconf
    net/       the ONLY place a socket opens: per-account Electron sessions,
               each with its own proxy and its own cookie jar
    steam/     talking to Valve's own endpoints (session minting)
  preload/     bridge only. see the warning below
  renderer/    React UI
  shared/      types and constants used by more than one side
tests/         invariant tests for the app
spike/         Phase 0 CLI. reference only, never shipped — but see below
docs/          this file, threat model, findings, release checklist
```

### `spike/` is not only a museum

It began as throwaway Phase 0 code and mostly still is. One thing in it is
load-bearing: `spike/tests/totp-parity.test.ts` checks the application's own
Steam Guard code generator against `steam-totp` across tens of thousands of
windows. The app does not depend on that library, so the spike — which does — is
the only place that comparison can be made. Deleting the spike deletes the proof
that our codes match everyone else's.

## Three shapes that look odd and are not

### `shared/channels.ts` exists separately from `shared/ipc.ts`

`ipc.ts` imports zod to declare schemas. The preload runs **sandboxed** and can
only `require('electron')` — requiring any ordinary npm module throws.

If preload imported its channel names from `ipc.ts`, the bundler would emit
`require("zod")` into the preload bundle, the preload would die, and `window.api`
would simply never appear. **The renderer would look like it just has no API**,
with no error surfaced anywhere obvious.

This happened during Phase 1. `channels.ts` holds the values with zero runtime
dependencies; preload imports types from `ipc.ts` with `import type`, which the
compiler erases. A lint rule and a test on the **built** bundle enforce it.

### Everything in `shared/` must be environment-agnostic

`shared/` is compiled for the renderer as well as the main process, so it cannot
touch `process`, `fs`, or anything else Node-only — even in code the renderer
never calls. `isAllowedNavigation` therefore takes platform behaviour as a
parameter instead of reading `process.platform`.

### The packaged navigation lock pins a path, not an origin

`new URL(...).origin` is the string `"null"` for **every** `file:` URL. Comparing
origins in a packaged build compares `"null"` to `"null"` and permits navigation
to any local file on the machine. The check must pin the exact file.

## Where Valve churn is absorbed

All Steam protocol contact goes through `src/main/steam/`, `src/main/codes/` and
`src/main/confirmations/`, and every request leaves through the single transport
in `src/main/net/`. When Valve changes something — and they will — the fix is in
one place.

**The shipped application depends on none of DoctorMcKay's libraries.** That was
not the original plan; D12/D13 and Q19 in
[PLAN_AMENDMENTS.md](PLAN_AMENDMENTS.md) record why it changed. In short: code
generation and confirmation signing are twenty lines each and are the most
security-critical computations here, so they are written where a reader can check
them — and proven against `steam-totp` in `/spike` on every push. `steamcommunity`
was declined separately, over eleven unfixable advisories and an
`EConfirmationType` enum that does not contain the account-recovery type this
application must refuse.

Two protocol facts worth knowing, both established against live accounts:

- **`MobileApp` is load-bearing at the token level**, not just at login. A
  web-scoped token looks valid and unexpired but silently cannot drive mobile
  confirmations. The vault stores the MobileApp refresh token specifically and
  validates its audience on load.
- The stored `device_id` from an imported maFile is **not** what gets sent to
  Steam. It is derived from the SteamID on every request, and Steam does not
  validate it. We keep the stored value for export fidelity only.

Both were established by running against live accounts in Phase 0; see
[PHASE0_FINDINGS.md](PHASE0_FINDINGS.md).

## Data at rest

One encrypted vault file. Whole-file encryption, not per-field: scrypt-derived
key, AES-256-GCM, fresh nonce every write, atomic write-and-rename with one
rotating backup.

SteamID64 is stored and handled as a **string** everywhere. It exceeds
`Number.MAX_SAFE_INTEGER`, so any code path that lets it become a JavaScript
number silently corrupts it into a different account's ID.

## Testing shape

Invariants are asserted, not documented. The suite checks the security posture
constants, the packaged CSP, the built preload's imports, the IPC contract's
completeness, and that hostile input is rejected — because a posture that lives
only in comments erodes the first time someone needs to make a library work.
