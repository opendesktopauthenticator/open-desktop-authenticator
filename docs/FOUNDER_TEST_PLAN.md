# Founder test plan — what has to be checked by a human

**Status: worked through.** This plan was written when the assembled application
had never spoken to live Steam. It since has, across several rounds against real
accounts, and the plan is kept here as the record of what was covered and as the
checklist to repeat before a release.

Automated tests prove the code does what it was written to do; they cannot prove
it was written against Steam's actual behaviour. That is what these are for, and
it is why the list matters more than its pass marks — it should be run again
against each release candidate, not treated as done once.

## What that testing found

Working through it was not a formality. It surfaced defects the whole automated
suite had missed, because they only exist when a real person uses the thing:

- **A removed account came back after restoring a backup.** The backup predated
  the removal, so restoring reinstated it — correct behaviour, described nowhere,
  and alarming when it is your account. Now stated on the restore screen in both
  directions.
- **The vault-adoption error was unreachable**, rendered sixty lines below the
  button that produced it, so "Load a vault file" looked broken.
- **A session that should have been remembered was asking again**, and several
  smaller interface faults around spacing and stuck states.

Each is fixed and carries a regression test.

## What this is not

Maintainer testing, not independent review. No third party has audited this
application, and this document should not be read as though one has. T19 was
skipped by agreement rather than passed.

---

## Before you start

**Use a throwaway Steam account for T7 onwards.** Not your main. Several of these
tests move an authenticator, approve real trades, or remove an account from the
vault, and getting one wrong on an account you care about means Steam Support and
a wait. A fresh account with a phone number attached and a few cents of inventory
is enough for everything here.

Have ready:

| Thing                                | Needed for      |
| ------------------------------------ | --------------- |
| A throwaway Steam account            | T7 onwards      |
| Its password                         | T7, T8          |
| Its phone (for the SMS/email code)   | T7              |
| An existing SDA maFile               | T5              |
| The official Steam mobile app        | T6 (comparison) |
| One working proxy (HTTP or SOCKS5)   | T15–T18         |
| A second Steam account to trade with | T12, T21        |

I cannot run any of these. Signing in requires typing a password, which I do not
do under any circumstances — you run every step in this document yourself.

Mark each row as you go. Anything that fails, paste back verbatim: the screen,
the message, and what you did immediately before.

---

## Stage 1 — No Steam account involved

Nothing here can damage an account. Do these first; a failure means stop, because
everything after depends on them.

### T1 · Vault creation and the no-recovery ceremony

1. `npm run dev` on a machine with no existing vault.
2. Create a vault. Try to submit without ticking the acknowledgement.
3. Try a passphrase that does not match its confirmation.
4. Create it properly, then quit and relaunch.

**Pass:** submit stays disabled until both the acknowledgement is ticked and the
passphrases match. After relaunch you get the unlock screen, not the create
screen. **Fails if** the vault file is written before you acknowledge, or a
relaunch offers to create a second vault over the first.

### T2 · Unlock, wrong passphrase, lock

1. Unlock with the wrong passphrase three times.
2. Unlock correctly.
3. Use **Lock now** from the tray.

**Pass:** a wrong passphrase says so and reveals nothing about the vault's
contents. Locking returns you to the unlock screen and the window is visibly
reloaded — no account data left rendered behind the lock screen.

### T3 · Idle auto-lock and OS lock

1. Settings → set **Lock the vault after** to 1 minute. Leave the app alone.
2. Unlock again, then lock your Windows session (`Win`+`L`) and come back.
3. Unlock again, suspend the machine, wake it.

**Pass:** all three lock the vault. This one is easy to skip and it is the
difference between a stolen laptop being a problem and being a catastrophe.

### T4 · Settings persist

1. Change both settings to non-default values. Quit fully (tray → Quit ODA).
2. Relaunch and unlock.

**Pass:** both values survive. **Fails if** either resets — that means settings
are being written to a vault that is not being saved.

### T5 · Import a real maFile

This is the first test using real material. Import a maFile for an account you
control, **on a copy** — never point the app at your only copy of a maFile.

1. Import it. Read the description screen before confirming.
2. Import the same file a second time.
3. Import a file you have deliberately stripped the revocation code from.
4. Import one that carries a proxy — the row shows a `routed` flag.

**Pass:** the description screen names the correct account, and the SteamID it
shows is the right one for that file. The second import merges rather than
duplicating. The stripped file does **not** delete the revocation code the vault
already holds. The file carrying a proxy shows an **unticked** "Also route this
account through the proxy saved in the file", and leaving it alone imports the
account with routing **off** — check the account list shows `not routed`.

> **This is where the first live-testing failure came from.** Version one adopted
> the maFile's proxy automatically. The founder's files came from a trading setup
> and carried proxies that had stopped working, so every account failed with
> `net::ERR_TUNNEL_CONNECTION_FAILED` before reaching Steam — correct behaviour
> from a feature nobody had asked for. Now it is a tickbox, off by default.

> The SteamID check matters more than it looks. A maFile with a `steamid` at the
> top level as well as inside its session block used to import under a different
> account's ID entirely. That is fixed and tested — but tested against synthetic
> files I wrote. Your real file is the first one from the actual SDA that this
> code has ever read.

### T6 · Codes match the official app — **the single most important test here**

Side by side with the official Steam mobile app on the same account:

1. Compare the code. Wait for it to roll over. Compare again.
2. Do this for at least four consecutive codes.
3. Repeat on a machine whose clock you have deliberately set 40 seconds fast.

**Pass:** identical codes every time, rolling over at the same moment. On the
skewed machine, still identical — that is the clock-sync path doing its job, and
it is the reason step 3 is not optional.

**If codes differ:** stop and report it. Nothing downstream is meaningful.

---

## Stage 2 — Live Steam, read-only

Nothing here changes anything on your account.

### T7 · Sign in from the app

On an imported account, or a fresh one:

1. Sign in with username and password.
2. Answer the Steam Guard challenge when it comes.

**Pass:** sign-in completes and you land back on the account. **Fails if** it
hangs on the poll loop, or Steam emails you about a login from a browser you do
not recognise in a way that suggests the app is not identifying as the mobile
app.

**What this is really checking:** the session must be minted as
`platform_type=3` (mobile app). A web-scoped session looks completely valid,
logs in fine, and then silently cannot drive confirmations at all. If T7 passes
and T10 fails with an authorisation error, this is why.

### T8 · The password is not stored, and the session is

1. Sign in. Quit the app fully. Relaunch, unlock, open confirmations.

**Pass:** it does **not** ask for the password again. The refresh token is doing
its job.

2. Search the vault file for your password. It lives at
   `%APPDATA%\open-desktop-authenticator\vault.json`:

```bash
findstr /C:"your-password-here" "$env:APPDATA\open-desktop-authenticator\vault.json"
```

**Pass:** no match. (The file is encrypted, so this is a sanity check rather than
a proof — but a match would be catastrophic and instant to spot.) While you are
there, confirm `vault.json` looks like an encrypted blob and not readable JSON
fields.

### T9 · Access-token refresh

Leave the app running and unlocked for over an hour, then open confirmations.

**Pass:** confirmations load without a new sign-in. The access token expired and
was rebuilt from the refresh token without involving you.

### T10 · List confirmations

With a pending trade or market listing on the account:

1. Open Confirmations.

**Pass:** the pending items appear with the right descriptions. An account with
nothing pending says so plainly rather than erroring.

### T11 · Security-critical confirmations are separated

Trigger a phone-number-change confirmation on the throwaway (Steam → account
details → change phone number, then stop before completing).

**Pass:** it appears **above** everything else, visually separated, with a
warning, and there is no way to include it in a bulk approval.

---

## Stage 3 — Live Steam, state-changing

These do real things. Throwaway account.

### T12 · Approve a trade

1. Send a trade from the throwaway to your second account.
2. Approve the confirmation in ODA.

**Pass:** the trade completes. Check on Steam, not in ODA — ODA reporting
success is exactly what a broken implementation would also do.

### T13 · Deny a trade

Same setup, deny instead.

**Pass:** the trade is cancelled Steam-side.

### T14 · Bulk approve

Two or more pending trades, approve together.

**Pass:** all complete. **Fails if** one succeeds and the rest silently do not —
watch for a partial result being reported as a full one.

---

## Stage 4 — Proxy routing

Skip this entire stage if you will never use a proxy. It is optional by design
and an account without one is not missing anything.

### T15 · An account with no proxy still works

Before anything else, confirm the default path is untouched. An account with no
routing configured should behave exactly as in Stage 3.

### T16 · Route an account through a proxy

1. Set an HTTP proxy on one account. Load confirmations.
2. Change it to a SOCKS5 proxy. Load confirmations.

**Pass:** both work, and the account card reads **`routed · verified`** rather
than `routed · unverified`. The app now asks Chromium what it will do with each
request and refuses to send unless the answer names your proxy, so `verified`
means a check passed rather than a field being populated.

**Still check the proxy's own logs.** The app's check proves Chromium _intends_
to use the proxy; only the proxy can prove traffic arrived. Those are different
claims and the second one is the one that matters. This is the single step in
this document that the app cannot do for you.

### T17 · A broken proxy fails closed

Set a proxy that does not exist (`socks5://127.0.0.1:9`). Load confirmations.

**Pass:** that account makes **no connection at all** and says so. **Fails if**
it quietly succeeds — that means it fell back to your real connection, which is
the whole thing this feature exists to prevent.

### T17b · Routing that is configured but not applied

The harder case, and the one the card exists for. With an account routed, load
confirmations once and confirm the card reads `routed · verified`. Then set a
proxy on a **loopback** address (`http://127.0.0.1:8080`) and load again.

**Pass:** Chromium bypasses loopback by default, so the check should catch that
the request would go direct — the card turns to **`ROUTING FAILED`** and the
account refuses to connect. **Fails if** it connects anyway, or if the card still
says verified. This is the exact class of failure — configured, not applied — that
a storage flag could never have detected.

### T18 · Changing the proxy discards the tokens

1. On an account with a working proxy and a live session, change the proxy.
2. Open confirmations.

**Pass:** it asks you to sign in again. The old tokens were minted over the old
route and keeping them would tie the two together.

### T19 · Two accounts do not share a session

Route two accounts through two different proxies. Use both.

**Pass:** neither picks up the other's cookies — each stays signed in as itself.

---

### T27 · Add an authenticator to a new account

**This changes a Steam account and cannot be undone from the app.** Throwaway
only. The account must not already have an authenticator; a phone number is
**not** required (F-10, settled by live run — the code arrives by email instead).

1. Account list → **Add authenticator**.
2. **If you intend to route this account, put the proxy in at this step.** Not
   afterwards. Steam sees the address every request comes from, so enrolling on
   your own connection and routing later ties the two together through the
   account, permanently.
3. Sign in. Answer the emailed Steam Guard code.
4. **Write down the revocation code the moment it is offered.**
5. Enter the activation code — by text if the account has a phone, by email if
   it does not.

**Pass:** the account appears in the list generating codes, and those codes work
on Steam. **Fails if** the screen asks for a text on an account with no phone, or
if the revocation code is not offered before activation is requested.

### T28 · Export a maFile

1. **Export** on any account. Save it.
2. Open it in a text editor.

**Pass:** the SteamID is exact — check the last digits against the account list,
not just the first few. A value ending `...200000000` means precision was lost.
The file must contain no `refreshToken`. Bonus: SDA reads it.

### T29 · Import an encrypted SDA install

**This is the one test whose outcome is genuinely unknown.** Everything else in
this document verifies code written against a format we can see. The SDA
decryption parameters were read out of `Steam Desktop Authenticator.dll` — the
KDF, 50000 iterations, AES-256-CBC — but nothing here has ever been run against
a file SDA itself encrypted. If the format guess is wrong, this is where it
shows, and no amount of unit testing would have caught it.

Set up: in SDA, **Settings → Encrypt maFiles** (or File → Encrypt), and set a
password. Use a spare account if you have one.

1. **Import** → choose the `.maFile` **and** `manifest.json` from the SDA
   folder. Both. The manifest holds the decryption settings.
2. The files should be listed under **Encrypted**, not under "Not imported".
3. Enter the SDA password.

**Pass:** the accounts appear under **Found** with the right account names and
SteamIDs, tick and import cleanly, and then produce codes matching T6.

**If it says the passphrase is wrong when you know it is right** — that is the
format guess being wrong, not you. Say so and it can be narrowed quickly; the
likely suspects are the hash inside the KDF or the iteration count.

Four more, each about a different way this can go sideways:

- **No manifest.** Choose only the `.maFile`. It must say the manifest was not
  among the files you chose — not "wrong passphrase". Nothing about a failed
  decryption would lead you to the actual fix.
- **Wrong passphrase on purpose.** The file must stay listed under Encrypted so
  you can try again. It must not vanish and force you back to the picker.
- **Mixed folder.** One encrypted and one plaintext maFile together: the
  plaintext one should appear under Found immediately, before you type anything.
- **Import with one still locked.** Unlock one of two, then press Import. It
  must warn you that the other will be dropped, before you press it.

**Known:** with a large number of encrypted files the window pauses while they
decrypt — about 11ms per file, so roughly a second at the 100-file maximum.
Expected, not a fault.

---

## Stage 5 — The dangerous ones. Do these last.

### T20 · Reveal a revocation code

1. Reveal one. It will ask for your passphrase again even though you are unlocked.
2. Write it down somewhere that is not this machine.

**Pass:** the passphrase is genuinely required, and it reveals one code at a time.

### T21 · Auto-confirm

**This approves real trades without asking you.** Throwaway only.

1. Enable auto-confirm for trades. Type `APPROVE TRADES` when asked.
2. Send a trade to the account.
3. Wait.

**Pass:** the trade is approved on its own, and the Activity screen records it.

4. Now trigger a phone-number-change confirmation with auto-confirm still on.

**Pass:** it is **not** approved. It is held, and the account list shows an alert
you cannot miss. This is the rule that protects against an attacker using your
own auto-confirm to take the account, and it is worth verifying by hand rather
than trusting me that the allowlist is closed.

### T22 · Auto-confirm stops when locked

Enable it, lock the vault, send a trade, wait.

**Pass:** nothing is approved until you unlock.

### T23 · Remove an account

**Read this before doing it.** Removing an account from the vault does not remove
the authenticator from Steam. Steam will keep demanding codes this app can no
longer produce. Without the revocation code from T20, recovering that account
means Steam Support.

1. Remove an account that **has** a revocation code. Read what the screen says.
2. Then use that revocation code on Steam to actually detach the authenticator.

**Pass:** the screen tells you a revocation code exists before you commit, and
warns harder when one does not.

### T24 · Tray behaviour

1. Close the window with the X.
2. Find the app in the tray. Show it again.
3. Quit properly from the tray.

**Pass:** the X **hides** rather than quits — codes keep being produced. Quit is
explicit and separate. **Fails if** closing the window kills the app, which would
make it useless as an authenticator.

---

## What you do not need to test

These are genuinely covered, and hand-testing them is a poor use of your time:

- **Code generation correctness.** Checked against `steam-totp` across tens of
  thousands of time windows on every push. T6 is still worth doing because it
  tests the whole chain including the clock, not the algorithm.
- **Vault encryption, atomic writes, backup integrity.** Unit-tested including
  the failure paths.
- **maFile parsing edge cases.** Tested against synthetic files covering the
  malformed shapes. T5 exists because your real file is the first real one.
- **The confirmation type allowlist.** Tested as a closed positive list. T21
  step 4 verifies it end to end anyway, because the cost of being wrong is the
  account.
- **IPC validation, navigation lock, CSP.** Tested, and not observable by hand.

---

## Still blocked on you, outside this document

- **Create the GitHub organisation `opendesktopauthenticator`** and the repository
  `open-desktop-authenticator` inside it. `branding.repository` now points there
  and nothing in the build can check that it resolves.
- A Windows code-signing certificate (Q2).
- Sign-off on the IPC channel table (§24.3) — roughly 16 channels.
- Tray and application icons. The current tray icon is a deliberate placeholder.
- The §8 attribution string in `branding.ts` still says "Built on open-source
  Steam libraries by DoctorMcKay", which stopped being true when D13 and Q19
  removed those dependencies. It needs rewording by you, since §8 strings are
  exact-wording assets.
- The scrypt work factor benchmarked on your slowest target machine (Q6).
