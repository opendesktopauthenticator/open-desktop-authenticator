# Threat Model — v1

What this application protects, what it does not, and what we have decided to
accept. Written to be read by someone trying to find a reason not to trust us.

Status: v1, Phase 1. Revised whenever a finding changes it; every revision is in
git history. Sections marked **UNIMPLEMENTED** describe intent for a feature that
does not exist yet — they are here so the design is reviewable before the code
exists, not to imply protection you have today.

---

## 1. What we are protecting

| Asset             | Why it matters                                       | Loss means                                                                    |
| ----------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| `shared_secret`   | Generates your Steam Guard codes                     | Attacker generates your codes forever, silently                               |
| `identity_secret` | Signs mobile confirmations                           | Attacker approves trades and listings as you                                  |
| `revocation_code` | The only self-service way to remove an authenticator | You cannot recover the account yourself; Steam Support becomes the only route |
| Refresh token     | A live Steam session                                 | Attacker acts as you until it expires or is revoked                           |
| Vault passphrase  | Unlocks everything above                             | Total compromise                                                              |
| Account password  | Only ever in memory, never stored                    | Account takeover                                                              |

The first three come out of a maFile and are **long-lived**. Rotating them means
removing and re-enrolling the authenticator. Treat any exposure as permanent
until you have done that.

---

## 2. Adversaries we defend against

### 2.1 The fake-download clone site

**The attack that motivated this project** (§3). An attacker publishes a build
that looks like ours, ranks for our name, and ships a modified binary that
exfiltrates maFiles.

Open source alone does not fix this — attackers compile open source with malware
added. What actually helps:

- Releases reach users through two channels and no others: the Microsoft Store,
  which re-signs the package it distributes, and GitHub Releases (§11 S11). The
  website hosts no binaries and never will — every button on it is a link
  outward.
- **The two channels have different failure modes, and the docs say which is
  which.** A Store package is verified by Windows before it installs and needs
  nothing checked by hand; a GitHub asset is verified by the person who
  downloads it, or not at all. Presenting them as interchangeable would leave
  the second group believing a check happened that did not.
- Every release publishes `SHA256SUMS.txt` and build provenance attestations.
- We teach one habit above all others: **never download an authenticator from a
  website — including ours.**

**Residual risk:** a user who never verifies anything. We reduce it by making
verification a copy-pasteable command, not an exercise.

### 2.2 Malware already on the user's machine

Split deliberately, because the two halves have very different answers.

**Passive/opportunistic malware** — infostealers grepping the disk for known
filenames. Defended: the vault is a single AES-256-GCM file whose key is derived
from a passphrase we never store. There is no plaintext maFile on disk after
import.

**An attacker with code execution as your user, while the vault is unlocked** —
**not defended, and cannot be.** They can read our process memory. This is the
explicit out-of-scope boundary in §4 below.

### 2.3 Supply-chain compromise

Someone compromises a dependency, our build, or our release pipeline.

- Dependencies are pinned exact, installed with `npm ci` only, and every bump is
  a reviewed PR — Dependabot never auto-merges (§9.4).
- Builds run in public CI; the workflow is in the repo and its history is public.
- Releases are signed and attested. A binary that does not verify is not ours.
- `npm audit` and `osv-scanner` gate CI on production dependencies.

**Resolved, and worth stating because an earlier version of this document said
otherwise:** the production tree used to be planned around `steamcommunity`,
which reaches eleven unfixable advisories through the deprecated `request`. It is
not shipped. The application depends on **react, react-dom, zod and
steam-session** and nothing else — 36 transitive packages, and
`npm audit --omit=dev` reports zero vulnerabilities. `steam-session` carries none
of `steamcommunity`'s advisories; every one of those arrives through the
deprecated `request`, which `steam-session` does not use. Sign-in is the
library's; confirmations are our own. See Q19 and D14 in
[PLAN_AMENDMENTS.md](PLAN_AMENDMENTS.md) for the measurements that decided both.

**Also accepted:** third-party GitHub Actions in CI are pinned to major tags, not
commit SHAs. That job holds no secrets and has read-only permissions. The release
workflow, which will hold signing material, must pin to full SHAs.

### 2.4 A malicious or careless contributor

- All security-relevant PRs are reviewed by the maintainer regardless of author
  (§18).
- The §11 invariants are enforced by tests and lint rules, not by reviewer
  memory: the renderer cannot import `electron` or `node:`, the preload cannot
  import anything that pulls in a dependency, and the packaged CSP is asserted.
- The IPC surface is a single declared table; adding a channel is a visible diff.

### 2.5 Network attackers

All Steam traffic is HTTPS with standard certificate validation, originating in
the main process. The renderer has no network access of its own —
`connect-src 'none'` in the packaged CSP.

### 2.6 The proxy operator — **new, and easy to underestimate**

Per-account proxy routing is supported. If you use it, **the proxy operator
becomes an adversary in your model.**

- They see every host you contact, and when. That is enough to profile activity
  even without content.
- Content stays TLS-encrypted **unless you install that proxy's CA certificate**.
  If you do, they see everything. Do not.
- `socks5://` resolves DNS locally, so your own resolver still sees every Steam
  hostname. Prefer `socks5h://`.

The users most likely to want this feature are the most likely to buy cheap
residential proxies of unknown ownership. The warning belongs next to the
setting, not only here.

### 2.7 An attacker with your unlocked vault, stripping 2FA

**New with authenticator removal (F-09, Q15), and accepted with mitigations.**

The application can now tell Steam to detach an authenticator, using the stored
revocation code. That turns a vault compromise from bounded into permanent: an
attacker at an unlocked machine could otherwise remove Steam Guard from every
account in one pass, leaving each with no second factor at all.

What makes it acceptable to ship:

- **The passphrase is verified against the vault file, per account.** Being
  unlocked means the machine was used recently, not that its owner is at it.
- **There is no bulk form.** Not hidden in the UI — there is no method on the
  service that takes more than one account, so there is nothing for a future
  caller to reach for.
- **A typed acknowledgement**, enforced in the handler rather than the screen,
  naming what actually happens: `REMOVE STEAM GUARD`.
- **Steam first, vault second.** The local record survives a failed detach.
  Reversing that order would leave an authenticator attached that nobody holds
  the secrets for — the same unrecoverable state enrollment avoids, reached from
  the other direction.

**Residual risk, stated:** an attacker who has both the unlocked vault _and_ the
passphrase can still do this. That is the same boundary as §2.2 — code execution
as the user while unlocked is out of scope and cannot be defended from inside the
process.

An account imported without a revocation code cannot use this at all, because
Steam will not detach without one. The screen says so instead of offering a
button that fails.

### 2.8 Steam correlating your accounts with each other

Routing gives each account its own exit address. That is necessary and it is not
sufficient — several other signals survive it, and this section says which,
including the ones we cannot fix.

**What is addressed.**

- **One client identity, consistently.** Every request — sign-in, confirmations,
  enrollment — presents as the real Steam Android app: `okhttp/4.9.2` with the
  `mobileClient=android; mobileClientVersion=…` cookie, which is exactly what
  `steam-session` sends and what the app itself sends. Previously the two halves
  disagreed: an account signed in as the Android app and then fetched its
  confirmations as a Chrome browser. No genuine client does that, and an
  inconsistency inside one session is a stronger signal than any single header.
- **No browser-only headers.** Electron adds client hints (`sec-ch-ua`) and fetch
  metadata (`sec-fetch-*`) of its own accord. Beside an `okhttp` User-Agent those
  are a contradiction, so they are stripped at the session.
- **Accounts do not tick in lockstep.** Auto-confirm gives each account a stable
  offset within its interval. Without it, every account on the same interval
  reached Steam within milliseconds of the others, repeatedly — synchronised
  arrival times across a set of proxies is itself evidence of one operator, and
  it is a signal separate exit addresses do nothing about.

**Why the identity is not randomised per account.** The intuition is that a
unique fingerprint per account makes them unlinkable. It does the opposite.
Anti-fraud systems flag **rare** fingerprints, not common ones, so a distinct
string per account makes each individually anomalous instead of collectively
invisible. It also cannot be made coherent: the TLS fingerprint underneath does
not change, so an exotic User-Agent over a Chromium handshake is a mismatch —
precisely what fingerprinting detects. Matching the largest real population is
the stronger position.

**Accepted, and not defended: TLS and HTTP/2 fingerprinting.**

The confirmation path uses Chromium's TLS stack and the sign-in path uses
Node's. Neither matches what `okhttp` on Android actually negotiates, and
neither can be changed without replacing the network stack. So:

- Steam **can** distinguish this application's traffic from the real mobile
  app's, if it chooses to look at JA3/JA4 or HTTP/2 settings frames.
- Every installation of this application shares that fingerprint, so it also
  identifies traffic as coming from _this app_ rather than from a browser.

This is a real limit and we do not claim otherwise. What the measures above buy
is that **your accounts do not stand out from one another** beyond what routing
already separates. They do not make the application invisible to Valve, and any
tool telling you it does is lying.

---

## 3. Auto-confirm — the honest section

Auto-confirm is the feature most likely to hurt someone, so it gets stated
plainly rather than buried.

**What it costs you.** Auto-confirm turns your second factor into a rubber stamp
for the accounts you enable it on. If your session or machine is compromised,
trades and listings you did not intend can complete without you seeing them. We
ship it because traders genuinely need it; we do not pretend it is free.

Guardrails, all deliberate:

- Off by default. Two independent switches — market listings and trades — never
  one combined toggle, because they are different risk classes. **Implemented.**
- Turning **trades** on requires typing `APPROVE TRADES`, because ticking a box
  is muscle memory and typing is not. Switching it off never does.
  **Implemented.**
- Runs only while the vault is unlocked, and stops on lock and on suspend.
  **Implemented.**
- Halts the account entirely, and says so, after 10 consecutive failures — a dead
  session must not fail forever at quiet intervals while the user believes this
  is working. **Implemented.**
- A local, per-account activity log of every automatic action. **Implemented**,
  and deliberately **in memory only** — it answers "what happened while I was
  away", which is hours, not months. A persisted log of approved trades would be
  a record of somebody's trading activity sitting beside their authenticator,
  needing its own answer to where it lives and who can read it. It survives a
  lock, so it is still there when the user returns, and dies with the process.
  Anything held back for safety is raised as an alert on the account list rather
  than left to be discovered.

### 3.1 Confirmation-type allowlist — invariant S16, **implemented**

**This is the most important constraint in this document.**

Steam's mobile confirmation endpoint does **not** serve only trades and market
listings. Verified live: it also serves **account-security confirmations**,
including account recovery, as **type 6** — a type the ecosystem library's own
enum does not know about (F-12).

The consequence, if auto-confirm were built to approve whatever it fetches:

> An attacker initiates account recovery, and the victim's own authenticator
> auto-approves the takeover within one poll interval — 15 seconds by default,
> while the user is by definition not watching.

The second factor would complete the exact attack this project exists to prevent.

Therefore:

1. Auto-confirm acts **only** on confirmation types the user has explicitly
   enabled — trade (2) and market listing (3). Allowlist, never blocklist.
2. **Unknown types are never auto-actioned.** Type 6 exists today; Valve can add
   type 7 tomorrow without telling anyone. Treating "unrecognised" as "probably
   fine" is broken by construction.
3. `steamcommunity.acceptAllConfirmations()` must not appear anywhere in this
   codebase. It accepts everything the list returns, by design.
4. Account-security confirmations are surfaced as an **alert**, never as an
   ordinary list item. An unexpected account-recovery confirmation is the
   strongest signal a user will ever get that they are under attack.

**The rule is implemented and tested**, in `src/main/confirmations/policy.ts` and
`tests/confirmation-policy.test.ts`, ahead of any code that can act on a
confirmation — which is the order that matters. Among other things the tests
assert that type 6 is refused with every setting switched on, that every type
from −5 to 50 outside the allowed pair is refused, and that the allowed pair is
exactly `[2, 3]`, so widening it means editing a test that says so out loud.

Rule 3 is enforced separately by `tests/invariants.test.ts`, which fails the
build if `acceptAllConfirmations` appears anywhere in the tree.

**Auto-confirm now acts on these decisions**, through `confirmations/auto.ts`.
The engine is deliberately the dumbest module in the codebase: it decides only
_when_ to ask, never _what_ may be approved. It also refuses to run at all while
the vault is locked, because a locked vault is the clearest available statement
that the person it would be acting for is not there.

Both switches are off by default and per account. Turning them on is a screen
that states what a wrongly-approved trade costs, and says plainly that nothing on
it can widen the allowlist.

---

## 4. Explicitly out of scope

Stated plainly, because a threat model that claims to defend everything is not
one.

- **A fully compromised operating system.** Kernel-level malware, a hostile
  administrator, or an attacker with code execution as your user while the vault
  is unlocked can read our memory. No user-space application defends against
  this. Nothing we do changes it.
- **Hardware attacks.** Cold-boot, DMA, evil-maid against an unlocked machine.
- **A compromised Steam account by other means.** If an attacker already has your
  password and an active session, an authenticator cannot un-ring that bell.
- **Phishing you into typing codes.** We show codes; we cannot know where you
  paste them. A site that convincingly asks for a code will get one.
- **Valve-side changes.** This tool speaks an undocumented protocol that exists at
  Valve's tolerance (§22.2). They can change or end it, and we would have to
  respond rather than prevent.
- **Losing your passphrase.** There is no recovery. That is the design, and the
  create-vault ceremony says so before you commit to it.
- **The operating system's clipboard history.** When you copy a Steam Guard code
  we put it back on a timer, and we only clear it if it is still what we wrote.
  That covers the clipboard itself. It does **not** reach Windows Clipboard
  History (`Win`+`V`) or any cloud clipboard sync, which keep their own copy the
  moment anything is copied. No application-level API lets us remove an entry
  from those after the fact. If you use clipboard history, assume every code you
  copy is in it until it rolls out on its own — and prefer reading the code off
  the screen. This is a real gap between what "the clipboard is cleared" sounds
  like and what any application can actually deliver, so it is stated rather
  than implied.

---

## 5. Design decisions that follow from all this

| Decision                                                        | Threat it addresses                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| No server, no sync, no telemetry                                | We cannot leak what we never receive                                                 |
| Passphrase is the root of trust on every platform               | OS keystore compromise alone is not enough                                           |
| Renderer sandboxed, no Node, `connect-src 'none'`               | A renderer compromise cannot exfiltrate                                              |
| Every IPC channel declared and schema-validated                 | No generic bridge to pivot through                                                   |
| Long-term secrets never cross IPC (two user-invoked exceptions) | Renderer compromise does not yield secrets                                           |
| Updates notify, never silently install                          | Silent replacement of an authenticator binary is itself supply-chain surface         |
| Forced revocation-code backup before an account is active       | The unrecoverable loss is made structurally hard                                     |
| Single-instance lock                                            | Two writers would race on the vault file                                             |
| Packaged navigation pinned to the exact bundled file            | Every `file:` URL shares the origin `"null"`; an origin check permits any local file |

---

## 6. Reporting a problem with this model

If you can describe an attack this document does not cover, that is a valid
security report even without working code. See [SECURITY.md](../SECURITY.md).
