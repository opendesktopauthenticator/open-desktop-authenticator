# Backlog

Ideas that are **not** to be built yet. Per §0.2 and §24.1, anything that belongs
to a later milestone lands here instead of in the codebase.

Nothing in this file is a commitment.

## Deferred from the master plan (§19 post-1.0)

- QR-code login
- Flathub submission
- Localization (English-only at 1.0)
- Encrypted-backup sync guidance (user's own cloud; still serverless)
- Portable-build polish
- GPG release signatures (Q7)
- Reproducible-builds hardening toward byte-for-byte claims (§P3). **Measured,
  not guessed** — two builds back to back on one machine:
  - `out/` and `app.asar` are already byte-identical, as is every file inside
    the NSIS installer, including the 95 MB `app-64.7z` payload and the
    compiled uninstaller.
  - The installer `.exe` is not. The sole cause is that NSIS records each
    embedded file's mtime in its compressed header, and both `app-64.7z` and
    the uninstaller are generated at build time. The recompressed header
    changed length by one byte, which shifts the whole payload — which is why
    a naive diff reports ~100 MB differing while nothing in the content does.
  - `SOURCE_DATE_EPOCH` does **not** help; electron-builder's NSIS path ignores
    it. Tested.
  - So the achievable claim is _payload_ reproducibility, not installer. What it
    still needs: a full version in `.nvmrc` (it floats on `24`), dated runner
    images, a CI job that builds `app.asar` twice and fails on a mismatch, and
    a published hash plus rebuild recipe. Only then flip the site flag — and it
    needs a **narrower** flag than `reproducible`, which currently licenses
    "builds are reproducible" across five pages.
  - The appx is moot: Microsoft re-signs it on ingestion, so that channel can
    never be byte-compared.
- `/guides/*` SEO cluster
- Maintainer #2 onboarding (Q8)

## Raised during Phase 0

- **Reduce the `steamcommunity` dependency surface.** It pulls the deprecated
  `request` plus `cheerio`, `xml2js`, and `image-size`, and is the bulk of the
  120-package production tree (finding F-05). Using it _only_ for confirmations
  and eventually reimplementing that slice against `steam-session` would shrink
  the tree a lot. **Explicitly not before 1.0** — protocol reimplementation is
  what D3 rules out, and doing it early trades the plan's core risk mitigation
  for a smaller number on a marketing page.

- **Promote the redaction wrapper to a lint rule.** The spike proves the idea
  (`spike/src/redact.ts`): registered secrets are scrubbed from all output. §24.4
  forbids raw `console.log` of Steam-layer objects, but forbidding it in prose is
  weaker than an ESLint rule that fails CI. Worth doing in Phase 1, not before.

- **maFile corpus as a permanent fixture set.** The founder has a large real
  collection. Sanitized variants of every structurally distinct shape found there
  would make the §13.1 parser corpus genuinely representative. Requires a
  sanitizer that replaces secrets while preserving structure — small tool, real
  value, but it is a Phase 1 task.
