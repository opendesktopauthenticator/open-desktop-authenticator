# Plan Amendments

Decisions taken and findings resolved **after** PROJECT_MASTER_PLAN.md v1.0 was
written. This file exists because the master plan is not yet in the repo (see the
root README); once it is, these fold into §1 and the sections named below and
this file becomes a changelog rather than a to-do.

Nothing here is speculative — every entry is either a founder decision or a
finding verified in `PHASE0_FINDINGS.md`.

---

## D11 — Platforms: Windows + Linux. macOS deferred.

**Supersedes D6** ("Platforms: Windows + macOS + Linux. All three ship by 1.0").

**Decision.** 1.0 ships Windows and Linux only. macOS is deferred, not cancelled.

**Reason.** macOS code signing requires Apple Developer Program enrollment _as an
organization_, which requires a D-U-N-S number for MASTERPANEL LLC. The founder
has neither and does not want to start that process now. §14.2 already flagged
the D-U-N-S + enrollment chain as taking weeks; it was the single longest lead
time in the plan and the item most able to blow the schedule for reasons outside
our control.

**This is a deferral, not an architectural exclusion.** Electron and
electron-builder support macOS; the only gate is the signing identity. Code must
stay portable — no `process.platform` assumptions beyond the two shipping
targets, and the Linux/Windows split must not harden into a two-platform
assumption that costs a rewrite later.

### Sections this changes

| Section         | Change                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1 D6           | Superseded by D11                                                                                                                                          |
| §7.1.9          | "Windows, macOS (signed + notarized universal), Linux" → Windows, Linux                                                                                    |
| §10.5           | Delete the macOS row from the packaging table                                                                                                              |
| §14.2.2         | Delete Apple Developer / D-U-N-S / notarytool from the signing critical path                                                                               |
| §19 Phase 1     | Remove "start D-U-N-S + Apple Developer org enrollment" from week-1 founder tasks                                                                          |
| §19 M0.3        | Remove "macOS beta"; milestone becomes market auto-confirm + updater + Linux beta                                                                          |
| §19 M1.0        | "All three platforms" → both platforms                                                                                                                     |
| §13.1.4         | Playwright smoke matrix drops macOS                                                                                                                        |
| §14.1           | Release matrix drops macOS; CI matrix — see note below                                                                                                     |
| §16 `/download` | Two platforms; add an honest macOS statement (below)                                                                                                       |
| §5.4            | "No maintained authenticator GUI exists for macOS or Linux" — we now close half that gap, not all of it. Adjust the claim rather than leave it overstated. |

### CI matrix

Recommend dropping macOS runners entirely rather than keeping them "just for
unit tests". Linux already covers the POSIX path differences that matter, and a
green macOS test job on a platform we do not ship is a maintenance signal that
means nothing. It is one line to re-add when Apple enrollment happens.

### Do NOT ship an unsigned macOS build as a compromise

An unsigned .dmg would hit Gatekeeper's hardest warnings and teach users to
click through exactly the dialog our threat model depends on them respecting. It
would also contradict §P3 (verifiable releases) and §11 S11. **Shipping nothing
for macOS is strictly better than shipping something unsigned.**

### Say so publicly (D1 doctrine)

Silence on macOS invites "abandoned?" and "why is there a sketchy third-party
build?". A plain statement on `/download` and in MAINTENANCE.md is on-brand:

> macOS is not supported yet. Signing a macOS build requires Apple Developer
> enrollment as an organization, which we have not completed. We will not ship an
> unsigned macOS build — an authenticator you cannot verify is not worth
> installing. When that changes, it will be announced here.

That also pre-empts a fake "macOS version" appearing on a clone site: the
official position is documented and dated.

### Schedule effect

|                                           | Original    | Revised                                                    |
| ----------------------------------------- | ----------- | ---------------------------------------------------------- |
| Phase 1                                   | weeks 1–2   | weeks 1–2 (Apple enrollment removed)                       |
| 0.1 Windows alpha                         | weeks 3–4   | weeks 3–4                                                  |
| 0.2 Enrollment + import + Windows signing | weeks 5–7   | weeks 5–7                                                  |
| 0.3 Market auto-confirm + macOS beta      | weeks 8–10  | **Market auto-confirm + updater + Linux beta**, weeks 8–10 |
| 0.4 Trade auto-confirm + Linux beta       | weeks 11–12 | **Trade auto-confirm** (bake-limited), weeks 11–12         |
| 1.0                                       | weeks 13–14 | **weeks 12–13**                                            |

Roughly a week saved directly. The larger gain is removing an external
dependency with unpredictable latency from the critical path — Apple enrollment
stalling could have blocked 0.3 indefinitely, and nothing we did would have
fixed it.

Linux moves earlier (0.3 rather than 0.4) so the second platform is proven
before the riskiest feature lands, rather than alongside it.

---

## D12 — Q1 resolved: Open Desktop Authenticator

**Product name:** Open Desktop Authenticator
**Short name / acronym:** ODA
**Binary:** `oda`
**Domain:** `opendesktopauthenticator.com` (registered)
**Application id:** `com.opendesktopauthenticator.desktop`

### Why this name

- **It says what the product is.** The audience searches "steam desktop
  authenticator"; the name and page title answer that query directly, with no
  brand to learn first.
- **It matches SDA's register.** Steam Desktop Authenticator is a pure
  description. So is this. It reads as infrastructure — OpenSSH, OpenVPN,
  OpenSSL — rather than as a product launch.
- **"Open" is the actual differentiator.** The clones are closed binaries
  compiled from our source with malware added. Open source is the whole
  argument, and it is in the name.
- **ODA parallels SDA without claiming it.** A trader reads the lineage
  instantly; the name never states or implies that we made SDA, which §8
  forbids.
- **No Valve trademark**, so §7.2, D8 and §22.1 are satisfied and the domain is
  not a takedown target.

### The tradeoff, accepted knowingly

A descriptive name is close to **untrademarkable**. We would have weak grounds to
stop a clone registering `opendesktopauthenticator.net` or calling itself "Open
Desktop Authenticator Pro".

Accepted, because the defence never rested on trademark law. §3 records that
clone sites resurface under new domains every time one is reported — takedowns do
not work on them, which is precisely why §4's answer is a **verification chain**
rather than enforcement. The distinctive, defensible assets are **MASTERPANEL
LLC**, the GitHub organisation, and the name on the code-signing certificate. A
clone can copy the product name; it cannot produce a binary signed by MASTERPANEL
LLC.

Mitigation: register `.org`, `.net` and `.app` defensively, and list every
legitimate URL on `/official` (§16) so "not on this list" remains a clear test.

### Sections this closes or changes

| Section | Change                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------- |
| §23 Q1  | **Resolved.** Record in §1.                                                                       |
| §15     | Naming workstream complete; the public repo is no longer blocked on a name.                       |
| §16     | Site headline becomes `Open Desktop Authenticator — Open-Source Desktop Authenticator for Steam`. |
| §18     | `security@opendesktopauthenticator.com` can now exist; SECURITY.md updated.                       |

### The GitHub organisation — named, not yet created

`branding.repository` is now
`https://github.com/opendesktopauthenticator/open-desktop-authenticator`, so
`hasUnresolvedBranding()` reports false and release tooling no longer refuses on
branding grounds.

**This traded an automated block for a human commitment, and that is worth being
explicit about.** The check could only ever prove the string is not a
placeholder; it cannot prove the URL resolves. The organisation and repository
must be created under exactly that name before anything ships, because this URL
is the third link in §4's chain — website → company → **repository** → source →
CI build → signed binary — and it is what a suspicious user follows to decide
whether a download is ours. A dead link there does more damage than a placeholder
would, because a placeholder is obviously unfinished and a 404 looks like a
takedown.

It is on the release checklist as a human step for that reason.

---

## D13 — Steam Guard codes are generated in-house, not by `steam-totp`

**Deviates from §9**, which names `steam-totp` among the chosen libraries.

**Decision.** The shipped application does not depend on `steam-totp`. Code
generation is twenty lines in `src/main/codes/totp.ts`, written against
`node:crypto`.

**Reason.** Two, and the first is the real one:

1. **It is the most security-critical computation in the product and it fits on
   one screen.** §4's whole answer to the clone problem is a chain a stranger can
   walk without trusting anyone. "Read these twenty lines" is a shorter walk than
   "audit this package and its release process".
2. **Code generation is offline.** `steam-totp` also reaches Steam's clock
   endpoint. A module that can produce a code has no reason to be able to open a
   socket, and keeping the two apart means the code path cannot fail because
   something was unreachable.

**This is not a judgement on the library.** It is zero-dependency, 172 lines, and
the ecosystem standard. The spike still depends on it, and F5 will still use
DoctorMcKay's stack for sessions and confirmations — where the protocol work is
genuinely large and reimplementing it would be reckless rather than careful. §8
attribution is unchanged.

**The cost, and how it is paid.** Not depending on the library means "our codes
match everyone else's" stops being true by construction. So it is asserted:
`spike/tests/totp-parity.test.ts` generates codes with both implementations
across ~39,800 windows spanning 2020–2030 plus 200 random secrets, and fails on
any disagreement. It runs in CI on every push. This is now a reason the spike
must not be deleted, recorded in ARCHITECTURE.md.

**Reversing this is a five-line change** if the founder prefers the dependency:
`generateGuardCode` and `secondsRemaining` are the whole surface.

### Sections this changes

| Section | Change                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------- |
| §9      | `steam-totp` moves from an application dependency to a spike-only one                          |
| §9.4.5  | The production tree stays at three packages — react, react-dom, zod                            |
| §12 F4  | Codes are generated offline; the Steam clock sync is F5's, and its absence is stated in the UI |

---

## §24.3 — IPC surface change for F2, awaiting sign-off

Three channels were added to build maFile import. §24.3 requires founder
sign-off for any change to the IPC surface, so they are listed here in full
rather than buried in a diff.

| Channel          | Renderer sends                             | Renderer receives                                                                |
| ---------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| `import:scan`    | nothing                                    | one record per chosen file: name, account name, SteamID, four booleans, warnings |
| `import:commit`  | opaque staging ids + a replace flag per id | one outcome per id: imported / replaced / skipped, and why                       |
| `import:discard` | nothing                                    | `{ ok: true }`                                                                   |

Three properties are worth checking before signing this off, because they are
what keep the addition from widening the attack surface:

1. **No channel accepts a file path.** The OS picker is opened by the main
   process and is the only thing that names a file. The renderer cannot ask us to
   read an arbitrary path, so import adds no filesystem surface — the base name
   travels back purely so the user can tell two files apart.
2. **No channel returns a secret.** A candidate carries `hasRevocationCode`,
   `hasProxy` and `hasSession` — booleans, never values. The proxy URL is
   included in that rule because it usually embeds credentials.
   `tests/ipc-contract.test.ts` injects every known secret into an import
   candidate and asserts the schema strips it.
3. **Staged plaintext is bounded.** Between the picker and the commit the parsed
   secrets sit in main-process memory. They are dropped when a new scan replaces
   them, when the commit finishes, when the screen is left, when the vault locks,
   and after ten minutes regardless.

## §24.3 — IPC surface change for F4, awaiting sign-off

Two further channels, for Steam Guard codes.

| Channel      | Renderer sends | Renderer receives                                                                                                 |
| ------------ | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `codes:list` | nothing        | a code per account, seconds remaining, per-account failures, and whether the clock has been checked against Steam |
| `codes:copy` | a SteamID64    | the code, and when the clipboard will be wiped                                                                    |

**This is the first response that carries something usable, and that is
deliberate.** A Steam Guard code has to be readable or the product does nothing.
It is not a long-term secret: it expires inside thirty seconds, it cannot be
reversed into the shared secret that produced it, and it is worthless without the
account password. §11 S2 protects the shared secret, which never leaves the main
process — `tests/ipc-contract.test.ts` asserts a code response strips every
injected secret while keeping the code itself.

Copying runs in the main process rather than the renderer, because the clipboard
auto-clear has to outlive the page: the renderer is reloaded whenever the vault
locks, and a timer living there would die with it and leave the code on the
clipboard permanently.

## §24.3 — IPC surface change for the backup ceremony, awaiting sign-off

One channel, `revocation:confirmBackup` — `{ steamId64 }` in, `{ ok: true }` out.

§11 S12 and THREAT_MODEL both list the forced revocation-code backup as a
control we implement. It was half-built: the schema, the status and the reveal
channel existed, but nothing ever called the reveal and there was no way to
record that the backup had happened, so an imported account with a code sat in
`pendingRevocationBackup` **permanently**. A warning that cannot be cleared is
one people learn to look past, which is worse than no warning.

The channel takes **no passphrase**, deliberately. The dangerous half of the
ceremony is the reveal, which is already gated harder than S2 requires; this only
clears a warning the user is looking at. Asking for the passphrase twice inside
one flow teaches people to type it reflexively, which is the habit the gate on
the reveal depends on them _not_ having.

## Q19 — `steamcommunity` advisories: measured, with a recommendation

**§23 Q19 asked whether we can live with `steamcommunity`'s dependency
advisories. Here is the actual number, taken from `npm audit` in `/spike`:**

| Severity  | Count  |
| --------- | ------ |
| Critical  | 2      |
| High      | 6      |
| Moderate  | 3      |
| **Total** | **11** |

Every one arrives through **`request`**, which was deprecated in 2020 and will
never be patched. There is no upgrade that fixes them, because there is no
upgrade. The chain is `steamcommunity` → `request` → `form-data` (critical,
unsafe randomness for multipart boundaries), `tough-cookie` (prototype
pollution), `qs`, `uuid`; plus `cheerio` → `css-select` → `nth-check` (ReDoS)
and `image-size` (DoS).

### The part that decides it

`steamcommunity`'s own `EConfirmationType` reads, in full:

> `Trade: 2`, `MarketListing: 3` — with source comments "1 is unknown, possibly
> Invalid" and "4 is opt-out or other".

**Type 6 is not in it.** Phase 0 saw type 6 directly: it is an account-recovery
confirmation (F-12). A library whose model of the confirmation space is missing
the type that means _someone is taking your account_ is not a library to hand
account-approval decisions to — independent of its advisories.

### Recommendation: do not ship `steamcommunity`. Speak mobileconf directly.

The confirmation protocol is small: an HMAC over (identity secret, time, tag),
a `GET /mobileconf/getlist`, and a `POST /mobileconf/multiajaxop`. The signing
half is **already written and already proven** — `src/main/confirmations/key.ts`,
checked against `steam-totp` across thousands of times and every tag. What
remains is two HTTP calls and JSON parsing.

Doing it ourselves:

- keeps the production tree at three packages, so §9.4.5's claim stays true and
  `npm audit` on what ships stays clean;
- puts every Steam request through our own agent, which is what the founder's
  "complete proxy coverage, every Steam request" requirement actually needs —
  `request` has its own proxy handling that we would be fighting;
- means the confirmation-type model is ours (S16), not one missing type 6.

**`steam-session` is a separate question and the answer there is different.** The
login flow is genuinely large — RSA key fetch, polling, session migration — and
reimplementing it would be reckless rather than careful. It is not implicated in
these advisories. This recommendation is about `steamcommunity` only.

### What is built

Everything above the socket, built on the recommendation and reversible if the
founder decides otherwise — swapping in `steamcommunity` would mean replacing
`protocol.ts` and `client.ts`, not the rest.

- `src/main/confirmations/key.ts` — confirmation keys and derived device ids.
- `src/main/confirmations/policy.ts` — **S16**, the type allowlist.
- `src/main/confirmations/protocol.ts` — request building and response parsing.
- `src/main/confirmations/client.ts` — the two operations, with S16 enforced at
  the boundary that actually sends.

### The socket: no dependency needed after all

`ConfirmationsClient` takes an **injected transport**, so nothing in the
confirmation layer can open a connection and therefore nothing in it can bypass a
proxy. A client is built per account and physically cannot emit traffic for
another, closing F-08's cross-account bleed by construction rather than by
discipline.

The open question was what that transport is made of. It is answered, and the
answer removes the dependency question entirely: **Electron already contains
Chromium's network stack, which proxies per session — including SOCKS5.**

Measured, not assumed:

| Probe                            | Result                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `socks5://` to a dead port       | resolves to `SOCKS5 127.0.0.1:1`; request fails `ERR_PROXY_CONNECTION_FAILED` |
| `http://` to a dead port         | resolves to `PROXY 127.0.0.1:1`; same failure                                 |
| Unsupported scheme               | `setProxy` accepts it silently; requests fail `ERR_NO_SUPPORTED_PROXIES`      |
| Loopback target, socks5 rule set | **`DIRECT`** — loopback is bypassed by default                                |
| Same, with `<-loopback>`         | `SOCKS5 127.0.0.1:1`                                                          |

Four things fall out of this, three of which would otherwise have been found the
hard way:

1. **It fails closed.** A dead proxy produced no connection at all rather than a
   silent direct one. That is the property the anonymity promise rests on, and it
   is now measured rather than hoped for.
2. **An unsupported scheme is accepted without complaint** and only fails later,
   per request, with an error the user cannot connect back to the address they
   typed. So `egress.ts` validates the scheme itself and refuses early.
3. **`socks5h://` is not a Chromium scheme.** It is curl's spelling for remote
   DNS, which Chromium's `socks5` already does — but the literal string yields
   `ERR_NO_SUPPORTED_PROXIES`. The spike's own config uses `socks5h`, so this
   would have broken the first real run.
4. **Electron's default User-Agent announces `Electron/43.3.0`**, identifying this
   application to Steam _and to the proxy operator_ — the two parties §2.6 exists
   to keep at arm's length. Every request now sends an ordinary mobile string.

**§9.4.5 stands: the production tree is still react, react-dom and zod.**

Loopback staying direct is left as it is. No Steam host is on loopback, and
forcing Electron's own internal traffic through a user's proxy would be a
surprise with no benefit — but it is recorded here so nobody later assumes
`fixed_servers` means literally everything.

### Sections this changes

| Section | Change                                                                                                                             |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| §23 Q19 | **Resolved.** `steamcommunity` is not shipped, and no proxy dependency replaces it.                                                |
| §10.1   | Egress is per-account Electron sessions rather than process-global agent injection — which also answers A8: sessions, not workers. |
| §9.4    | No new production dependency for F5.                                                                                               |

---

## Q6 — scrypt work factor: proposal

**§10.3 proposes N=131072, r=8, p=1. Recommendation: keep it.**

Measured with `npm run benchmark:kdf` on a Ryzen 7 7800X3D (a fast desktop —
deliberately the wrong end of the range, see below):

| N          | memory      | per unlock |
| ---------- | ----------- | ---------- |
| 16384      | 16 MiB      | 25 ms      |
| 32768      | 32 MiB      | 61 ms      |
| 65536      | 64 MiB      | 103 ms     |
| **131072** | **128 MiB** | **208 ms** |
| 262144     | 256 MiB     | 417 ms     |

Reasoning:

- 208 ms here means roughly 1–2 seconds on a low-end laptop (5–8× slower), which
  is a noticeable but acceptable unlock. Users unlock once per auto-lock period,
  not per action.
- 128 MiB of memory cost is the point: it is what makes GPU and ASIC guessing
  against a stolen vault expensive, far more than the time alone.
- Going to 262144 doubles both, and the memory is the part that would start
  failing on low-RAM machines.

**`[FOUNDER]` this still needs one run on the slowest machine you expect a user
to have.** The benchmark exists for that; the number that matters is theirs, not
a developer workstation's. If an unlock there exceeds ~2 seconds, drop to 65536
and record it — people who find unlocking painful lengthen their auto-lock
timeout, which is a worse security outcome than a slightly lower work factor.

Raising it later is a migration, not a break: every vault stores its own KDF
parameters, so a future build reads the old ones, derives the old key, and
re-seals with new ones.

---

## D14 — sign-in uses `steam-session`, reverting an unrecorded deviation

**Restores §9**, which named `steam-session` among the chosen libraries all
along.

### What happened

Q19 said, in as many words:

> "`steam-session` is a separate question and the answer there is different. The
> login flow is genuinely large — RSA key fetch, polling, session migration — and
> reimplementing it would be reckless rather than careful."

The login flow was then reimplemented anyway: 369 lines in
`src/main/steam/login.ts` speaking Steam's authentication API directly, with no
amendment arguing the case. Nobody decided this. It drifted, and it survived
review because the surrounding decisions (D13, Q19) were sound and it looked like
more of the same.

The founder caught it by asking the obvious question — _why build this when the
library exists_ — and there was no answer, because there had never been one.

### Decision

`signIn` delegates to `steam-session`. It is a production dependency.

### What was measured before adopting it

|                                     |                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------- |
| Advisories in `steam-session` alone | **0**                                                                   |
| Packages it adds                    | 36                                                                      |
| Production audit after adopting     | **0 vulnerabilities**                                                   |
| Bundling                            | External — `require("steam-session")`, not inlined into the main bundle |

The eleven advisories recorded in Q19 all arrive through `steamcommunity` →
`request`. **None come from `steam-session`.** Conflating the two is what made
"McKay's libraries have advisories" feel like it covered all three.

### What is still ours, and why

- **The Guard code.** D13 stands. `generateGuardCode` is twenty auditable lines
  parity-tested against `steam-totp` on every push, and it is handed _to_ the
  library rather than the library fetching one — which keeps code generation
  offline.
- **The audience check.** The library asks for `MobileApp` and should return a
  mobile-scoped token. It is verified anyway: F-13 is the failure that looks like
  success, and the check costs one base64 decode.
- **The refusals.** A library returns `actionRequired`; a person needs to be told
  that their account uses email codes, or wants approval on the device they are
  trying to replace.
- **Confirmations.** Q19 is unchanged and `steamcommunity` is still not shipped.
  Its `EConfirmationType` has no type 6, and a library that cannot model _someone
  is taking your account_ is not one to hand approvals to.

### What it fixed on the way

`steam-session` authenticates to proxies itself, given `httpProxy` or
`socksProxy` with credentials inline. Our hand-wired Electron equivalent had
registered its credential handler on `Session`, which emits no `login` event —
so credentials were never sent and every authenticating proxy failed with
`ERR_TUNNEL_CONNECTION_FAILED`. That bug is the concrete cost of the deviation,
and it was found in live testing rather than by any test.

### Sections this changes

| Section | Change                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| §9      | `steam-session` returns to being an application dependency, as originally written                                                                |
| §9.4.5  | The production tree is **four** direct packages — react, react-dom, zod, steam-session — and 36 transitive. `npm audit --omit=dev` stays at zero |
| §12 F3  | The login protocol is the library's; the Guard code, audience check and refusal messages remain ours                                             |

### The rule this leaves behind

**A deviation from a recorded decision needs its own record.** D13 and Q19 are
defensible because they were argued in writing, with the cost named and paid.
The login rewrite was not worse engineering than those — it was unaccountable
engineering, and that is the difference that mattered.

---

## Pending — resolved findings that still need folding into the plan

From `PHASE0_FINDINGS.md`. Listed newest-impact first.

| #   | Change                                                                                                                                                                                                               | Section                 | Source    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------- |
| A1  | **New invariant S16**: auto-confirm acts only on an explicit confirmation-type allowlist and never on types the user has not enabled, including types unknown to the app. `acceptAllConfirmations()` is forbidden.   | §11                     | F-12      |
| A2  | `device_id` from imported maFiles is not sent to Steam and is not validated by it. Store it for export fidelity only.                                                                                                | §10.4                   | F-02      |
| A3  | MobileApp is load-bearing at the **token** level, not just the login level — a web-scoped token silently cannot drive confirmations. Vault must store the MobileApp refresh token and validate its audience on load. | §10.3, §10.4            | F-13      |
| A4  | Import must treat a maFile as credential-bearing: files in the wild carry live sessions, not just seeds. Strengthen the post-import warning.                                                                         | §12 F2                  | F-11      |
| A5  | Authenticator removal is supported by the library stack. §12 F3's "out of scope" is a scope choice, not a limit. Needs a decision (Q15) and, if adopted, a re-auth gate.                                             | §12 F3                  | F-09      |
| A6  | Soften §9.4.5's "embarrassingly small" dependency claim — the real tree is ~120 production packages, driven by `steamcommunity`'s dependency on the deprecated `request`.                                            | §9.4.5, §16 `/security` | F-05      |
| A7  | Record proxy routing as a decision with its public framing, and add the proxy operator as a threat-model adversary.                                                                                                  | §1, §7.1, THREAT_MODEL  | F-08      |
| A8  | Per-account proxy concurrency: process-global agent injection does not survive concurrent pollers. Decide worker-per-account vs owning the last mile.                                                                | §10.1                   | F-08, Q14 |
| A9  | Vault should carry a per-account proxy field — the ecosystem already stores one in the maFile.                                                                                                                       | §10.3, Q12              | F-11      |
| A10 | Pin Node to the LTS line in `.nvmrc`/`engines`; note TypeScript 7 removed `moduleResolution: "node"`; zod is 4.x.                                                                                                    | §9.1, §9.4              | F-06      |

**A1 is the one that cannot wait.** It is a security invariant, and F6 built
without it would auto-approve account takeovers. It belongs in THREAT_MODEL.md
v1, which is a Phase 1 deliverable.
