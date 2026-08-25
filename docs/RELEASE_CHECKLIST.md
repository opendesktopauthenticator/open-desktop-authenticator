# Release Checklist — v1

Run top to bottom. Nothing here is optional, and nothing here is automated away
without being replaced by something that fails loudly.

**A release is never fully hands-off.** CI produces a draft; a human reviews and
publishes it. Publishing an authenticator binary is the moment users' trust is
actually spent.

Platforms: **Windows and Linux** (D11 — macOS deferred).

---

## Before tagging

- [ ] `main` is green: lint, format, typecheck, build, tests on both platforms.
- [ ] `npm audit --omit=dev` clean, or every finding has a written, dated
      justification linked from the release notes. Never "we'll look at it later".
- [ ] Dependency diff since the last release reviewed by a human. Any new
      transitive dependency understood and named.
- [ ] CHANGELOG entry written — user-facing language, not commit subjects.
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

- [ ] Release workflow ran from the tag in public CI — never a local build.
- [ ] Release workflow's third-party actions are pinned to **full commit SHAs**,
      not tags.
- [ ] Windows: NSIS installer and portable `.exe`. Portable is labelled as
      manual-update.
- [ ] Linux: AppImage and `.deb`.
- [ ] `SHA256SUMS.txt` generated over **every** published asset.
- [ ] Provenance attestations generated over every published binary. **Nothing
      is published that the attestation does not cover** — the workflow now
      fails rather than allowing it, after v1.0.0 published an unattested appx.
- [ ] SBOM published.

### Not yet gates

Written down so the distinction is deliberate rather than forgotten. Each is a
real commitment; none of them blocks a release today, and no page may claim any
of them while it is on this list.

- Signed Git tags. The v1.0.0 tag is unsigned.
- Code-signing for the Windows direct downloads. Blocked on SignPath Foundation.
  The Store package is signed by Microsoft on ingestion, which is a different
  channel with a different guarantee.
- A signature over `SHA256SUMS.txt`. No `.asc` is produced.
- Reproducible builds.

## Manual verification — per platform

Automation does not catch a broken installer.

**Windows**

- [ ] Fresh install on a machine that has never had it. Note the SmartScreen
      behaviour and confirm `/download` describes it honestly.
- [ ] Upgrade install over the previous version. Vault survives, settings survive.
- [ ] App launches, vault unlocks, codes generate.

**Linux**

- [ ] AppImage runs on Ubuntu LTS.
- [ ] AppImage runs on one non-GNOME distro.
- [ ] `.deb` installs and uninstalls cleanly.
- [ ] **Keyring-less distro**: convenience unlock is refused with a plain-language
      warning, and the passphrase still works. `safeStorage` reporting
      `basic_text` must never be treated as real encryption.

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
- [ ] Updater: upgrade from the previous release. Notify-only, never silent.
      "Skip this version" honoured, except for `security`-flagged releases.

## Verify like a stranger

The trust story is only real if it works for someone who does not trust us.

- [ ] Download from the GitHub release page — not from a local build.
- [ ] Follow `docs/verify-windows.md` / `verify-linux.md` exactly as written,
      copy-pasting the commands. Hashes match.
- [ ] Provenance verification succeeds on both platforms:
      `gh attestation verify <file> --owner opendesktopauthenticator`.
      There is no code signature on these files to check — see _Not yet gates_.
- [ ] The website's Windows button deep-links the Store listing, and its other
      buttons deep-link GitHub release assets. **The website hosts no binary.**
- [ ] `/download` on a Windows browser leads with the Store, and on Linux leads
      with the release page. Both are still reachable with JavaScript off —
      the page must never offer nothing because a script failed.

## Publish

- [ ] Release notes include: changes, hashes, verification links, and any
      dependency-advisory justifications.
- [ ] Draft reviewed by a human, then published.
- [ ] Website `/download` updated. Official domains registry still accurate.
- [ ] If this fixes a Valve breakage: pinned status issue updated and closed, with
      a short public post-mortem in the CHANGELOG.

## After publishing

- [ ] Install the published artifact on a clean machine and unlock a vault. If
      this fails, pull the release.
- [ ] Canaries green against the new version.
- [ ] Watch issues for 24 hours before moving on.
