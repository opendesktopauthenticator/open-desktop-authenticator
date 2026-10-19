# Release Checklist — v1

Run top to bottom. Nothing here is optional, and nothing here is automated away
without being replaced by something that fails loudly.

**A release is never fully hands-off.** CI produces a draft; a human reviews and
publishes it. Publishing an authenticator binary is the moment users' trust is
actually spent.

Platforms: **Windows and Linux** (D11 — macOS built but not published; see
[Turning macOS on](#turning-macos-on)).

---

## Before tagging

- [ ] `main` is green: lint, format, typecheck, build, tests on both platforms.
- [ ] `npm audit --omit=dev` clean, or every finding has a written, dated
      justification linked from the release notes. Never "we'll look at it later".
- [ ] `osv-scanner --lockfile=package-lock.json` clean, on the same terms. It
      covers advisories npm's own database does not, which is the entire reason
      CI gates on it — and for a while the release workflow did not, so a
      finding only OSV knows about could block every pull request and not block
      a release.
- [ ] Dependency diff since the last release reviewed by a human. Any new
      transitive dependency understood and named.
- [ ] CHANGELOG entry written — user-facing language, not commit subjects.
- [ ] **Prepare the website's per-version release evidence.** After publication,
      confirm the release page actually lists `SHA256SUMS.txt.sig` and
      `SHA256SUMS.txt.pem`, then add the exact version to `releaseByVersion` in
      `site/build.mjs` with the verified signing and other evidence. Add the
      corresponding GitHub publication record in `site/publication.mjs` and update
      the canary in `tests/site-release-gaps.test.ts` in the same change, following
      the independent channel checks under **Publish** below. The `release`
      getter derives its flags from that version's evidence; do not edit a shared
      `release.signed` flag. These records say what a published download carries,
      not what the workflow is configured to produce.
- [ ] **Run the published verify command against a real asset**, exactly as
      written on /verify and in the draft release notes, with the tag
      substituted. The workflow verifies its own signature with an identity it
      builds itself; that proves nothing about the command strangers are handed.
      Those two drifted once — the published copy checked only that the signer
      was somewhere under the GitHub organisation.
- [ ] Version bumped, `.nvmrc` and `engines` still correct.
- [ ] **Branding resolved.** `hasUnresolvedBranding()` returns false.
- [ ] **`branding.repository` opened in a browser and it loads.** The automated
      check only proves the string is not a placeholder. This URL is the third
      link in §4's chain — website → company → repository → source → CI build →
      signed binary — so a 404 here breaks the one thing a suspicious user has to
      check a download against, and it reads as a takedown rather than an
      oversight. Confirm the org name matches what `/official` publishes.
- [ ] [THREAT_MODEL.md](THREAT_MODEL.md) reviewed against what actually shipped.
      Any **UNIMPLEMENTED** marker for a feature now shipping has been removed and
      the section rewritten to describe reality.
- [ ] If anything touched auto-confirm: the type allowlist still rejects unknown
      types, and `acceptAllConfirmations` appears nowhere.

## Build

> **What this section used to say, and why it was wrong.** It required a signed
> Git tag and signed Windows artifacts, under a heading saying nothing here is
> optional. v1.0.0 shipped with an unsigned tag and unsigned direct downloads,
> so either the gates were not gates or the release should not have happened.
> A checklist that is routinely overridden trains people to override it, which
> is worse than not having one. The gates below are the ones that actually hold;
> the aspirations moved to their own list and are marked as such.
> Windows Authenticode signing became a release requirement with v1.5.1; the
> historical unsigned files remain unchanged.

- [ ] Release workflow ran from the tag in public CI — never a local build.
- [ ] Release workflow's third-party actions are pinned to **full commit SHAs**,
      not tags.
- [ ] Windows: NSIS installer and portable `.exe`. Portable is labelled as
      manual-update.
- [ ] For v1.5.1 and later, `WINDOWS_SIGNING_READY=true`; the signed Windows job
      passes without an unsigned fallback. The final installers, portable app,
      packaged app executables and embedded uninstallers have verified
      Authenticode signatures, publisher `MASTERPANEL LLC`, and timestamps. See
      [the signing rollout guide](AZURE_WINDOWS_SIGNING.md).
- [ ] Linux: AppImage and `.deb`.
- [ ] `SHA256SUMS.txt` generated over **every** published asset.
- [ ] Provenance attestations generated over every published binary. **Nothing
      is published that the attestation does not cover** — the workflow now
      fails rather than allowing it, after v1.0.0 published an unattested appx.
- [ ] `SHA256SUMS.txt` is signed, and `SHA256SUMS.txt.sig` and
      `SHA256SUMS.txt.pem` are published beside it. The workflow verifies its own
      signature before creating the release, so this failing means the release
      job failed — but confirm the two files are actually on the release page,
      because "the step passed" and "the asset shipped" are different claims.
- [ ] SBOM published.

### Non-blocking release limits

Written down so the distinction is deliberate rather than forgotten. None blocks
a release today, and no page may claim that the current release provides one.

- Signed Git tags. The current release tag is unsigned.
- Older Windows direct downloads, including v1.5.0, are unsigned and are not
  replaced. New signed Windows releases identify MASTERPANEL LLC but do not
  guarantee the absence of SmartScreen warnings. The Store package is signed by
  Microsoft separately. Linux downloads are not platform code-signed; use the
  hashes, signed checksum list and build-provenance attestations.
- Reproducible builds are not provided.

## Manual verification — per platform

Automation does not catch a broken installer.

**Windows**

- [ ] Fresh install on a machine that has never had it. Note the SmartScreen
      behaviour and confirm `/download` describes it honestly.
- [ ] Upgrade install over the previous version. Vault survives, settings survive.
- [ ] App launches, vault unlocks, codes generate.
- [ ] Force-close the portable launcher once while it is running. Any abandoned
      Windows Temp stage contains only extracted Electron/Chromium runtime files,
      never `vault.json`, settings, account secrets or recovery records. Record
      runtime residue as launcher cleanup, not as leaked account data; the normal
      exit cleanup is enforced by the packaged-executable workflow fixture.

**Linux**

- [ ] AppImage runs on Ubuntu LTS.
- [ ] AppImage runs on one non-GNOME distro.
- [ ] `.deb` installs and uninstalls cleanly.
- [ ] **Keyring-less distro**: the vault still unlocks with the passphrase, and
      nothing offers a keyring-backed shortcut. Convenience unlock is a vault
      format capability that is **not implemented** — Settings says so — so there
      is no switch to test. If it is ever built, `safeStorage` reporting
      `basic_text` must never be treated as real encryption, and this step
      becomes a real one again.

## Manual verification — function

Use throwaway accounts. Never a real trading account.

- [ ] Import a real maFile. Codes match a known-good source, digit for digit.
- [ ] Import a maFile with **no** revocation code — the warning appears and the
      account is flagged.
- [ ] Import a maFile whose `SteamID` is an **unquoted** JSON number. Confirm the
      stored SteamID is exact. This one silently corrupts into a different
      account's ID if the parser regresses.
- [ ] Revocation-code ceremony cannot be skipped. An account is not active until
      it completes.
- [ ] List confirmations. Accept one. Deny one. Verify both in Steam itself.
- [ ] **Full enrollment on a throwaway account** — cannot be automated (§13.1.5).
      Includes a forced crash between `enableTwoFactor` and finalize, then resume.
- [ ] Auto-confirm, if enabled in this release: runs only while unlocked, pauses
      on lock, logs every action, halts after repeated auth failures.
- [ ] Updater: on a build newer than the last release, the check reports
      up-to-date; on an older one it reports the new version and links to it.
      **Notify-only, never silent** — it must not download or install anything.
      Turning the check off in Settings stops it contacting GitHub at all.
- [ ] The updater states are `disabled`, `storeManaged`, `upToDate`,
      `updateAvailable` and `unknown`. There is no "skip this version" and no
      `security` flag on a release. This checklist tested both for a while, which
      is how a checklist stops being run: the first unperformable line teaches
      the reader that the whole list is decorative.

## Verify like a stranger

The trust story is only real if it works for someone who does not trust us.

- [ ] Download from the GitHub release page — not from a local build.
- [ ] Follow [the verification page](https://opendesktopauthenticator.com/verify)
      exactly as written, copy-pasting the commands rather than adapting them.
      Hashes match. That page is what users are actually sent to, so testing
      anything else tests the wrong thing — this step previously named
      `docs/verify-windows.md` and `docs/verify-linux.md`, which have never
      existed.
- [ ] Provenance verification succeeds on both platforms:
      `gh attestation verify <file> --owner opendesktopauthenticator`.
- [ ] On Windows, downloaded v1.5.1+ files report a valid Authenticode signature
      from `MASTERPANEL LLC` with a timestamp. Confirm the installer description
      is `Open Desktop Authenticator`. Do not mistake a valid signature for a
      guarantee about SmartScreen reputation or application behaviour.
- [ ] `cosign verify-blob` on the checksum list succeeds, run from the downloaded
      copies rather than from the build directory.
- [ ] The website's download buttons link to all four official sources: the
      Microsoft Store listing, the GitHub release page, and the Softonic and
      Uptodown Windows x64 listings. Check the version and delivered file at each
      source separately.
      **The website hosts no binary.**
- [ ] Keep the unresolved Softonic download-route note until a fresh check establishes
      resolution. A public download tested on 1 October 2026 returned a separate
      Softonic downloader instead of the original ODA installer. Verify the actual
      delivered file against the matching GitHub release's hash and publisher
      signature before marking that route resolved; a listing or scan label
      is insufficient.
- [ ] All four `/download` destinations remain reachable with JavaScript off.
      The Softonic download notice remains visible too; the page must not depend
      on a script or platform detection to offer the appropriate source links.

## Publish

- [ ] Release notes include: changes, hashes, verification links, and any
      dependency-advisory justifications.
- [ ] Every intended asset is attached to the draft and verified before
      publication, including binaries, SBOM, checksums, and checksum signatures.
- [ ] Draft reviewed by a human, then published. New releases become immutable
      on publication: assets cannot be replaced or removed, and the associated
      tag cannot be moved. Corrected binaries require a new version and tag;
      the release title and notes remain editable. See
      [GitHub's immutable release guidance](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).
- [ ] **GitHub marker, independently:** open the public release page in a logged-out
      browser, confirm the exact version, date, checksums, signature and artifacts
      that are actually listed, then add that version under `github` in
      `site/publication.mjs` and its exact evidence in `site/build.mjs`. A green
      workflow or draft is not publication.
- [ ] **Store marker, independently:** open Partner Center and the public Store
      listing, confirm the exact version has completed publication, then add that
      version under `store` in `site/publication.mjs`. A GitHub release and a
      submitted Store package prove neither this transition nor each other.
- [ ] Website `/download` updated. Official domains registry still accurate.
- [ ] If this fixes a Valve breakage: pinned status issue updated and closed, with
      a short public post-mortem in the CHANGELOG.

## Turning macOS on

Everything below the certificate is already built: the `mac` block in
`electron-builder.config.mjs`, the Hardened Runtime entitlements in
`signing/entitlements.mac.plist`, the `icon.icns` at ten native sizes, and the
macOS leg of the release matrix. CI produces an unsigned `.dmg` on every release
and uploads it under `macos-unsigned-check`, which the publish job's
`pattern: package-*` cannot collect. Nothing published, nothing promised.

What is missing is one certificate, one API key, and one switch.

**1 · Enrol.** Apple Developer Program, **Company/Organization** — not
Individual, which would put a person's name on every install instead of the
company's. Requires the D-U-N-S number, the legal entity name exactly as
registered, and a phone number on the D&B record that reaches a human, because
Apple verifies by calling it. $99/year.

**2 · Create a Developer ID Application certificate.** This is the one for
direct downloads; Mac App Store distribution uses a different certificate and
would additionally require App Sandbox, which is not worth doing for a first
macOS release. **A Mac is not needed** — the portal takes a CSR from anywhere:

```
openssl req -new -newkey rsa:2048 -nodes -keyout mac-signing.key -out mac-signing.csr
```

Upload the CSR, download the `.cer`, then combine. **Include the Apple
Worldwide Developer Relations intermediate** — without it the chain is
incomplete and `codesign` produces a signature that verifies on the machine
that made it and nowhere else, which is the most expensive way to discover a
missing file:

```
openssl x509 -inform DER -in developerID.cer -out mac-signing.pem
openssl pkcs12 -export -inkey mac-signing.key -in mac-signing.pem   -certfile AppleWWDRCAG3.pem -out mac-signing.p12
base64 -w0 mac-signing.p12 > mac-signing.p12.base64
```

**3 · Create an App Store Connect API key.** App Store Connect → Users and
Access → Integrations → App Store Connect API. **Developer** role or higher.
The `.p8` downloads exactly once. This is what notarisation authenticates with;
it is preferred over an Apple ID and app-specific password because it does not
expire and never prompts for two-factor in CI.

**4 · Put them in the repository.** Settings → Secrets and variables → Actions.
Six secrets:

| Secret                       | What goes in it                                         |
| ---------------------------- | ------------------------------------------------------- |
| `MACOS_CERTIFICATE_P12`      | base64 of `mac-signing.p12`                             |
| `MACOS_CERTIFICATE_PASSWORD` | the password used on the `-export` above                |
| `APPLE_API_KEY_P8`           | base64 of the `.p8` — the workflow decodes it to a file |
| `APPLE_API_KEY_ID`           | the key's 10-character ID                               |
| `APPLE_API_ISSUER`           | the issuer UUID, on the same App Store Connect page     |
| `APPLE_TEAM_ID`              | the 10-character Team ID from the membership page       |

The certificate and the key are checked against each other, not each on their
own: `electron-builder.config.mjs` refuses to build when one is present and the
other is not, because that combination produces a signed but un-notarised
`.dmg` — which Gatekeeper blocks everywhere except the machine that built it,
and which looks like a successful build all the way to the release page.

**5 · Flip the switch.** Same settings page, Variables tab:
`MACOS_SIGNING_READY` = `true`. The artifact then uploads as `package-macos-latest`
and the publish job collects, hashes, attests and cosigns it like every other
asset.

The `.p8` is stored base64-encoded because it is multi-line PEM, and the
workflow decodes it into `RUNNER_TEMP` before building. That indirection is not
tidiness: `APPLE_API_KEY` is a **file system path**, because electron-builder
hands it to `@electron/notarize`, which puts it after `xcrun notarytool --key`.
The published electron-builder documentation says to set the variable to the
base64 contents directly — following it makes notarisation fail looking for a
file named after a wall of base64. Settled by reading `@electron/notarize`'s own
type definitions in `node_modules`, not the docs.

**6 · On the first signed release, check two things by hand.** Neither can be
checked from here, and both need a Mac:

- [ ] The `.dmg` opens on a Mac that has **never seen this application**, from a
      download rather than a copy, with no Gatekeeper warning. A stapled
      notarisation is only observable on a machine that did not build it.
- [ ] `spctl -a -vvv -t install <app>` reports `accepted` and
      `source=Notarized Developer ID`.

Then update `README.md`, `MAINTENANCE.md` and the product site, all three of
which currently say macOS is not supported — and are correct until this is done.

---

## After publishing

- [ ] Install the published artifact on a clean machine and unlock a vault. If
      this fails, withdraw the affected release and explain the problem publicly.
      Deleting an immutable release does not make its tag name reusable; publish
      any corrected build under a new version and tag.
- [ ] Canaries green against the new version.
- [ ] Watch issues for 24 hours before moving on.
