# Threat Model — v1

What this application protects, what it does not, and what we have decided to
accept. Written to be read by someone trying to find a reason not to trust us.

Status: v1, Phase 1. Revised whenever a finding changes it; every revision is in
git history. Sections marked **UNIMPLEMENTED** describe intent for a feature that
does not exist yet — they are here so the design is reviewable before the code
exists, not to imply protection you have today.

---

## 1. What we are protecting

| Asset             | Why it matters                                         | Loss means                                                                                                      |
| ----------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `shared_secret`   | Generates your Steam Guard codes                       | Attacker generates your codes forever, silently                                                                 |
| `identity_secret` | Signs mobile confirmations                             | Attacker approves trades and listings as you                                                                    |
| `revocation_code` | Removes an authenticator without needing anything else | You fall back on Steam's own account recovery, which may go through a linked phone and may end at Steam Support |
| Refresh token     | A live Steam session                                   | Attacker acts as you until it expires or is revoked                                                             |
| Vault passphrase  | Unlocks everything above                               | Total compromise                                                                                                |
| Account password  | Only ever in memory, never stored                      | Account takeover                                                                                                |

The first three come out of a maFile and are **long-lived**. Rotating them means
replacing the authenticator — either the transfer this application implements,
which rotates the whole bundle server-side, or a remove-and-re-enrol. Treat any
exposure as permanent
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
filenames. Partly defended: what this application writes is AES-256-GCM,
under a key derived from a passphrase we never store — the vault, its backup,
and the per-account recovery files.

**It does not defend the maFile you imported from.** Import reads those files
and does not move, alter or delete them, which the import screen says plainly
because deleting a user's only copy of a secret would be a worse failure than
leaving it. If the maFile was plaintext before, it is plaintext afterwards,
in the same place, and an infostealer grepping for `.maFile` finds it exactly
as it would have. Importing into this vault adds a protected copy; it does not
retract the unprotected one. That is the user's to delete, and the post-import
screen tells them so.

**An attacker with code execution as your user, while the vault is unlocked** —
**not defended, and cannot be.** They can read our process memory. This is the
explicit out-of-scope boundary in §4 below.

### 2.3 Supply-chain compromise

Someone compromises a dependency, our build, or our release pipeline.

- Dependencies are **lockfile-pinned and installed with `npm ci` only**, so every
  build resolves the same tree; `package.json` still carries carets, and it is
  the lockfile plus `npm ci` that makes this deterministic rather than the range.
  Every bump is a reviewed PR — Dependabot never auto-merges (§9.4).
- Builds run in public CI; the workflow is in the repo and its history is public.
- **Distribution is two channels with different guarantees, and conflating them
  is itself a risk.** The Microsoft Store package is signed, because Microsoft
  re-signs what it distributes. The GitHub builds are **not** code-signed: they
  carry published SHA-256 checksums, a sigstore signature over that checksum
  list, and a sigstore build-provenance attestation naming the workflow, commit
  and tag that produced them. A binary that fails the check appropriate to its
  channel is not ours.
- **The checksum list is signed keylessly, on purpose.** `cosign` mints a
  short-lived certificate bound to the release workflow's OIDC identity, so
  there is no long-lived private key for a single maintainer to hold, escrow or
  lose. §2.4 and MAINTENANCE.md both name maintainer disappearance as this
  project's largest risk; a signing key only one person can reproduce would have
  deepened it rather than closing a gap.
- `npm audit` and `osv-scanner` gate CI on production dependencies.

**Resolved, and worth stating because an earlier version of this document said
otherwise:** the production tree used to be planned around `steamcommunity`,
which reaches eleven unfixable advisories through the deprecated `request`. It is
not shipped. The application's direct runtime dependencies are **protobufjs,
react, react-dom, steam-session and zod** — 38 transitive packages, and
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
- **With `http`, `https`, `socks5` or `socks5h`, DNS goes to the proxy rather
  than to your resolver.** This paragraph previously said the opposite — that
  `socks5://` resolves locally and `socks5h://` should be preferred — which was
  true of Node's SOCKS client and false of Chromium's, and the two halves of this
  application used different stacks. They no longer disagree:
  `src/main/net/egress.ts` normalises the Node side to `socks5h` and translates
  the spelling Chromium needs, so both resolve at the proxy.
- **`socks4://` is the exception, and resolves on your machine.** The protocol
  carries an address rather than a hostname, so it cannot do otherwise. It is
  still accepted, because refusing it would strand people whose only proxy speaks
  it — but your resolver sees every Steam hostname, which is most of what routing
  was meant to avoid. Prefer `socks5://`. (`socks4a`, which _can_ carry a
  hostname, is refused outright: Chromium has no rule for it and would silently
  fall back to local resolution while Node resolved remotely.)
- **A SOCKS proxy needing a username and password is refused, deliberately.**
  Chromium cannot authenticate to one, so accepting it would mean traffic
  silently taking a different route than the one you configured. Use an
  http/https proxy if you need credentials.

The users most likely to want this feature are the most likely to buy cheap
residential proxies of unknown ownership. The warning belongs next to the
setting, not only here.

### 2.6b The in-app browser

**New, and the largest attack surface this application has.** A window that
loads pages nobody here wrote, signed in as one account and routed like that
account, so a trade can be finished without copying a session into a browser
that is not routed.

What it is given, and nothing more:

- **Its own session.** Not the account transport's, which is disguised as the
  Steam Android app. Sharing that one would either serve Steam's web pages to an
  `okhttp` client or strip the disguise off the application's own requests.
- **The account's proxy.** If routing is configured and cannot be applied, **no
  window opens** — the same fail-closed rule the transport follows, where the
  unit of work happens to be a window rather than a request.
- **A short-lived access token**, set as Steam's own `steamLoginSecure` cookie.
  No password is typed into a window this application drew, and the module that
  opens it never sees a refresh token.

**Every permission request is refused**, on this session specifically. §P8
denies them application-wide, but that call is made against
`session.defaultSession` and this window runs in a partition of its own, so it
inherited none of it — and Electron with no handler installed _approves_. A page
nobody here wrote could have been granted a camera, a microphone or a location
while signed in to somebody's Steam account. The refusal is installed before the
first page loads, because a page cannot be asked to wait while we decide.

What it deliberately cannot do: reach the vault, the IPC table, or any part of
this process. No preload, no bridge, `sandbox` and `contextIsolation` on,
`nodeIntegration` off. The page cannot rename its own window either, because a
page titled "Steam — Sign In" inside this application would be the exact
deception the project exists to warn people about, wearing our chrome.

**No login page is ever shown in it, and this is checked rather than assumed.**
The claim above — that no password is typed into a window this application drew
— used to rest on refusing to open a browser for an account with no stored
refresh token. That is a proxy for the property, not the property: a token can
exist and Steam can still decline the cookie minted from it, and the window
would then have landed on a Steam login form wearing this application's chrome,
which is the precise deception the project exists to warn people about. So the
URL the main frame actually ended on is inspected after the load. Anything that
is not a signed-in Steam page — a login path, a redirect elsewhere, a page that
never loaded — closes the window and wipes its session before anyone sees it,
and the user is asked to sign in through this application's own form instead.

The same rule covers a load that fails outright. Until it did, a window that
could not reach Steam stayed on screen holding a signed-in session that
`AccountBrowsers` had never recorded, and so the vault lock could not reach it.

**Accepted:** the user can navigate anywhere. That is the feature — a browser
that only reached one page would not finish a trade. Ordinary browser
same-origin rules apply, so a page on another domain cannot read Steam's
cookies; what it can do is what any site can do to a logged-in browser, which is
why this section exists rather than a claim that the window is safe.

**The window says where it is, in its title.** This paragraph used to claim the
address stayed visible, and it did not: an Electron window has no address bar,
and the title was pinned to the account name. So somebody who followed a link
off Steam saw this application's chrome and their own account name above a page
that was not Steam — which makes a fake page look _better_ than one in an
ordinary browser, and is the exact deception §2.6 exists to warn people about.

The title now reads `account — host`, and any host that is not Valve's is
labelled `NOT STEAM: host` rather than merely named, because "not Steam" is the
fact worth reading and a hostname alone asks the reader to know Valve's domains
by heart. The host is Electron's, read off the contents after navigation, so
nothing a page supplies reaches it; `page-title-updated` stays prevented. It
follows `history.pushState` as well as real loads, because a title that names
where the window used to be is worse than no title at all.

This is a smaller thing than a real address bar, and it is not claimed to be
more: it tells a reader who looks whether they are still on Steam. It does not
stop them going somewhere else, and it is not meant to.

**Ends with the lock.** `AccountBrowsers.closeAll` closes the windows and wipes
their sessions when the vault locks. Closing alone would not be enough:
`fromPartition` returns the same session next time it is asked, so the cookie
would outlive the window and a reopened browser would still be signed in without
a passphrase.

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

Routing lets each account use its own exit address — **lets, not guarantees.**
Nothing checks that two accounts were given different proxies, because the
application cannot know whether two URLs resolve to the same egress and a check
that only caught the easy case would be worse than none. Point two accounts at
one proxy and they share an address while still having separate sessions and
cookie jars. What routing does guarantee is the isolation it controls: a session
per account, and a fail-closed refusal to send an account's traffic down a route
that is not its own. That is necessary and it is not
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
