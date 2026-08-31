# Security hardening — findings and plan

**Status: not implemented. Nothing here is done.**
**Revision 1.** Every finding below was verified against the working tree by
reading the named files; each one quotes the line that decides it. Two findings
raised by the same audit were **refuted** and are recorded as refuted in §7,
with the evidence, because a document that silently drops a claim invites the
next reviewer to raise it again.

Split out of `NOTIFY_POLLER_PLAN.md`, which had grown a "phase 0" that had
nothing to do with notifications. **These are independent of the notification
feature and none of them blocks it** — the notification work touches none of
the code below.

Findings are ordered by what they cost if left alone, not by how hard they are
to fix. H1 is the one to do first.

| #   | Finding                                                                | Severity | Effort |
| --- | ---------------------------------------------------------------------- | -------- | ------ |
| H1  | ~~Browser tabs run with DevTools and spellcheck enabled~~ **fixed**    | High     | Small  |
| H2  | Published signature-verification instructions check only the org       | High     | Small  |
| M1  | `osv-scanner` gates CI but not releases                                | Medium   | Small  |
| M2  | A tag-mismatched dispatch produces a valid signature for the wrong tag | Medium   | Medium |
| M3  | `account:setProxy` is ungated relative to its blast radius             | Medium   | Medium |
| L1  | `inputs.tag` is interpolated into shell in `release.yml`               | Low\*    | Small  |

\* Low because it requires repository write access, which is already game over.
Listed because it is one line to fix.

---

## 1. H1 — the in-app browser weakens its own hardening by omission — **FIXED**

> **Done.** `HARDENED` is composed from `SECURE_WEB_PREFERENCES`, both posture
> tests were rewritten to check composition rather than enumerate fields, and a
> real-Electron smoke check now measures the live views rather than reading the
> source — because a source assertion being trusted to prove a runtime property
> is how this happened in the first place.
>
> **Building it found more than the report did.** `spellcheck: false` on
> `webPreferences` governs the _view_; the spellchecker is a **session** service,
> and a live run showed it still enabled with `en-US` loaded on a session whose
> every view had the preference off. `denyAllPermissions` now calls
> `setSpellCheckerEnabled(false)`. That in turn exposed a second gap: the
> toolbar's `browser-chrome` partition had never been through session hardening
> at all, so it was the last view still running one.
>
> Measured, not argued: `no browser view can open DevTools — 0 of 2`,
> `no browser session runs a spellchecker — enabled on 0 of 2`. Five mutants
> applied including the original defect restored verbatim; all five caught.

**This is the finding to act on first**, and it was reported to me as a code
duplication issue. It is not. It is a live weakening of the security posture in
packaged builds, on exactly the views that are least protected elsewhere.

### What is there

The canonical posture, `src/shared/security-policy.ts:14-42`, freezes eleven
fields — including `spellcheck: false` and `devTools: false`. The main window
spreads it (`index.ts:126`, `...SECURE_WEB_PREFERENCES`).

The in-app browser does not. `src/main/browser/electron-host.ts:49-61` declares
its own object:

```ts
/** The window options this application fixes rather than exposes. */
const HARDENED = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webviewTag: false
} as const;
```

Four fields of the canonical eleven. `electron-host.ts` imports
`denyAllPermissions` from `../security` — the very module that re-exports
`SECURE_WEB_PREFERENCES` — and does not import the constant.

The first comment inside that object reads _"Identical to the main window's
posture."_ It is not, and that sentence is the reason nobody looked again.

### Why the omission matters, when no value disagrees

Every field `HARDENED` declares carries the canonical value. There is no drift
in the usual sense. The problem is the seven it does not declare, which fall
back to **Electron's defaults**:

| Omitted field                 | Electron default | Canonical | Consequence |
| ----------------------------- | ---------------- | --------- | ----------- |
| `nodeIntegrationInWorker`     | `false`          | `false`   | benign      |
| `nodeIntegrationInSubFrames`  | `false`          | `false`   | benign      |
| `webSecurity`                 | `true`           | `true`    | benign      |
| `allowRunningInsecureContent` | `false`          | `false`   | benign      |
| `experimentalFeatures`        | `false`          | `false`   | benign      |
| **`spellcheck`**              | **`true`**       | `false`   | **live**    |
| **`devTools`**                | **`true`**       | `false`   | **live**    |

`devTools` is the serious one. `security-policy.ts:34-41` records why the
constant pins it false: DevTools in a shipped authenticator is a self-XSS
vector, and _"open the console and paste this to fix your codes" is a scam that
works on real people_. Nothing under `src/main/browser/` sets it — the only
match in that whole directory is an HTML attribute on the address input — so
**every Steam tab in a packaged build has DevTools enabled**, while the main
window correctly relaxes it only to `devTools: isDev`.

**Be precise about what that reaches, because the canonical comment overstates
it for this case.** That comment continues _"pasted script runs with full
access to whatever `window.api` exposes... from milestone 0.1 it is the
vault"_. That reasoning is about the **main window**. The browser tabs carry no
preload at all — `electron-host.ts:58-59` says so deliberately — so there is
no `window.api` on them and **the vault is not reachable this way**.

What is reachable is the account's **authenticated Steam session**: script
pasted into a tab's console runs in Steam's origin, in a window that is signed
in. Session cookies, acting as the user on the site, initiating a trade. For an
application whose only purpose is protecting that account, that is still High
— it is the exact scam the product exists to defend against, running inside
the product. But it is not vault compromise, and calling it that would make the
next reader distrust the rest of this document.

It compounds. `electron-host.ts:96-98` marks these tabs' session with
`isAccountBrowserContents` so `hardenAllWebContents` (`security.ts:118-147`)
deliberately skips the navigation lock for them — necessary, since a browser
must navigate. So the account tabs are the one place in the process carrying
**both** the navigation exemption and the weakened preference set.

The toolbar is the lower-risk half and still wrong: it is built from the same
short object, so it also has DevTools on, but it runs in the separate
`browser-chrome` partition, keeps its navigation lock, and its preload exposes
only `onState` and `onFocusAddress`.

`spellcheck` is second-order but real, and the canonical comment happens to
understate it here. It notes that an active spellchecker downloads Hunspell
dictionaries from a Google-run CDN, and justifies the setting on the grounds
that the main window's fields hold account names and passphrases. The browser
raises a different objection: that download is an **unproxied network call**
from the one window whose entire reason for existing is that its traffic leaves
through the account's proxy. `README.md` promises the update check is the only
non-Steam request the application makes.

### Why the tests did not catch it

Both relevant tests pass while this is true, which is the more important defect:

- `tests/security-posture.test.ts:100-104`, named
  _"is the only webPreferences used to create a window"_, reads **only**
  `src/main/index.ts` and asserts it contains `...SECURE_WEB_PREFERENCES`. Its
  name claims a whole-application property; its body checks one file.
- `tests/browser-host.test.ts:223` asserts `expect(ADAPTER).toMatch(/\.\.\.HARDENED/)`
  — it pins the duplicate as correct.

### The fix

```ts
const HARDENED = {
  ...SECURE_WEB_PREFERENCES,
  // The browser carries no preload and must never reach the vault or the IPC
  // table. Stated here rather than inherited, because it is this window's
  // reason for existing separately at all.
  webviewTag: false
} as const;
```

**And fix the test that let it happen**, which matters more than the constant:
rename it to what it checks, or make it check what it is named. The honest
version enumerates every `webPreferences` literal in `src/main/` and asserts
each one either spreads `SECURE_WEB_PREFERENCES` or spreads something that
does. A source-text assertion is acceptable here — it is what the existing
posture tests do — but it must cover `src/main/browser/` and any file added
later, or it will fail the same way again.

### Mutations

1. `HARDENED` stops spreading the canonical constant → posture test red
2. `devTools: true` added back explicitly → red
3. `spellcheck` left unset → red
4. a new file with a bare `webPreferences` literal → red

### What this does not cover

Adopted popup `WebContents` (`electron-host.ts:364-365`) receive **no**
`webPreferences` at all — they inherit transitively from the opener through
Chromium. That is a real guarantee rather than a hole, and fixing `HARDENED`
fixes them too, since the opener chain always starts at a `HARDENED` tab. Worth
a comment saying so, because it is not obvious and a future reader may "fix" it
by passing preferences that do not match the adopted contents.

---

## 2. H2 — the verification instructions we publish check only the organisation

The workflow's internal check is tight. The instructions handed to users are
not, and they are the ones that matter: a user verifying a download is the
whole point of signing it.

**Internal**, `release.yml:453-460`:

```
identity="^https://github\.com/${repo_escaped}/\.github/workflows/release\.yml@refs/tags/"
cosign verify-blob SHA256SUMS.txt --certificate-identity-regexp "$identity" ...
```

Repository, workflow file, and a `refs/tags/` prefix.

**Published**, in all three places a user could find it —
`release.yml:513` (the release-notes body), `site/pages/safety.mjs:359`, and
`site/dist/verify.html:227`:

```
--certificate-identity-regexp '^https://github.com/opendesktopauthenticator/'
```

The organisation, and nothing else. A user following our own `/verify` page
accepts a signature minted by **any workflow, in any repository the
organisation owns, run from any branch** — as long as it had `id-token: write`.

The comment at `release.yml:450` says _"The pattern is still tight: this
repository, this workflow file, and `refs/tags/` only."_ That is true of the
line above it and false of the copy forty lines below that we give to strangers.

### The fix

Publish the identity that is actually meant, in all three places, with the tag
substituted:

```
--certificate-identity "https://github.com/opendesktopauthenticator/open-desktop-authenticator/.github/workflows/release.yml@refs/tags/vX.Y.Z"
```

Exact, not a regexp — a user verifying a specific download knows which tag they
took. Generate all three from one source so they cannot drift again;
`site/pages/safety.mjs` already interpolates `s.githubOrg`, so the string has a
home.

Two smaller notes: the `.` in `github.com` is unescaped in the published
regexps (harmless, since Fulcio issues the SAN, but it reads as sloppy in a
document whose purpose is rigour), and `docs/RELEASE_CHECKLIST.md` should gain
a line requiring the published command to be checked against a real artifact
before the release goes out.

---

## 3. M1 — `osv-scanner` gates CI but not releases

`ci.yml:120-129` runs `osv-scanner` as a **gating** step, with a comment
stating why it exists: _"Covers advisories npm's own database misses."_

`release.yml` has exactly one dependency step — `npm audit --audit-level=high
--omit=dev` at lines 68-71. No `osv-scanner` anywhere in the file.

And `release.yml:31` says: _"The same gate CI runs, re-run against the tag."_

This is not a stale copy. `release.yml` is the **newer** file (last modified
2026-08-26 against `ci.yml`'s 2026-08-13), and whoever wrote it deliberately
pulled the production `npm audit` across from CI's separate `security` job.
They took one of that job's three steps. The dev-audit step they also left
behind is non-gating in CI (`|| true` plus `continue-on-error`), so its absence
changes nothing — `osv-scanner` is the only **gating** CI check absent from the
release path.

Net effect: an advisory present in OSV but absent from npm's database blocks
every pull request and every push to `main`, and cannot block a release.

Credit where it is due — `release.yml` pins all twelve `uses:` entries to full
40-character commit SHAs, honouring the mandate `ci.yml:33-36` sets for it.
That part is exemplary.

### The fix

Add the `osv-scanner` step to `release.yml`'s `verify` job, pinned to a SHA
like every other action in that file. Add it to `docs/RELEASE_CHECKLIST.md:18`,
which currently names only `npm audit --omit=dev`.

---

## 4. M2 — a dispatch can sign one tag and publish another

`release.yml` has no job-level `if:`, no `startsWith(github.ref, 'refs/tags/')`,
and no `environment:` with protection rules. `GITHUB_REF` appears only inside a
comment, never in a test.

**A branch dispatch is stopped, but by accident rather than design.** Fulcio
derives the certificate SAN from the run's workflow ref, so a branch-dispatched
run gets `...release.yml@refs/heads/<branch>`, which the `@refs/tags/` prefix
rejects. Verification fails, and attestation and release creation never run.
Note this makes the rationale comment at `release.yml:441-447` inverted on its
facts: it claims that on dispatch _"`GITHUB_REF` is the branch the dispatch came
from while the certificate names the tag."_ The certificate names the **workflow
ref**, not the checkout ref — so the regexp the comment defends is precisely
what would fail the dispatch path it says it exists to support.

**A dispatch from a different tag is not stopped.** `POST /dispatches` accepts a
tag as `ref`. Dispatch with `ref: v0.0.1` and `inputs.tag: v9.9.9`:

- every checkout uses `${{ inputs.tag || github.ref }}` → `v9.9.9`
- the `version` job compares `HEAD` against `v9.9.9` and passes
- `gh release create "$TAG" --verify-tag` publishes as **v9.9.9**
- the certificate identity is `...@refs/tags/`**`v0.0.1`**

The prefix-only regexp accepts it. So does a user running the published
org-only command. Signature and release name different tags and nothing
compares them.

### The fix

Bind the identity to the tag being built, which removes the regexp entirely:

```
--certificate-identity "https://github.com/${GITHUB_REPOSITORY}/.github/workflows/release.yml@refs/tags/${TAG}"
```

Then correct the comment at `release.yml:441-447`, which currently documents the
opposite of how Fulcio behaves and is the reason the regexp was reached for.

---

## 5. M3 — `account:setProxy` is ungated relative to what it destroys

**Read this one carefully, because the audit that raised it overstated it and
the overstatement is load-bearing.**

### What is true

`src/preload/index.ts:155-158` exposes `setAccountProxy` on the ordinary
renderer API. `src/shared/ipc.ts:942-954` constrains `proxyUrl` to
`z.string().max(2048).nullable()` — no scheme, host or format rule at the
contract layer. `src/main/vault/ipc.ts:246-270` validates with `planProxy`
(`egress.ts:518-580`), which is purely syntactic and offline: the URL must
parse, the scheme must be one of http/https/socks5/socks5h/socks4, the hostname
must be non-empty, and SOCKS may not carry inline credentials. There is no
allowlist, no denylist, and no rejection of loopback, link-local, RFC1918 or
cloud-metadata addresses.

The asymmetry is in the gating. `accountRemove` (`ipc.ts:200`) and
`revocationReveal` (`ipc.ts:281`) both take a passphrase. `accountSetProxy`
needs only an unlocked vault, and it unconditionally:

- deletes the stored `refreshToken` (`ipc.ts:384`)
- drops both transport factories' cached sessions and cookie jars
- clears the cached access token and pending confirmations
- closes any open account browser window

On an unattended unlocked machine, that is a one-call forced sign-out plus a
redirection of all future Steam traffic for that account.

### What is not true, and I said otherwise earlier

I previously told the owner this contradicts `THREAT_MODEL.md:577` — _"A
renderer compromise cannot exfiltrate."_ That was too strong, in a way that
matters for what gets built.

The renderer is the **only** caller that can reach this channel. `router.ts:56-62`
fails closed on every channel and the sender predicate is the same
`isAllowedNavigation` used for navigation. There is no privilege boundary
between "the renderer" and "the user" here, and setting a per-account proxy is
a first-class user-facing feature (`App.tsx:639`). Nor is it a general SSRF
primitive: the renderer chooses a **hop**, not a target, and cannot read the
response body — the observable signal is connect success or failure, and error
text is scrubbed by `redactCredentials` before display. `assertRouted` refuses
any request Chromium does not confirm is leaving through the intended endpoint.

So the honest statement is narrower: **a compromised renderer can redirect an
account's future Steam traffic to a proxy of its choosing, and can force a
sign-out. It cannot read the vault's secrets by this route.** That is worth
fixing on its own terms; it is not the exfiltration hole I called it.

### The fix, and the argument against it

The obvious move is a passphrase gate matching `accountRemove`. The argument
against is real: changing a proxy is a routine setting, and a passphrase prompt
on a routine setting trains people to type their passphrase at prompts.

The proportionate answer is a **typed acknowledgement**, as
`accountSetAutoConfirm` already uses for trades — it names the consequence
("this signs the account out and routes its traffic through the new proxy")
without conditioning anyone to re-enter secrets. Decide between the two before
implementing; this document does not settle it.

Independently, and cheaply: `planProxy` should refuse a proxy endpoint on
loopback or link-local unless the user has explicitly opted in. `169.254.169.254`
as a "proxy" is never a legitimate configuration on a desktop, and the check is
four lines. Note the interaction with `steamOnlyBypass()`, which deliberately
ends in `<-loopback>` so that loopback traffic goes **through** the proxy rather
than around it — that is about request destinations and is unrelated to this,
but the two will look contradictory to a reader who does not know the
difference, so the comment has to say which is which.

Two further entry points reach the same validator and must be covered by any
rule added here: `src/main/import/mafile.ts:368` and
`src/main/steam/enrollment.ts:264`. A proxy string can enter the vault from an
imported maFile, not only from this channel.

---

## 6. L1 — `inputs.tag` reaches a shell unquoted

`release.yml:93` and `release.yml:482` both interpolate the dispatch input
directly into a shell script:

```
tag="${{ inputs.tag || github.ref_name }}"
```

GitHub substitutes before the shell parses, so a crafted `inputs.tag` is a
command-injection sink. It requires repository **write** access, which is
already a total compromise, so this is genuinely low. It is also one line:

```
env:
  TAG_INPUT: ${{ inputs.tag }}
run: tag="${TAG_INPUT:-$GITHUB_REF_NAME}"
```

Fix it while touching the file for M2.

---

## 7. Refuted

**"A singleton security-critical confirmation can be approved through the
generic renderer channel, contradicting the threat model."**

The code path is exactly as described — `client.ts:161` guards on
`critical.length > 0 && confirmations.length > 1`, so a lone type-5 or type-6
id reaches `send()`. **It is deliberate, documented and pinned by tests.**

`client.ts:145-153` states the intent directly: any type may be actioned this
way, including account recovery, because someone recovering their own account
has every right to approve it; what is refused is doing so in bulk, as one of
eleven items swept up by a "select all" nobody read. It is a batch rule, never
an approval ban.

Two tests assert the singleton case is **allowed** —
`confirmation-client.test.ts:217` and `confirmation-service.test.ts:225` — so
"fixing" this turns CI red. The renderer already produces exactly the singleton
call the guard permits: `Confirmations.tsx:247-248` splits criticals out and
renders them as a separate ceremony block with per-entry buttons.

The automatic path is separately and genuinely closed: `AUTO_CONFIRMABLE` is
the hard-coded pair `[2, 3]`, and types 1, 4, 5 and 6 sit in
`NEVER_AUTO_CONFIRMABLE`. Read as "auto-confirm can approve account recovery",
the claim is flatly false.

The one defensible residue: the main process applies no extra ceremony to a
singleton critical approval — the deliberateness is enforced by the renderer's
layout, and a caller reaching the channel directly gets the same unimpeded
send. That is worth a sentence in the threat model rather than a code change,
and it is the same class of exposure as M3: a compromised renderer can act as
the user, because it **is** how the user acts.

**"`tick()` wastes a Steam round trip on every beat when nothing is due."**
Recorded and refuted in `NOTIFY_POLLER_PLAN.md` §13; it belongs there rather
than here, and it is not a security finding.

---

## 8. Order of work

H1 first and on its own — it is small, it is the only finding that weakens a
runtime security boundary, and its test fix prevents the next instance.

H2, M1, M2 and L1 next, as one change to `release.yml` plus the three published
copies. They share a file and a review.

M3 last, and only after the passphrase-versus-acknowledgement question above is
answered. It is the only finding here that changes a user-facing interaction,
and getting that wrong has its own cost.

## 9. Gate

Unchanged from the project standard:

```
npm run format:check && npm run lint && npm run typecheck
npx vitest run
npm run build && node site/build.mjs
npm run smoke:browser && npm run stress:browser
```

Plus, for H1, a real packaged build with DevTools confirmed absent from an
account tab — the source assertion is necessary and not sufficient, and this
finding exists because a source assertion was trusted to prove a runtime
property.
