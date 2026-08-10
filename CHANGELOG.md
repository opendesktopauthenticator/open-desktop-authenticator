# Changelog

Notable changes to this project. Written for users, not from commit subjects.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

When a release fixes a Valve-side breakage, its entry also carries a short
public post-mortem — what broke, when we detected it, and what we changed.

## [Unreleased]

Pre-release. Nothing has shipped; there is no version to install.

### Added

- Application shell: Electron main process, sandboxed preload bridge, React
  renderer.
- Security posture wired from the first commit rather than retrofitted —
  `sandbox`, `contextIsolation`, no Node in the renderer, strict packaged CSP
  with `connect-src 'none'`, all permissions denied, DevTools disabled in
  packaged builds, navigation pinned to the bundled entry point.
- IPC contract: every channel declared once with zod schemas, validated at the
  main-process boundary, answering only our own renderer.
- CI on Windows and Linux: lint, formatting, typecheck, build, tests, and a
  dependency audit. Dependabot with grouped PRs and no auto-merge.
- Governance documents: threat model, security policy, maintenance commitments,
  contributing guide, architecture notes, release checklist.
- `/spike` — the Phase 0 CLI used to validate Steam's protocol behaviour against
  live accounts. Reference code; never shipped.

- Vault foundations (milestone 0.1, F1): the encrypted file format, scrypt +
  AES-256-GCM sealing with the envelope header bound as authenticated data,
  atomic writes with a verified backup, and the account/settings schema.
  SteamID64 is a string end to end so it cannot be silently corrupted.
- `npm run benchmark:kdf` — measures scrypt cost so the work factor can be
  chosen on the hardware users actually have.
- Vault session lifecycle: create, unlock, lock, save, change passphrase, and
  idle auto-lock. Saves re-use the key derived at unlock, so the passphrase is in
  memory only around an unlock and a save costs no key derivation.
- Vault IPC surface and the create / unlock / locked-home screens, including the
  "there is no recovery" ceremony. The renderer is reloaded whenever the vault
  locks, so a passphrase is never typed into a page that has previously rendered
  Steam content. Locks on suspend and on the OS lock screen.
- Revealing a revocation code requires the passphrase again — being unlocked is
  not enough, and it is one code at a time with no bulk variant.
- maFile import (milestone 0.1, F2). Files are read by the main process only —
  the app never accepts a path from its own interface — and every file is
  described before anything is written: what it was missing, where its SteamID
  came from, and whether it would overwrite an account you already have.
  Re-importing an account merges rather than overwrites, so a file that has had
  its revocation code stripped cannot delete the copy the vault is holding.
  Stored session tokens are kept only when they are actually usable, which
  includes being scoped for the mobile app rather than the website.
- Steam Guard codes (milestone 0.1, F4), with a live countdown and one-click
  copy. The clipboard is wiped after your configured delay — but only if the code
  is still what is on it, so copying something else in the meantime is never
  destroyed. Codes are also wiped from the clipboard when the vault locks and
  when the app quits. Note that no application can reach Windows Clipboard
  History (`Win`+`V`) or cloud clipboard sync; if you use those, assume copied
  codes are in them. See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
- Code generation is written out in this repository rather than taken from a
  dependency, so the most security-critical computation in the product is twenty
  auditable lines. It is checked against `steam-totp` across tens of thousands of
  time windows on every push.
- Confirmations (milestone 0.1, F5): the signing, the wire protocol, and the
  rule about what may ever be approved automatically. **Account-recovery
  confirmations are never auto-approved** — they arrive on the same channel as
  trades, and approving one hands over the account. Nor is any confirmation type
  we do not recognise, so a new Steam feature makes this app more cautious rather
  than less.
- A proxy stored inside an imported maFile is **never adopted unless you tick a
  box saying so.** maFiles written by trading tools routinely carry a proxy the
  owner stopped paying for long ago, and because routing fails closed on purpose,
  inheriting a dead one silently means the account cannot reach Steam at all.
  Declining leaves any routing you set in the app alone — it is not a way to
  switch routing off.
- Signing in is handled by **`steam-session`**, DoctorMcKay's library, rather
  than by our own implementation of Steam's authentication protocol. It is the
  flow the rest of the Steam ecosystem uses and it is maintained by someone who
  tracks Valve's changes; writing our own bought nothing and cost a proxy bug.
  The Steam Guard code is still generated here, offline, and the session Steam
  returns is still checked to be mobile-scoped before it is stored.
- **Proxies that require a username and password now work at all.** The
  credentials were being handed to an Electron event that does not exist, so they
  were never sent: every authenticating proxy failed before reaching Steam, with
  an error indistinguishable from a wrong password. They are now supplied on the
  request itself, and only ever to the proxy — never to whatever is at the other
  end of the connection.
- Network failures are now explained rather than passed through as Chromium's
  internal error codes, and a failure on a routed account **names the proxy**.
  `net::ERR_TUNNEL_CONNECTION_FAILED` told you nothing, least of all that a proxy
  was involved at all. The code is still included so it stays searchable.
- **Routing is now verified, not assumed, and the account list says which.**
  Before every request on a routed account, the app asks Chromium what it will
  actually do with that connection and refuses to send unless the answer names
  the proxy you configured. A proxy that is configured but bypassed, or that
  falls back to a direct connection, or that has been replaced by a stale one, is
  caught and the account stops rather than connecting from your own address.
  The card shows `routed · verified` only once that check has passed —
  `routed · unverified` means a proxy is set but nothing has connected through it
  yet, and `ROUTING FAILED` means the account is refusing to connect and why. A
  label that turned green because a field was filled in was a claim about
  anonymity the app had not earned.
- Per-account network routing, **entirely optional**. An account with no proxy
  connects the way everything else on your machine does, and no feature is
  withheld from it. An account with one gets its own connection and its own
  cookies — HTTP, HTTPS or SOCKS5 — so two accounts can never share an address or
  a session. Routing can be added, replaced or switched off per account at any
  time, including a proxy that arrived inside an imported maFile. If a proxy is
  configured and cannot be used, that account makes **no** connection at all
  rather than quietly falling back to yours. Requests carry an ordinary mobile
  browser identity rather than announcing this application.
- Accounts imported with a live mobile session can reach Steam without ever being
  asked for a password. When that session finally runs out, the app says so
  plainly instead of just failing.
- Automatic confirmation, off by default and per account. Trades and market
  listings are separate switches because they are not the same risk, and the
  screen says what a wrongly-approved trade costs. **Account recovery and
  phone-number confirmations are never approved automatically**, whatever is
  switched on — that is a rule in the code, not a setting. Nothing is polled for
  an account with neither switch on, and everything stops while the vault is
  locked.
- An activity record of what automatic confirmation did while you were away, and
  an alert on the account list when it held something back for your safety —
  because a refused account-recovery confirmation means somebody may be taking
  the account, and that must not be something you have to go looking for. Kept in
  memory for the session only; nothing about your trading is written to disk.
- A tray icon. Closing the window now hides it rather than quitting, because an
  authenticator that stops when you close a window stops producing codes. Quit is
  in the tray menu and spelled out, so it cannot be confused with closing.
- On Windows the application now registers its own identity with the shell, so it
  can be pinned to the taskbar and groups as itself rather than as a generic
  Electron application.
- Settings: the auto-lock timeout and how long a copied code stays on the
  clipboard. Both were fixed at their defaults with no way to reach them, and the
  first matters — someone who finds ten minutes too short needs somewhere to go
  other than giving up on locking. Options the vault format carries but nothing
  implements yet are deliberately absent rather than shown as switches that do
  nothing.
- Removing an account from the vault. It asks for your passphrase, and it says
  plainly what it does not do: **it does not remove the authenticator from
  Steam.** Steam will keep asking that account for codes this app can no longer
  produce, so the screen tells you whether a revocation code exists before you
  commit — and says so in stronger terms when there is not one.
- Viewing and answering confirmations. Trades and market listings can be approved
  or denied individually or together; anything touching account security — a
  recovery request, a phone-number change — is shown separately, above
  everything else, with a plain warning and no way to sweep it up in a bulk
  approval.

### Notes

- **Platforms: Windows and Linux.** macOS is deferred — signing it needs Apple
  Developer enrollment as an organization, which we have not completed, and we
  will not ship an unsigned macOS build.
- The product is named **Open Desktop Authenticator**, at
  `opendesktopauthenticator.com`, with source at
  `github.com/opendesktopauthenticator/open-desktop-authenticator`.
- **Nothing here has been verified against live Steam end to end.** The protocol
  work was validated in Phase 0, but the assembled application has not been run
  against a real account through sign-in, confirmations and routing. Treat this
  as unproven until a release says otherwise.
