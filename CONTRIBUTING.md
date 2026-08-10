# Contributing

This is a security tool people trust with credentials that cannot be rotated
without removing their authenticator. The bar is higher than usual, and the rules
below are the reason review can stay fast.

## Setup

```bash
nvm use          # Node 24 LTS, pinned in .nvmrc
npm ci           # never `npm install` for a plain checkout
npm run dev      # launches the app with HMR
```

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
```

CI runs exactly that on Windows and Linux, plus a build and a dependency audit.
Run it locally before opening a PR and you will not be surprised.

`/spike` is a separate package with its own lockfile — reference code from
Phase 0, never shipped, kept because it is the record of how the Steam protocol
actually behaves. It has its own `npm ci` and its own suite.

## The rules that get PRs rejected

These are not style preferences. Each one is a security invariant with a test or
lint rule behind it, so you will find out immediately rather than in review.

**Never weaken the process boundaries.**

- The renderer gets no `electron`, no `node:`, no `fetch`, no `localStorage`. It
  holds no persistent state.
- The preload may import **only** `electron` and `src/shared/channels.ts`. It runs
  sandboxed and can require nothing else — importing a module that pulls in a
  dependency kills the bridge **silently**, with no error anywhere obvious.
- `sandbox`, `contextIsolation`, and `nodeIntegration` are not negotiable.

**Never add IPC surface casually.** Every channel is declared in
`src/shared/ipc.ts` with a zod schema for request and response, validated at the
main-process boundary. There is no generic invoke bridge. Changing the IPC
surface requires maintainer sign-off.

**Never let a long-term secret reach the renderer.** `sharedSecret`,
`identitySecret`, `revocationCode`, refresh tokens, and passphrases stay in the
main process. Two user-invoked exceptions exist — the revocation-code backup
ceremony and explicit export — and both are deliberate, transient, and cleared on
navigation.

**Never log a secret.** All output goes through the redaction wrapper. Raw
`console.log` of a Steam-layer object is not acceptable.

**Never add a dependency without justification.** Open an issue first. A PR adding
one must explain: what it does, why built-ins cannot, its maintenance health, and
its transitive count. Our production dependency count is published; every
addition is a number we have to defend. See §9.4.

**Never build a non-goal.** No trade automation beyond confirmations, no market
tools, no inventory tools, no telemetry of any kind — including "anonymous" or
opt-in. If you think one of these is needed, open an issue; do not open a PR.

## Auto-confirm changes

Anything touching auto-confirm gets the strictest review in the project, because
its failure mode is approving an account takeover automatically.

Read [docs/THREAT_MODEL.md §3.1](docs/THREAT_MODEL.md) first. The
confirmation-type allowlist is not a heuristic to be improved — unknown types are
never actioned, and `acceptAllConfirmations()` must never appear here.

Risk copy and consent screens are not UX polish. Do not shorten, soften, or skip
a confirmation step to reduce friction. Friction is the feature.

## PR expectations

- **Conventional commits**: `feat:`, `fix:`, `docs:`, `chore:`, `test:`.
- **Tests for new logic.** Security-relevant behaviour needs a test that fails
  without the fix — assert the defect, not just the happy path.
- **Docs updated in the same PR.** A comment claiming a test exists, when it does
  not, is worse than no comment: we have already made that mistake once.
- **Self-check against the invariants** in your PR description. Say which ones
  your change touches and why it is still safe.
- Keep PRs small. A large PR touching the vault or IPC will be asked to split.

## What is genuinely useful

Not everything valuable is code:

- **Testing on Linux**, especially distros without a working secret-service
  keyring.
- **maFile variants** from old SDA installs — structurally distinct shapes, with
  every secret replaced. **Never send a real maFile.** It contains working
  credentials and, often, a live session.
- **Security review** of the threat model, including "your model is wrong about
  X" with no exploit attached.
- **Reproducing a Valve breakage** with sanitised evidence.

## Reporting security issues

Not here. See [SECURITY.md](SECURITY.md).

## Licence

Contributions are licensed under MIT, matching the project.
