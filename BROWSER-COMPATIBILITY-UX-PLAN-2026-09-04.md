# Browser compatibility, Windows identity, and account-row UX plan

Status: implementation approved by the user on 2026-09-04.

This plan is deliberately fixed before implementation. Each phase has a
separate cause, an invariant, and a test boundary so a change in one area does
not become an improvised rewrite of another.

## Confirmed findings

### 1. The account browser is not automated, but it overrides its identity

The visible account browser is an Electron `BaseWindow` containing ordinary
`WebContentsView` tabs. The product has no Puppeteer, Playwright, WebDriver,
remote-debugging, `--enable-automation`, `AutomationControlled`, or
`navigator.webdriver` override on this path. The user's clicks are real user
input.

Every tab nevertheless calls `setUserAgent()` with a hand-built Chrome-only
string. Master Bridge does not do that to its visible browser: it starts an
installed Chrome process normally, with no CDP/WebDriver connection. A
Chrome-only user-agent attached to an embedded Electron environment creates an
internally inconsistent browser identity. Cloudflare's current compatibility
guidance tells embedded-browser integrators to keep the default user agent and
stable browser characteristics; it does not recommend pretending the embed is
Chrome.

Fix: remove the product user-agent override from both the account session and
every tab. Let the running engine produce one consistent HTTP and JavaScript
identity. Do not add stealth scripts, spoof `navigator.webdriver`, alter
Canvas/WebGL, or automate a challenge.

Acceptance:

- a real Electron probe records `navigator.webdriver === false`;
- the launch command line contains no automation or remote-debugging switch;
- the request header and `navigator.userAgent` agree and use Electron's native
  value rather than a separately maintained constant;
- initial tabs and popup-adopted tabs receive no identity override.

### 2. Steam-only routing splits a challenge across two IP addresses

`steamOnlyBypass()` sends `csgoempire.com` and its subdomains direct, but sends
`challenges.cloudflare.com` through the account proxy. The screenshot also
shows CSGOEmpire asking for Google reCAPTCHA, whose documented runtime origins
include `www.google.com`, `www.gstatic.com`, and `recaptcha.google.com`; those
currently take the proxy too. The challenged page and the service solving its
challenge therefore see different egress routes.

Master Bridge explicitly routes `challenges.cloudflare.com` with the supported
third-party site. Cloudflare documents a challenge request and solve arriving
from different IPs as invalid and a cause of challenge loops.

Fix: keep the leak-safe proxy default, but add a separate, exact-host challenge
support list to the Steam-only bypass. It will contain Cloudflare Turnstile and
the documented Google reCAPTCHA runtime hosts. Exact hosts avoid making all of
`google.com` or `gstatic.com` direct. Trade sites remain the only suffix/wildcard
entries. Fully proxied and Direct modes do not change.

Acceptance:

- CSGOEmpire and each challenge support host resolve `DIRECT` in Steam-only;
- Steam, unknown hosts, lookalikes, and sibling Google hosts still resolve to
  the account proxy;
- real Electron traffic reaches a local direct endpoint for the site and
  challenge fixtures while the proxy observes neither;
- fully proxied mode sends both through the proxy, so the strict-proxy promise
  remains absolute.

### 3. Opening Trade creates a second Windows taskbar window without a stable
per-window identity

Both the main `BrowserWindow` and account `BaseWindow` have the correct native
image. In a normal development run the global AppUserModelID is deliberately
not claimed. With one window Windows can show the supplied icon; after Trade
creates the second top-level Electron window, Windows groups them under the
owning `electron.exe` process and the group falls back to Electron's icon. The
recent one-window test did not exercise this transition.

Fix: apply the same Windows `setAppDetails` data to both top-level window types
before either is shown. Use the product AppUserModelID and an absolute product
icon path; keep global toast identity policy separate.

Acceptance:

- main and account window fakes receive identical app details exactly once;
- non-Windows behavior is unchanged;
- a Windows Electron harness creates both window types and verifies the
  application did not omit either taskbar identity assignment.

### 4. Clipboard expiry feedback is in the account identity column

The expiry sentence is rendered under account name and SteamID, several inches
from the Copy control that caused it. The button already changes to `Copied`.

Fix: move a compact polite live status beside Copy, use the existing deadline,
and bind the active button to it with `aria-describedby`. Keep failures visible
and keep the clipboard clearing behavior unchanged.

Acceptance: rendered markup places the status inside the action group next to
Copy, announces it politely, names the remaining seconds, and removes it when
the existing timer expires.

### 5. The browser launcher looks and reads like a minor one-shot action

The visible label is `Trade` / `Trade (proxied)`, although it opens a full
isolated, signed-in, multi-tab browser. Account-row CSS deliberately makes every
action except Copy transparent and muted.

Fix: label the primary route `Open trading browser`, use `Opening browser...`
while pending, and give it a dedicated restrained primary treatment. Keep
Steam-only and Direct as secondary routing alternatives and preserve every
main-process routing rule.

Acceptance: the label describes a browser rather than implying an automatic
trade; the main launcher is visually distinct; route alternatives and Require
proxies behavior are unchanged.

## Commit and regression strategy

1. Commit this plan before product edits.
2. Commit browser identity/routing code, real-Electron coverage, and its
   changelog entry as one coherent change.
3. Commit Windows taskbar identity code and coverage separately.
4. Commit the account-row copy/browser presentation and accessibility coverage
   separately.
5. Run formatting, lint, both typechecks, focused suites, the entire test suite,
   build, real-Electron browser smoke, and browser stress on the final commit.
6. If the user's real test-account challenge still fails, treat that as evidence
   for the separately scoped normal-Chrome architecture used by Master Bridge.
   Do not respond by adding fingerprint-evasion code. A normal-Chrome mode must
   preserve per-account isolation, strict proxy fail-closed behavior, profile
   cleanup on lock, and a visible session with no automation/CDP connection.

## Explicit non-fixes

- No CAPTCHA will be solved automatically.
- No anti-bot signal will be hidden or forged.
- The account browser's storage will still be wiped on close and lock. Keeping
  third-party clearance cookies across a vault lock would trade compatibility
  for a live session surviving a security boundary.
- A bad-reputation proxy can still be challenged. The fully proxied route will
  not silently fall back to the machine's connection; the user must deliberately
  choose Steam-only or Direct when vault policy permits it.
