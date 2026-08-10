# Phase 0 — Findings

Findings from building the spike (§19 Phase 0). Per §24.6, anything that changes
an assumption in the master plan is recorded here so it can be folded into §10.4
and §1 rather than living in a chat log.

**Status of this document:** findings are verified by reading the installed
library source, by running the spike offline, and — as of the first live run —
against one real account routed via an HTTP proxy. (The account and proxy are
deliberately not named here, per §11 S15.) Items still needing a live answer are
marked **UNVERIFIED — needs live run**.

### Live run 1 — summary

Account routed through a real HTTP proxy, session established from the maFile's
stored refresh token (no password used at any point).

| Step            | Result                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------- |
| `import`        | Parsed clean. Exposed a real `device_id` mismatch (F-02) and a reporting bug of ours (F-01). |
| `code`          | Generated; time offset 1s. All traffic proxied.                                              |
| `login`         | **Authenticated.** SteamID confirmed, refresh token valid to 2027-02-28.                     |
| `confirmations` | **Fetched successfully.** Empty list — the account had none outstanding.                     |
| `accept`        | **Not run** — cannot be tested without a pending confirmation.                               |

### Live run 2 — password + TOTP login

Run by the founder (the agent does not handle passwords). Same account, same
proxy, `SPIKE_FORCE_PASSWORD=1` to bypass the stored refresh token.

**Result: `actionRequired: false`, no guards offered, authenticated.** This
**resolves F-07** — see that section. 10 requests, all proxied.

### Phase 0 exit criteria (§19) — **GATE PASSED**

| Step                    | State                                                          |
| ----------------------- | -------------------------------------------------------------- |
| Login on a real account | **PASS** — 2 accounts, 2 IPs, refresh-token and password paths |
| Import a real maFile    | **PASS** — 3 files, 3 format variants                          |
| Code matches            | **PASS** — offset 1–2s; founder to eyeball against the phone   |
| List confirmations      | **PASS** — including an unrecognised type handled gracefully   |
| Accept one              | **PASS** — confirmation 21453008231 accepted, type 6           |

The accept ran through the interactive consent prompt (no `--yes`), so the
guard-rail path is proven too, not just the API call.

Every request in every command across all runs went through the proxy, per the
egress audit — 14 requests on the final run, zero unproxied. Nothing was written
to disk at any point in any run.

**§19 states: "Exit criteria: full loop succeeds on both accounts. No Electron
scaffolding before this passes." That condition is now met.**

Findings that only a live run could have produced: **F-07** (resolved — the
highest-risk open question), **F-11** (maFiles carry live sessions), **F-12**
(critical — account-security confirmations appear in mobileconf), **F-13** (token
audience scoping). None were visible from reading the libraries.

---

## F-01 — SDA writes SteamID as a JSON number, and it does not survive `JSON.parse`

**Severity: high. Affects §12 F2 (import), §10.4.**

An SDA maFile stores the account's SteamID inside `Session.SteamID` as a bare
JSON number:

```json
"Session": { "SteamID": 76561199999999999 }
```

A SteamID64 is ~7.66 × 10¹⁶. `Number.MAX_SAFE_INTEGER` is ~9.01 × 10¹⁵. Every
SteamID64 is therefore **outside the range JavaScript can represent exactly**,
and `JSON.parse` silently rounds it to the nearest representable double.

Measured on the spike's three fixtures — all three distinct IDs collapse onto the
same wrong value:

| In the file         | After `JSON.parse`  |
| ------------------- | ------------------- |
| `76561199999999997` | `76561200000000000` |
| `76561199999999998` | `76561200000000000` |
| `76561199999999999` | `76561200000000000` |

The consequence for the product is concrete: duplicate detection by SteamID64
(§12 F2) would collide unrelated accounts, and any account keyed on the parsed
value would be keyed on a different account's ID.

**Handled in the spike.** `src/mafile.ts` extracts the SteamID as digits from the
raw file text and never trusts the parsed number. Covered by a regression test.

**Refined by live run 1.** Both forms exist in the wild. SDA writes the value
unquoted (hazardous); files written by session-managing tools quote it:

```json
"Session": { "SteamID": "7656119xxxxxxxxxx" }   ← quoted, survives JSON.parse
```

Our first implementation warned on _every_ out-of-range SteamID regardless of
quoting, so it cried wolf on the real file. Fixed: the extractor now distinguishes
quoted from unquoted via a backreference, and only the unquoted case warns.
Crying wolf here is not harmless — it trains the reader to skip the warning on the
files where it genuinely corrupts data.

**Action for Phase 1:** the vault schema and the import path must treat
`steamId64` as a **string** end to end. Add this to the §13.1 unit list as a
permanent test vector.

---

## F-02 — `device_id` from the maFile is not used when building confirmation requests

**Severity: medium. Corrects §10.4.**

§10.4 says: "Device ID: use the value from imported maFiles when present;
otherwise derive SDA-compatibly from the SteamID."

That is not how the request is actually built. `steamcommunity` computes the
device ID itself on every mobileconf request, from the SteamID, ignoring
whatever the maFile held:

```js
// node_modules/steamcommunity/components/confirmations.js:254
params.p = SteamTotp.getDeviceID(community.steamID);
```

So for confirmations the stored `device_id` is **informational only** unless we
stop using `steamcommunity`'s confirmation helpers.

The good news is that the derivation agrees. The spike compares the two on
import; for a classic SDA file they match exactly:

```
device_id : android:d6cb3212-d482-7522-9e81-51dd9ebf8558
derived   : android:d6cb3212-d482-7522-9e81-51dd9ebf8558  → MATCH
```

**RESOLVED by live run 1.** The real account's file carries a `device_id` that
does **not** match the derivation:

```
device_id : android:eaaf6e17-69d0-4994-9f5e-d4a148ceae48   (stored in the maFile)
derived   : android:9ed56786-2398-d0c0-78b4-473359a0de4f   (what steamcommunity sends)
                                                    -> DIFFERENT
```

So the mismatch is not hypothetical — it is the normal case for files written by
SDA, which generates a **random** UUID at enrollment rather than deriving one.

And the confirmation fetch **succeeded anyway**. Steam accepted a mobileconf
request carrying the derived device ID for an authenticator that was registered
with a different one. That settles it: Steam does not validate `device_id` on
confirmation requests, and the stored value is genuinely informational.

**Action for Phase 1:** keep storing `device_id` on import (it is part of maFile
round-trip fidelity for export, §12 F7), but do not build logic that depends on
it being the value sent to Steam. Reword §10.4 accordingly — its "use the value
from imported maFiles when present" instruction is not implementable through
`steamcommunity` and, per this run, not necessary either.

---

## F-03 — MobileApp is not a preference, it is the only viable platform type

**Severity: informational. Confirms §10.4.**

`steam-session` documents that, as of 2025-04-30, `getWebCookies()` and
`refreshAccessToken()` work **only** for `WebBrowser` and `MobileApp`.
`SteamClient` fails with `AccessDenied` unless the call is made over an
authenticated CM session, which requires `steam-user` — a dependency §7.2
explicitly forbids.

Since mobile confirmations require mobile-app semantics anyway, `MobileApp` is
the only path that satisfies both constraints. §10.4's choice is correct and
should be recorded as load-bearing rather than incidental.

---

## F-04 — Confirmation request tags have changed; the old ones still work

**Severity: informational. Affects §12 F5, §12 F6.**

The current Steam app sends `list` to read confirmations and `accept` / `reject`
to act on them. `steamcommunity` still accepts the older `conf` / `allow` /
`cancel` tags for backwards compatibility, and its own convenience helpers use a
mix of both.

The spike uses the modern tags explicitly (`src/steam/confirmations.ts`) rather
than relying on the compatibility path, on the assumption that the compatibility
path is the one Valve eventually removes.

The confirmation key is an HMAC over (identity_secret, unix time, tag), so the
tag used to _generate_ the key must match the tag _sent_. That coupling is easy
to get wrong and is worth a unit test in Phase 1.

---

## F-05 — The dependency-count promise in §9.4.5 is going to be uncomfortable

**Severity: strategic — founder decision needed. Affects §9.4, §16 `/security`.**

§9.4.5 says the production dependency count is published on the security page,
and that "keeping that number embarrassingly small is a stated product feature."

Measured for the spike's four runtime dependencies:

```
Production packages, including transitive: 120
```

Where they come from:

| Direct dep       | Version | Direct dependencies of its own                           |
| ---------------- | ------- | -------------------------------------------------------- |
| `steam-totp`     | 2.1.2   | **none**                                                 |
| `zod`            | 4.4.3   | none                                                     |
| `steam-session`  | 1.9.4   | 10 (`protobufjs`, `websocket13`, `socks-proxy-agent`, …) |
| `steamcommunity` | 3.50.3  | 9, including **`request`**                               |

`steamcommunity` is the problem. It depends on `request`, which has been
deprecated since 2020 and drags in a long tail of its own (`har-validator`,
`uuid@3`, `lodash.pick` — npm prints deprecation warnings for all of them on
install). It also pulls `cheerio`, `xml2js`, and `image-size`.

This does not block anything, and it is not an argument for forking — §9.3/D3
delegating the protocol layer is still right, and reimplementing it would be far
worse. But the founder should decide _now_ how §9.4.5 and the `/security` page
present this, because "our dependency count is embarrassingly small" is not a
claim the current tree supports, and a hostile reader on Reddit will run
`npm ls` themselves.

Honest options, in the spirit of D1:

1. Publish the real number with the breakdown, naming `request` as inherited
   from an upstream library and out of our control. Transparency over spin.
2. Publish direct-vs-transitive separately (4 direct, 120 total), explained.
3. Use `steamcommunity` only for confirmations and evaluate whether that slice
   can be reimplemented against `steam-session` alone later. **Do not attempt
   this before 1.0** — it is exactly the protocol-reimplementation D3 rules out.

Recommendation: option 1 or 2. Either way, §9.4.5's wording needs softening from
"embarrassingly small" to something defensible.

### ESCALATION (Phase 1) — it is not just the count, it is the advisories

Running `npm audit --omit=dev` against the spike's tree:

```
CRITICAL  form-data        fix: BREAKING
CRITICAL  request          fix: BREAKING
HIGH      cheerio          fix: BREAKING
HIGH      css-select       fix: BREAKING
HIGH      image-size       fix: BREAKING
HIGH      lodash.pick      fix: BREAKING
HIGH      nth-check        fix: BREAKING
HIGH      steamcommunity   fix: BREAKING
MODERATE  qs, tough-cookie, uuid
```

**2 critical, 6 high, and not one of them has a non-breaking fix.** Every single
one traces to `steamcommunity` → `request`, dead since 2020.

Three things follow:

1. **This becomes a CI gate failure at milestone 0.1.** `steamcommunity` enters
   the _shipping_ dependency tree the moment confirmations (F5) are built. The
   `security` job's `npm audit --audit-level=high --omit=dev` will fail from that
   commit onward. CI is currently green only because the app does not depend on
   it yet.

2. **It is a live reputational risk, not a theoretical one.** §9.4.5 commits us to
   publishing the dependency count on the security page. A hostile reader will
   run `npm audit` themselves, and "open-source Steam authenticator ships two
   critical CVEs" writes itself. `cheerio` is not even an unused path — it parses
   Steam's confirmation detail pages.

3. **It sharpens option 3 above.** Using `steamcommunity` _only_ for the three
   mobileconf endpoints and calling them directly through `steam-session`'s HTTP
   client would remove `request`, `cheerio`, `xml2js` and `image-size` in one
   move. That is a few hundred lines against endpoints we have now exercised
   live, not a protocol reimplementation in the sense D3 rules out.

**Decision needed before 0.1 (Q19).** The options are: accept and publish a
per-CVE justification; drop `steamcommunity` for the confirmation path; or
upstream a `request` removal. Doing nothing means CI goes red at 0.1 and stays
red, which trains everyone to ignore it — the worst of the three.

---

## F-06 — Toolchain drift versus §9.1

**Severity: low. Affects §9.1.**

- **Node.** This machine runs **v25.8.1**, which is the _Current_ line, not LTS.
  §9.1 pins "current LTS". Development on Current is fine, but `.nvmrc` and
  `engines` must pin the LTS line, and CI must build on it, or we will ship
  something that was never tested on the version users get.
- **TypeScript.** `typescript@latest` now resolves to **7.x** (the native
  compiler). It **removes** `"moduleResolution": "node"`; the spike uses
  `node16`. Phase 1's tsconfig must not be written from muscle memory.
- **zod.** `latest` resolves to **4.x**, not the 3.x the plan was written
  against. API used here is unchanged, but §9.4's pinning rule matters more than
  usual across this major.

---

## F-07 — RESOLVED: credentials + TOTP is sufficient. No device confirmation demanded.

**Settled by live run 2. This was the highest-risk open question in the project.**

A full password login with a TOTP code generated from the maFile's
`shared_secret`, routed through an HTTP proxy:

```
  actionRequired : false
  guards offered : (none reported)

  authenticated  : yes
```

Steam did not offer `DeviceConfirmation`, did not require the official mobile app,
and did not require any human step. The login completed **fully unattended**.

**Why this mattered.** If Steam had demanded in-app approval, a desktop
authenticator would have been unusable for exactly the person it is built for —
someone migrating _away_ from the Steam mobile app, who may no longer have it
installed or may have lost the device. That would have forced a design answer
before Phase 1. It does not.

**What this licenses:**

- §10.4's login design is correct as written and can be built on.
- The canary (§13.2) is viable: login → code → confirmations is fully automatable
  with no human in the loop.
- F4 (login codes) and F5 (confirmations) have no hidden human dependency.

**Caveat on scope:** this is one account, one run. Steam is known to vary guard
requirements by account age, recent IP history, and risk scoring — and this
account logs in from the proxy IP habitually. An account logging in from a
brand-new IP may be treated differently. Worth re-testing during the 0.1 dogfood
period from a fresh network, but this is no longer a design risk.

### Side observation — a password login mints a NEW refresh token

The token returned expires 2027-03-06; the one stored in the maFile expired
2027-02-28. So a credentials login issues a fresh token rather than returning the
existing one.

**Action for Phase 1:** after any password login the vault must persist the
newly issued token, not keep reusing the imported one. Steam also caps concurrent
sessions per account, so repeatedly logging in with credentials rather than
refreshing will eventually evict older sessions — the app should prefer the
refresh-token path (§10.4) and fall back to credentials only when it fails.

---

## F-07 (original analysis, retained for context)

**Affects §10.4, §12 F3/F4.**

`steam-session` documents that `DeviceCode` and `DeviceConfirmation` guards can
both be offered at once. If Steam insists on `DeviceConfirmation` for an account,
supplying a correct TOTP code is not enough — approval has to happen in the
official mobile app, which a desktop authenticator obviously cannot do for a
user who is migrating _away_ from that app.

The spike does not paper over this. If `actionRequired` is still set after the
code is supplied, it fails with an explicit message naming the guard types and
pointing at this document.

This is the single most important thing the live run can tell us. If it fires on
real accounts, it affects the core value proposition and needs a designed answer
before Phase 1 — not a workaround discovered at milestone 0.1.

---

## F-08 — Proxy support: half of it is a trap, and the framing is a §4 problem

**Severity: high on both counts. Added at founder request; not in the plan.**

### The technical trap

`steam-session` and `steamcommunity` do not have the same proxy support, and the
gap is silent:

| Library          | Proxy support                                                             |
| ---------------- | ------------------------------------------------------------------------- |
| `steam-session`  | First-class: `httpProxy`, `socksProxy`, `localAddress`, `agent`           |
| `steamcommunity` | **None.** Only `localAddress`, or a `request` instance you build yourself |

Wire up only the documented one and you get a tool that proxies the **login** and
then fetches and accepts **confirmations from the real IP**. The user sees the
proxy configured, sees the login succeed, and is not covered for the traffic that
actually recurs — auto-confirm polling every 15 seconds (§12 F6) would be beaconing
the real IP continuously.

That is strictly worse than shipping no proxy support, because it converts a
known gap into a false guarantee.

### The hole config alone cannot close

Setting proxy options on both libraries is still not complete coverage, because
one call has no proxy API at all:

```js
// node_modules/steam-totp/index.js:108
let req = require('https').request({
    "hostname": "api.steampowered.com",
    "path": "/ITwoFactorService/QueryTime/v1/",
    ...
});                            // ← no `agent` option, no way to pass one
```

And `steamcommunity` calls it **internally**, from inside functions we do
call — so the hole is not just "don't use `getTimeOffset` yourself":

| Caller                                                                           | Reached during                |
| -------------------------------------------------------------------------------- | ----------------------------- |
| `steamcommunity/components/twofactor.js:106` (`finalizeTwoFactor`)               | **enrollment** (F3)           |
| `steamcommunity/components/confirmations.js:164` (`acceptConfirmationForObject`) | the convenience accept helper |

**Solution implemented.** Because `https.request` falls back to the module's
global agent when given none, the fix is to stop configuring per-library proxies
and instead:

1. Build **one** agent instance (`createAgents`) — SOCKS via `socks-proxy-agent`,
   HTTP via `@doctormckay/stdlib`, which is the same call `steam-session` makes
   internally for its own `httpProxy` option.
2. Point every transport at that same instance — `steam-session` via `agent`,
   `steamcommunity` via a `request` instance with `agent` + `pool: false`.
   Deliberately _not_ `request`'s own `proxy` option, which builds its own
   tunnelling agent that would be indistinguishable from a leak.
3. Patch `http(s).request` / `.get` at the module entry point (`src/egress.ts`)
   to inject that agent into any request that arrived without one, and to record
   every outbound request.

**Verified empirically, not just asserted.** With a dead proxy at
`socks5h://127.0.0.1:1`, the time sync fails with `ECONNREFUSED 127.0.0.1:1` —
the proxy's address. Before the guard, that same call completed normally against
Steam. Every command now ends with an egress audit:

```
── Egress audit
  api.steampowered.com           1 request(s)  via proxy
  all 1 request(s) went through the proxy.
```

### The trap inside the fix: HTTP proxy agents recurse

Injecting the agent at the `http(s).request` entry point breaks HTTP proxies
outright unless the proxy's own host is exempted.

An HTTP proxy agent establishes its tunnel by issuing **its own request to the
proxy host**. The guard sees that request, injects the proxy agent into it, and
the agent issues another request — `Maximum call stack size exceeded`, on every
single HTTP-proxy login. SOCKS never triggers it, because `SocksProxyAgent`
opens a raw socket rather than making an HTTP request. So the bug is invisible
if SOCKS is all you test.

Fix: requests aimed at the proxy host are pinned to a plain agent and recorded
as a `proxyLeg` — the tunnel itself rather than traffic inside it. The audit
labels them separately so the row does not read as a leak:

```
── Egress audit
  api.steampowered.com           1 request(s)  via proxy
  127.0.0.1                      1 request(s)  the proxy itself (tunnel)
```

Regression-tested in `tests/egress-bypass.test.ts`. **Phase 1 will hit this same
trap** the moment it does entry-point injection, whichever concurrency model it
picks.

### Phase 1 caveat — this technique does not survive concurrency

Module patching and `globalAgent` are **process-wide**. That is fine here (one
account per invocation) but it directly conflicts with §10.1's per-account
pollers: two accounts polling concurrently through _different_ proxies cannot
both be served by one process-global agent.

Two ways out, and it is an architecture decision, not an implementation detail:

- **(a) One worker per account.** Isolate each account's networking in its own
  process/worker, keeping the global-agent technique valid. Simple, heavier.
- **(b) Own the last mile.** Implement the ~20-line time query ourselves through
  a per-account agent, and wrap the two `steamcommunity` functions that call
  `getTimeOffset` internally so nothing reaches a global. No global state, and it
  fits §10.4's "one thin module" plan.

Recommendation: **(b)**, with (a) as the fallback if wrapping proves brittle.
Either way this needs deciding before the auto-confirm engine is built, because
that is where concurrent per-account polling starts.

### Remaining leak path

- **DNS.** `socks5://` resolves hostnames locally; `socks5h://` resolves at the
  proxy. With plain `socks5`, the local resolver still sees every Steam hostname.
  The spike accepts both, warns nowhere, and the docs recommend `socks5h` — Phase 1
  should probably refuse plain `socks5` outright, or at least warn loudly.

### The framing problem

This one is the founder's call, and it is worth ten minutes before it ships.

§22.2 lists "no ToS-aggressive features" as an explicit mitigation for platform
risk, and §4's doctrine is built on the premise that a _discovered_ connection is
fatal. The stated purpose here — "so users cannot IP-link the accounts" — is
specifically about defeating account association, which is the mechanism Valve
uses to detect multi-accounting and ban evasion.

The concrete risk: a skeptical reader finds that the maintainer of
`buysteamaccounts.com` ships an authenticator with per-account proxy routing
whose documented purpose is preventing accounts from being linked. That is the
§4 scenario the whole transparency doctrine exists to prevent, and it lands
hardest on exactly the trust the project is being built to earn.

The feature itself is ordinary and defensible — DoctorMcKay put proxy options in
`steam-session` deliberately, and there are real reasons a user wants their
authenticator traffic off their home IP. What is not ordinary is the rationale.

Recommended handling, in the spirit of D1 rather than around it:

1. **Ship it as network routing, documented as a privacy control**, not as
   unlinking. "Choose which network each account's traffic uses" is true,
   sufficient, and describes the same feature.
2. **Warn about proxy provenance in the app, not just the docs.** The users who
   want this buy cheap residential proxies of unknown ownership. A proxy operator
   sees every host contacted, and one whose CA the user has installed sees
   everything. That warning belongs next to the setting.
3. **Record it in §1 as a decision with its rationale**, so it is volunteered
   rather than discovered — which is the entire §4 play.
4. **Add it to THREAT_MODEL.md** as both a mitigation (real IP not exposed to
   Valve) and a new adversary (the proxy operator).

### Dependencies this pulled in

`socks-proxy-agent@7.0.0` and `request@2.88.2` are now **direct** dependencies of
the spike. Both were already in the tree transitively, and §9.4 forbids relying
on a transitive, so declaring them is correct — but `request` is deprecated
(F-05) and this deepens the commitment to it. **§9.4.2 requires founder approval
for both before Phase 1 adopts them.**

---

## F-09 — Removing/moving an authenticator IS supported. §12 F3 was a scope choice, not a limit

**Severity: corrects the plan. Founder is right.**

`steamcommunity` has had this all along:

```js
// components/twofactor.js:117
SteamCommunity.prototype.disableTwoFactor = function(revocationCode, callback)
//   → POST api.steampowered.com/ITwoFactorService/RemoveAuthenticator/v1/
//     { steamid, revocation_code, steamguard_scheme: 1 }
```

So §12 F3's "removal happens via Steam/phone, out of our scope in v1" describes a
decision, not a technical constraint. If the founder wants it in v1, nothing in
the library stack is in the way. It needs `setMobileAppAccessToken`, which we
already do for confirmations.

Two consequences that come with it, both worth deciding deliberately:

1. **It raises the stakes on the revocation code enormously.** Right now the
   forced-backup ceremony (§11 S12) is justified as disaster recovery. Once
   removal is a feature, the revocation code is also a _functional prerequisite_ —
   and every account imported without one (§12 F2 allows this, with a warning)
   silently cannot use the feature. The import report should say so explicitly.

2. **It is a new and serious threat-model entry.** "Remove authenticator" in the
   app means an attacker with an unlocked vault can strip 2FA off every account
   in one pass — turning a vault compromise into permanent account takeover
   rather than a bounded one. If this ships, it should demand passphrase
   re-entry per removal, never be bulk-applicable, and be listed in
   THREAT_MODEL.md as an accepted risk with its mitigation.

---

## F-10 — Phone number: the library never manages one, and does not need one

**RESOLVED. Settled by live run, 2026-08-10, against a phoneless account.**

**A phone number is not required.** `AddAuthenticator` succeeded on an account
with none: Steam attached the authenticator and returned the full set of secrets,
with `phone_number_hint` **absent**. The activation code is delivered by email
instead of SMS.

This is the answer the section below said only a live run could give, and it
decides two things it flagged:

1. §12 F3 needs **no** precondition screen demanding a phone, and no link to
   Steam's add-phone flow. The enrollment screen now says a phone is optional and
   explains which way the code will arrive.
2. `validate_sms_code: 1` must be sent **only when `phone_number_hint` came
   back** — otherwise Steam is asked to check an SMS it never sent. The first
   implementation sent it unconditionally, and the screen told a user with no
   phone to go and read a text message. Both are fixed and covered by tests.

The original analysis is kept below, because it predicted the shape of the answer
correctly: McKay's own example only mentions SMS `if (response.phone_number_hint)`.

---

**Original analysis — partly resolved from source; the decisive part was UNVERIFIED.**

Two separate claims, with different answers.

**"Phone management is possible in the McKay lib" — no, and it does not have to be.**
There is no `addPhoneNumber` / `verifyPhoneNumber` anywhere in `steamcommunity`
3.50.3. A grep for `phone` across the package returns only three things: an
`EResult` constant, the example script, and this line in the enrollment request:

```js
// components/twofactor.js:25
sms_phone_id: '1',
```

The library does not manage phones at all. It sends `AddAuthenticator` and lets
Steam decide.

**"A phone number isn't needed for activation" — plausible, and cheap to settle.**
Source-level evidence points both ways and cannot resolve it:

- _For:_ `enableTwoFactor` takes no phone parameter, and the response field
  `phone_number_hint` is treated as **optional** by the library's own example —
  it only mentions SMS `if (response.phone_number_hint)`. An activation path that
  does not go via SMS is consistent with that.
- _Against:_ the same example prints "Do you have a phone number attached to your
  account?" on failure, implying it is a known failure mode.

This is server-side behaviour and no amount of reading the library settles it.
**One live run against a phoneless throwaway account answers it definitively**, and
it is worth doing early — the answer decides whether §12 F3's precondition screen
and its "link the user to Steam's own add-phone flow" step exist at all.

Note this interacts with §13.1.5: enrollment cannot be canaried daily without
burning phone numbers. If activation genuinely works without a phone, that
constraint weakens considerably and enrollment may become canary-able after all.

---

## F-11 — Real maFiles carry session state and proxy config the SDA format never had

**Discovered in live run 1. Affects §12 F2, §10.3, and the proxy work.**

The real file contains fields no SDA maFile has:

| Field                  | Content                       | Why it matters                                                       |
| ---------------------- | ----------------------------- | -------------------------------------------------------------------- |
| `Session.RefreshToken` | Live JWT, valid to 2027-02-28 | A session can be established **without the account password at all** |
| `Session.AccessToken`  | Short-lived JWT               | Expires ~1 day; not useful on its own                                |
| `Session.proxy`        | `http://user:pass@host:port`  | Per-account proxy routing, already bound to the account              |
| `Session.proxy_type`   | `http`                        | Redundant with the URL scheme                                        |

Three consequences:

1. **Import must treat a maFile as credential-bearing, not just secret-bearing.**
   A file with a live refresh token is a ready-to-use session. The §12 F2 post-import
   hint ("your original maFiles are still on disk unencrypted") understates this —
   such a file is not merely a seed for codes, it is an active login.

2. **The password may never be needed.** The spike now prefers a live refresh
   token and only prompts for a password when there is none or it has expired.
   That is strictly better under §11 S8 — a password that is never typed cannot
   leak — and it matches what the real app does on every launch after first login.
   It also means **F-07 stays open**: this path never exercises the credentials +
   Steam Guard handshake.

3. **The ecosystem already does per-account proxying, in the file.** The spike now
   honours `Session.proxy` as the default for that account, with env vars
   overriding. This is a strong argument that Phase 1's vault should carry a
   per-account proxy field (Q12) — the workflow exists and users already expect it.

Import now reports refresh-token presence and expiry, so a stale token is caught
before it is used rather than as a confusing auth failure.

---

## F-12 — CRITICAL: mobileconf serves ACCOUNT RECOVERY confirmations, and the type enum is incomplete

**Severity: critical. Changes the F6 auto-confirm design. Discovered in live run 3.**

Fetching confirmations on a second live account returned this:

```
-- id 21453008231   [Unknown (type 6)]
   Account details - Account recovery
```

Two facts, both load-bearing:

1. **`/mobileconf/getlist` is not limited to trades and market listings.** It also
   serves account-security confirmations — the ones that authorise changing the
   password, changing the email, and recovering the account.
2. **`steamcommunity`'s `EConfirmationType` does not know about them.** It defines
   only `Trade: 2` and `MarketListing: 3`, with a source comment guessing
   _"4 is opt-out or other like account confirmation?"_. The real value observed
   is **6**, and it is account recovery. The enum is incomplete and its own author
   flags it as uncertain.

### Why this is critical for F6

§12 F6 describes auto-confirm as two switches, market and trade. The engine polls
for confirmations and approves them. If that engine is built to approve what it
fetches, then:

> **An attacker who initiates account recovery gets it auto-approved by the
> victim's own authenticator, within one poll interval — 15 seconds by default.**

The user's second factor would be actively working against them, completing the
exact account takeover that this project exists to prevent. It would be a
catastrophic, headline-grade vulnerability in a security product.

The default poll interval makes it worse: the victim has ~15 seconds to notice,
and the whole point of auto-confirm is that they are not watching.

### Required design rules (not optional; these belong in §11 as invariants)

- **Allowlist, never blocklist.** Auto-confirm may act ONLY on confirmation types
  explicitly enabled by the user — 2 (trade) and 3 (market listing). Everything
  else is ignored, always, with no setting that changes this.
- **Unknown types are never auto-actioned.** Type 6 today; Valve can add 7
  tomorrow without telling anyone. An engine that treats "not recognised" as
  "probably fine" is broken by construction.
- **Never use `steamcommunity.acceptAllConfirmations()`.** It accepts everything
  the list returns, by design. It must not appear anywhere in this codebase.
  Same for `acceptConfirmationForObject` without a type check.
- **Account-security confirmations must be surfaced loudly in the UI**, never
  silently. An account-recovery confirmation appearing unexpectedly is the single
  strongest signal a user will ever get that they are being attacked. The app
  should treat it as an alert, not a list item.
- The manual confirmations view (F5) should label unknown types clearly rather
  than hiding them — the spike's `Unknown (type 6)` fallback is the right
  behaviour and should survive into the product.

### Action

Add to §11 as a new invariant (proposed **S16**): _auto-confirm operates on an
explicit type allowlist and never acts on a confirmation type the user has not
enabled, including types unknown to the application._

This also strengthens the case for the F6 consent copy: the risk is not only
"someone lists your items", it is "your authenticator approves things you never
saw", and the type allowlist is what bounds that.

---

## F-13 — A stored web session cannot drive confirmations. Only a mobile-scoped token can.

**Affects §10.4, §10.3, and any "restore session from maFile" shortcut.**

Steam scopes tokens by platform, in the JWT `aud` claim. Measured across two real
files:

| Token                              | `aud`                          | Usable for mobileconf        |
| ---------------------------------- | ------------------------------ | ---------------------------- |
| `Session.AccessToken` (both files) | `[client, web]`                | **No**                       |
| `Session.RefreshToken` (file 1)    | `[web, renew, derive, mobile]` | Yes — derives a mobile token |
| `Session.RefreshToken` (file 2)    | empty                          | n/a                          |

Attempting to use a stored web access token for confirmations fails with
`Provided token is not valid for MobileApp platform type` — thrown by
`steamcommunity.setMobileAppAccessToken`, which checks the audience.

So a maFile carrying a live `SteamLoginSecure` + `AccessToken` is **not** a
shortcut to a working confirmations session. The web session is genuinely a
different credential class. Only a refresh token minted by a `MobileApp` login
carries `mobile` in its audience and can derive what mobileconf needs.

**Consequences:**

- §10.4's insistence on `EAuthTokenPlatformType.MobileApp` is not a detail, it is
  load-bearing at the _token_ level, not just the login level. A web login gives
  a token that looks fine, is unexpired, and silently cannot confirm anything.
- The vault (§10.3) must store the MobileApp refresh token specifically, and the
  app should validate the audience on load rather than discovering the problem at
  the first confirmation attempt.
- Import should report token scope, not just presence — "has a refresh token" is
  not the same as "has a usable one".

**Handled in the spike.** `openCommunity` now checks the audience before trying a
stored session and falls back with a plain-language reason instead of surfacing
steamcommunity's opaque error.

---

## F-14 — Bugs found by re-verification and stress testing

Recorded because each one is a class of mistake Phase 1 can repeat.

| #   | Bug                                                                                    | How it was found                            | Why it mattered                                                                                                                                |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | HTTP proxy agents recursed forever (`Maximum call stack size exceeded`)                | testing the HTTP path separately from SOCKS | Broke every HTTP-proxy login. Invisible if only SOCKS is tested.                                                                               |
| 2   | Egress audit filed one host under two keys (`host:port` vs `hostname`)                 | targeted verification harness               | An audit that can show a host as both proxied and direct is not evidence.                                                                      |
| 3   | "Session expired" warning printed for a token that was merely wrong-scoped             | re-reading the code                         | Contradicted the warning printed directly above it; sends debugging the wrong way.                                                             |
| 4   | Write-back rejected any value needing JSON escaping                                    | a test with quotes/backslashes in the value | Silent skip. Never fires on JWTs, so it would have surfaced years later on some other field.                                                   |
| 5   | Egress records grew without bound                                                      | stress test, 20k requests                   | A Phase 1 auto-confirm poller runs for days at ~1 request/15s. Slow leak. Now capped at 1000 detail records with exact totals kept separately. |
| 6   | `AuthenticatedSession.proxy` documented as driving the transport when it no longer did | re-reading after a refactor                 | Dead code that looks load-bearing is worse than none.                                                                                          |

Two of my own **test harnesses** also had bugs worth noting, because both are
traps Phase 1 will hit:

- The stress fixture generator built SteamIDs with `Number(id)`, corrupting them
  before they were ever written — **F-01 biting the test harness itself.** Any
  fixture generator in Phase 1 must splice big IDs in as text.
- A test asserted `SocksProxyAgent instanceof http.Agent`. It extends
  `agent-base`. Node accepts it structurally, so the code was right and the
  assertion was wrong.

### Stress results (offline, current build)

| Scenario                                                                                  | Result                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Parser vs 14 hostile inputs (truncated JSON, 2MB strings, 400-digit numbers, `__proto__`) | No crash, no prototype pollution                                                      |
| Redaction with 5,000 registered secrets                                                   | 0.108 ms/line — O(n) in secrets; fine now, worth a combined matcher if it becomes hot |
| 500 sequential write-backs                                                                | 0 failures, JSON valid throughout, SteamID and revocation code intact                 |
| Write-back to a read-only file                                                            | Fails safe, original untouched                                                        |
| Egress guard, 20,000 requests                                                             | Exact totals, detail capped, no unbounded growth                                      |
| Resolve 1 account among 400 (+1 corrupt)                                                  | 143 ms, corrupt file skipped                                                          |
| 5,000 maFile parses                                                                       | 0.33 ms each                                                                          |
| `mask()` × 5,000 random secrets                                                           | 0 leaks                                                                               |

**Note for Phase 1:** account resolution parses every maFile in the directory to
find one, loading all of their secrets into memory. Acceptable for a spike at
400 files; the vault must index by SteamID instead.

---

## F-15 — Defect review round 2 (external review of `src/` and `spike/src/`)

Every claim was reproduced with a probe before being fixed. All nine were real;
none were false positives.

### P1 — shipped-code security

| #   | Defect                                                                                                                                                                                                                                                                                      | Why it mattered                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Packaged navigation lock was ineffective.** `pathToFileURL(...).origin` is the string `"null"` for _every_ `file:` URL, so the packaged build compared `"null"` to `"null"` and permitted navigation to **any local file on the machine**. Remote URLs were blocked; local ones were not. | The lock existed and looked correct. Fixed by pinning to the exact file path; `isAllowedNavigation` is now a pure, directly-tested predicate. |
| 2   | **Second instance kept running after a failed lock.** `app.quit()` does not stop the current tick, and startup continued into `whenReady()`, registering IPC handlers and creating a window.                                                                                                | §10.3's atomic vault writes assume a single writer. Fixed with an early return.                                                               |

### P2 — spike defects

| #   | Defect                                                                   | Note                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3   | Failed time sync cached `0` **forever**                                  | One transient blip permanently disabled clock correction; a skewed machine would emit wrong codes for the rest of the process, warning once. Failures are no longer cached, and concurrent first calls now coalesce.                                                                     |
| 4   | Undecodable refresh token warned "ignoring it" then kept it              | Callers saw a token, took the expired path, and got a misleading failure instead of going straight to a password login.                                                                                                                                                                  |
| 5   | **Write-back regex was file-global, not `Session`-scoped**               | Reproduced: with a decoy top-level `"RefreshToken"`, the write landed on the decoy, `Session` stayed stale, and it reported `written` — because verification read the same wrong key. Now brace-matched to the `Session` span, string-aware.                                             |
| 6   | Abandoned `authenticated` promise on the F-07 path                       | A later `error`/`timeout` became an unhandled rejection that buried the real error.                                                                                                                                                                                                      |
| 7   | **Revocation codes bypassed redaction**                                  | `R#####` is 6 characters, below the 8-char floor, and was never registered at all. It is the one secret whose loss is unrecoverable. `registerSecret` now takes `{ force }` with a hard floor of 4.                                                                                      |
| 8   | `--help` claimed "never writes secrets to disk" after write-back shipped | Users trusting the help text could run without a backup.                                                                                                                                                                                                                                 |
| 9   | Branding guard missed `appId`                                            | It checks for `[PRODUCT_NAME]`, which a valid reverse-DNS id cannot contain — so filling the display fields would report branding resolved while a placeholder app id shipped. A comment also claimed `tests/branding.test.ts` gated releases; **that file did not exist**. It does now. |

### Also fixed

- `shared/security-policy.ts` used `process.platform`, but `shared/` is compiled
  for the **renderer** too, where `process` does not exist. Caught by the web
  typecheck. Platform behaviour is now a caller-supplied parameter —
  **anything in `shared/` must stay environment-agnostic.**
- Empty `Session: {}` insert emitted a trailing comma, producing invalid JSON, so
  such files could never be written and prompted for a password every run.
- Password prompt depends on the private readline `_writeToOutput` hook. If a
  Node upgrade removes it the failure mode is **echoing the password to screen**,
  so it now refuses outright instead.
- `loginSessionOptions` was `Record<string, unknown>`; a mistyped key would have
  been silently ignored and connected direct. Now typed.

Coverage after this round: **40 app tests** (was 26) and **73 spike tests**
(was 64), plus 12 stress scenarios and 5 integration checks, all green.

---

## F-16 — Full re-validation round 3 (line-by-line, app + spike)

Seven issues, all in code I wrote. Two would have leaked secrets.

### Secrets hygiene — the two that mattered

| #   | Issue                                                                                                                                                                                                                                                                                                                                                       | Why it was easy to miss                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **`.gitignore` did not cover write-back artifacts.** `*.maFile` does not match `*.maFile.bak` — the pattern requires the name to _end_ with `.maFile`. Token write-back keeps a `.bak` beside every maFile containing the **same shared_secret, identity_secret and revocation_code**, and writes a `.tmp` during the atomic rename. Both were committable. | The ignore rules were written and verified _before_ write-back existed, and adding write-back never revisited them. Verified fixed with `git check-ignore` against all four filenames.                                                         |
| 2   | **A real revocation code was used as test data.** The live code from a founder account (`R#####`, value deliberately not repeated here) was hardcoded in `spike/tests/redact.test.ts` while adding the forced-registration test, in a committed file.                                                                                                       | Reaching for a "realistic" value from the terminal scrollback. A revocation code cannot be rotated without removing the authenticator entirely, which makes it the worst possible thing to hardcode. Now synthetic, with a comment saying why. |

### Electron hardening gaps

| #   | Issue                                                                                                                                                                       | Impact                                                                                                                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3   | **DevTools reachable in packaged builds.** `autoHideMenuBar` only hides the bar — Electron's default menu still carries a Toggle Developer Tools accelerator, and it works. | "Open the console and paste this to fix your codes" is a scam that works on real people, and pasted script gets everything `window.api` exposes. Harmless today; from 0.1 that is the vault. Fixed with `devTools: false` in the frozen prefs (dev re-enables explicitly) plus `Menu.setApplicationMenu(null)` when packaged. |
| 4   | **IPC answered any WebContents in the process.** `ipcMain.handle` is not scoped to a window.                                                                                | Anything that ever gets its own renderer could call every channel. Now every request checks `event.senderFrame.url` against the **same predicate as the navigation lock**, so the definition of "us" cannot drift between the two. Fails closed: the default sender predicate denies everything.                              |
| 5   | **Only windows we constructed were hardened.** No `web-contents-created` hook, so a WebContents created by anything else inherited no navigation lock.                      | Per-window hardening is easy to forget once, and once is enough. Now applied process-wide.                                                                                                                                                                                                                                    |
| 6   | **`will-navigate` covers only the top frame.** No `will-frame-navigate`.                                                                                                    | Low risk today (`frame-src 'none'`), but defence in depth is the point of having the rule at all.                                                                                                                                                                                                                             |

### Robustness

| #   | Issue                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7   | **A missing preload bridge white-screened the app.** `window.api` was typed as always-present, so `window.api.getAppInfo()` threw _synchronously_ inside `useEffect` — which no `.catch()` can see. This is the exact failure mode of the sandboxed-preload bug from Phase 1, and the UI's response to it was a blank window. Now typed optional, detected at mount, and reported with a message naming the likely cause. |

Also: the `platform` field was an enum of supported platforms, so running anywhere else failed **response** validation and turned "unsupported platform" into a hard IPC error on the About screen. It is display-only; now a plain string.

### Missed deliverable

`CHANGELOG.md` did not exist, despite §19's per-milestone DoD requiring an entry and both `RELEASE_CHECKLIST.md` and `MAINTENANCE.md` referencing one. Added.

Correctly deferred, not missed: `release.yml` (0.2, with signing), `canary.yml` (0.1), `verify-*.md` (need a signing identity to be meaningful), `build/` and electron-builder (packaging is not a Phase 1 deliverable).

### Verification performed

- **Both run modes launched**, not just one: `electron-vite dev` and `preview`. Dev mode had never been run before this round — it exercises a different CSP, a different navigation target, and a different sender URL, any of which the sender check could have broken.
- Full CI replay on both packages, stress harness 12/12, integration harness 5/5, 23 doc links, and a full-tree sweep for live account material.
- Coverage: **53 app tests** (was 46), **78 spike tests**.

---

## F-17 — Review round 4 (external, line-by-line)

Ten claims. **Nine reproduced and fixed; one was already fixed** and the reviewer
was reading a stale snapshot.

### P1 — `file:` host was ignored, and that predicate backs IPC trust

`isAllowedNavigation` compared **pathname only**. Every one of these matched:

```
file:///H:/app/out/renderer/index.html          allowed (correct)
file://evil.com/H:/app/out/renderer/index.html  allowed  <-- BUG
file://127.0.0.1/H:/app/out/renderer/index.html allowed  <-- BUG
```

A `file:` URL with a host is a **UNC path** — a document served from a remote SMB
share. On Windows that is fully reachable.

The severity is compounded by round 3: the same predicate now also backs the IPC
sender check. So a remote-share document with a matching path would have passed
**both** the navigation lock and IPC trust, and been allowed to call every
channel.

Fixed by requiring an empty host on both the candidate and the target.
`pathToFileURL` always produces one, so anything else is refused.

**Nuance worth recording:** `file://localhost/...` is still accepted, and that is
correct. The URL spec normalises a literal `localhost` host on `file:` URLs to
empty, so it denotes the identical local file. A numeric `127.0.0.1` is _not_
normalised and stays rejected. My first test asserted localhost should fail — the
assertion was wrong, not the code.

### P2 — write-back reported success while consumers saw stale data

Two independent ways the same lie could be told, both reproduced:

| Case                                         | What happened                                                                                                                                                                                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Non-string value** — `"RefreshToken": 123` | The replace regex matched quoted values only, so it fell through to the _insert_ branch and produced a **second** key. Verification read the first (our new string) and reported `written`; `JSON.parse` resolves duplicates to the **last** and still returned `123`. |
| **Duplicate `Session` objects**              | We edited the first; `JSON.parse` reads the last. Write reported `written` against an object nobody reads.                                                                                                                                                             |

Fixed: the replace pattern now matches any JSON primitive, a key holding an
object/array is refused rather than mangled, and a document containing more than
one `Session` object is refused outright — guessing which one the user meant is
not something a writer of irreplaceable secrets should do.

### P2 — SteamID read from the wrong place and mislabelled

`extractSteamId64` searched the whole document for `"SteamID"`. A file with a
top-level key yielded **that** value while still reporting
`steamIdSource: 'Session.SteamID'` — wrong ID, wrong label, no warning.

Root cause is the same text-scoping mistake as the write-back bugs, so the fix is
shared: `spike/src/jsonspan.ts` now owns Session-object location for both the
parser and the writer.

### P2 — redaction gaps

| Gap                                | Detail                                                                                                                                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Env-var password                   | Registered without `force`, so anything under 8 characters was never scrubbed. Only the _prompted_ path had been fixed in round 3.                                                                                                                       |
| Proxy password                     | Same. A 7-character proxy password appeared in cleartext.                                                                                                                                                                                                |
| **Percent-encoded proxy password** | `URL.password` returns the value still encoded — `p%40sswordX` for `p@sswordX`. Only the encoded form was registered, so the decoded form, which is what a library or error message actually prints, leaked. Both are now registered, plus the username. |

### P2 — docs contradicting the code

`login.ts`, `cli.ts` USAGE, and a `session.ts` comment still said the tool prints
a masked token and writes nothing, after write-back shipped. One paragraph
managed to state that tokens are written back _and_ that nothing is written to
disk. Corrected to the accurate, weaker claim: the only file written is one the
user pointed us at, which already holds the same secrets.

### P3 — also fixed

- **Double navigation lock.** `hardenAllWebContents` and the per-window
  `hardenWindow` both attached every listener. Harmless in effect, but ambiguity
  about which code enforces a security rule is how the rule gets deleted by
  someone tidying up. Now applied in exactly one place.
- **No `will-redirect` handler.** `will-navigate` fires for the original URL; a
  302 can then land somewhere else entirely.
- **Undecodable `AccessToken` was retained**, mirroring the refresh-token fix.

### Not a bug

The platform-schema claim (#2) was already resolved — the assertion reads
`toBe(true)` and the suite passes. Worth noting that a review against a stale
tree produces confident, specific, wrong claims; reproducing before fixing is
what caught it.

### Self-inflicted, again

Rewriting a file via PowerShell `Get-Content`/`Set-Content` re-introduced the
UTF-8 → CP1252 mojibake from F-14, in three lines of `writeback.ts`. **Never
round-trip source files through PowerShell string handling** — use the editor
tools. A scanner now checks the whole tree for it.

Coverage after this round: **55 app tests**, **84 spike tests**, both launch
modes verified, stress 12/12, integration 5/5.

---

## F-18 — Review round 5

Five claims, all reproduced. No P0/P1 remained; these were the last of the
text-scoping family plus one piece of forward-looking hardening.

### The rule that was missing

Rounds 3 and 4 fixed duplicate **Session objects** and non-string values, but the
underlying rule was never stated, so the same defect kept reappearing one level
down. It is now explicit and applied everywhere:

> **Any ambiguity about which value `JSON.parse` will resolve to means we do not
> write.**

| #   | Case                                                 | Before                                                                                                                                                                        | Now                                                                     |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | Duplicate `RefreshToken` keys **inside one Session** | `String.replace` rewrote the FIRST, `JSON.parse` read the LAST. Reported `written` against a value nobody reads.                                                              | Refused.                                                                |
| 2   | Duplicate `Session` objects at **parse** time        | Writer refused the file; parser skipped SteamID extraction but still took tokens from the last Session, with no warning. Parser and writer disagreed about the same document. | Reader and writer now have deliberately different, documented policies. |

**Read permissively, write conservatively.** `findLastSessionSpan` is used for
reading, because `JSON.parse` — and therefore every other tool in the ecosystem,
including our own zod parse of the same bytes — resolves duplicates to the last.
A reader that used the first would disagree with itself. `findSessionSpan`
(exactly-one) is used for writing, because writing into ambiguity is how a maFile
gets quietly corrupted. Parsing a duplicate-Session file now warns explicitly.

### Also fixed

- **Expired refresh tokens are no longer kept.** Every caller re-checked the
  expiry and fell back anyway, so carrying one achieved nothing but keeping a
  stale credential in memory and routing every run through the "expired, falling
  back" branch. The parse-time warning already explains it.
- **`shell.openExternal` now uses a host allowlist** (Steam, Valve, GitHub;
  subdomains yes, suffix-confusion no). Harmless today, because the renderer shows
  only our own content — but from milestone 0.1 it renders **attacker-influenced
  text**: item names, counterparties, confirmation descriptions. A crafted link
  there should not be able to send someone anywhere via a click that looks like it
  came from their authenticator.
- Orphaned JWT `exp` docblock stranded above `jwtAudience` after an earlier edit.

### A test I had to correct rather than the code

Dropping expired tokens broke a test asserting the opposite — it used a
deliberately-expired fixture and expected the token retained. Updated to the new
intent, **and its missing counterpart added**: a fixture with a live token
(expiry in 2100, so it never goes stale) proving live tokens are still kept.
Without that, dropping _every_ token would have looked like correct behaviour.

### Carried forward, deliberately

- `accounts.ts` parses every `.maFile` in a directory to resolve one name,
  registering all their secrets. Acceptable in a throwaway CLI at 400 files;
  the vault indexes by SteamID instead.
- `.bak` is a single generation, by design — it is the last known-good version,
  not a history.

Coverage: **110 app tests**, **87 spike tests**.

---

## F-19 — Review round 6 (audit of the new feature work)

Seven claims. **Six reproduced and fixed; one was not reachable.**

### The same root cause, one level deeper again

Rounds 3–5 scoped key matching to the `Session` **body**. That was still not
enough: it was not scoped to the object's **direct members**. Three of the six
findings were the same mistake at a new depth.

| #   | Case                                                                    | Before                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Duplicate `RefreshToken` where the **first already held the new value** | `currentValue` read the first, saw a match, and returned **`unchanged`** — while `JSON.parse` resolved to the stale second. The write never happened _and_ the caller was told nothing needed doing. Worse than the round-5 case, which at least reported `skipped`. |
| 2   | `Session.meta.RefreshToken`                                             | Counted and rewritten as if it were `Session.RefreshToken`. Reported `written`; the real key stayed absent.                                                                                                                                                          |
| 4   | Duplicate `SteamID` inside one Session                                  | Parser took the first, `JSON.parse` the last — violating the reader policy round 5 introduced.                                                                                                                                                                       |

Fixed at the root: `jsonspan.ts` now has a real member scanner
(`topLevelMembers` / `membersNamed`) that walks an object body tracking depth and
string state, returning each **direct** member's value span. Write-back and the
parser both use it, so scope and depth are decided in one place instead of by
three regexes.

`persistTokens` also consults ambiguity **before** deciding a file is unchanged —
that ordering is what made #1 silent rather than merely wrong.

### Redaction and matching

- **#3** `URL.username` is percent-encoded exactly like `URL.password`. Round 5
  fixed the password and left the username: `user@name` leaked for
  `user%40name`. Both now go through one `registerBothForms` helper, so the next
  credential field cannot be half-fixed.
- **#7** Bypass-host matching was case-sensitive. `bypassHosts` comes from
  `URL.hostname` (always lower-case) but a caller may pass `options.hostname` in
  any case — a missed bypass is the HTTP-proxy recursion the bypass exists to
  prevent. Lower-cased on both sides.
- **#5** Access-token retention now matches the refresh-token policy: decodable
  **and** unexpired.

### Not reachable — #6

The claim was that clearing `timeOffsetInFlight` before setting
`cachedTimeOffset` lets a concurrent caller start a second time request. There is
no `await` or yield between those two statements, and JavaScript is
single-threaded, so nothing can run in that window. Reordered anyway so the
invariant is self-evident rather than something a reader has to derive — but it
was not a defect.

Worth noting as a pattern: an audit that reasons about interleaving needs to
check for an actual suspension point, or it reports races that cannot occur.

### The incident report contained the incident

The F-16 write-up documented the leaked revocation code **by quoting it** — so
removing it from the test file and then describing what had happened put the same
live value straight back into another committed file. The sweep that found it the
first time found it again.

Redacted, and worth stating as a rule: **an incident report about a leaked secret
must not contain the secret.** Describe the shape (`R#####`), never the value.
This is the third distinct place that one code reached, which is exactly why a
revocation code is the worst thing to reach for when you want a realistic test
value.

Coverage: **141 app tests**, **93 spike tests**, stress 12/12, integration 5/5.

---

## Open items this raises for §23

| #       | Question                                                                                                                      | Owner                                      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Q9      | How does `/security` present a 120-package production tree? (F-05)                                                            | Founder                                    |
| Q10     | Does §10.4's `device_id` wording get corrected to match F-02?                                                                 | Claude Code proposes, founder confirms     |
| Q11     | Proxy support: public framing, and does it get a §1 decision entry? (F-08)                                                    | Founder                                    |
| Q12     | Do proxy URLs (with credentials) live in the vault? That is a §10.3 schema change.                                            | Founder                                    |
| Q13     | Approve `socks-proxy-agent`, `request`, `@doctormckay/stdlib` as direct deps per §9.4.2                                       | Founder                                    |
| Q14     | Per-account proxy concurrency: worker-per-account, or own the last mile? (F-08)                                               | Claude Code proposes (b), founder confirms |
| Q15     | Does authenticator removal enter v1 scope, and with what re-auth gate? (F-09)                                                 | Founder                                    |
| ~~Q16~~ | **Answered 2026-08-10: yes.** Phone-free activation works; the code arrives by email. See F-10.                               | Settled by live run                        |
| Q17     | Adopt proposed invariant S16 (auto-confirm type allowlist) into §11? (F-12)                                                   | Founder — **recommend yes**                |
| Q18     | Should account-security confirmations (type 6) raise an in-app security alert? (F-12)                                         | Founder                                    |
| Q19     | **Before 0.1:** how do we ship confirmations without 2 critical + 6 high advisories in the production tree? (F-05 escalation) | Founder                                    |
