# Open Desktop Authenticator

An open-source desktop authenticator for Steam. Windows and Linux.
An independently developed alternative to SDA, unaffiliated with Valve or SDA's authors.

Developed, owned, and published by [MASTERPANEL LLC](https://masterspanel.com) ·
Official ODA website: [opendesktopauthenticator.com](https://opendesktopauthenticator.com)

MASTERPANEL LLC also operates Master Panel. ODA and Master Panel are separate
products with no shared accounts, data, or integration.

> **Current release: 1.5.1. Four official download sources: the Microsoft Store,
> GitHub Releases, Softonic and Uptodown.**
> On Windows, you can install the Store version from the
> [Microsoft Store](https://apps.microsoft.com/detail/9NMM2XJ6HZ1D), which
> currently distributes the x64 package. The
> [releases page](https://github.com/opendesktopauthenticator/open-desktop-authenticator/releases/latest)
> also provides direct Windows x64, ARM64 and universal installers, a portable
> x64 build, AppImage and Debian packages; check a direct download against the
> published checksums. [Softonic](https://open-desktop-authenticator.en.softonic.com/)
> and [Uptodown](https://open-desktop-authenticator.en.uptodown.com/windows)
> list Windows x64 downloads. Uptodown's 1.5.1 listing was checked on
> 15 October 2026.
>
> Softonic displays **Official distributor** and **Trusted Program** labels for
> ODA, as checked on 1 October 2026. The distributor label indicates authorization
> from the developer or its designated representative; Trusted Program reflects the VirusTotal scan reported
> by Softonic for the listed ODA file.
> These are Softonic's labels, not an independent audit or a guarantee of safety.
>
> A public Softonic download tested on 1 October 2026 returned a separate Softonic
> downloader instead of the original ODA installer. Resolution is not verified;
> use the Microsoft Store, GitHub or Uptodown route and verify the actual ODA file.
>
> The Store package is signed, because Microsoft re-signs what it distributes.
> The [v1.5.1 direct Windows downloads](https://github.com/opendesktopauthenticator/open-desktop-authenticator/releases/tag/v1.5.1)
> are Authenticode-signed and timestamped through Azure Artifact Signing, with
> **MASTERPANEL LLC** as publisher. The existing v1.5.0 Windows executables remain
> unsigned and unchanged. Linux files are not platform code-signed. Signing
> identifies the publisher but does not guarantee that SmartScreen will stop
> warning. Verify direct downloads against `SHA256SUMS.txt`, its sigstore signature
> and the build-provenance attestation; check Windows Digital Signatures details too.
>
> The core authenticator flows have been **exercised end to end against live
> Steam accounts** by the maintainer — import from SDA, enrollment, codes,
> confirmations, backup and recovery — with the defects that surfaced fixed.
> The v1.5 browser's live signed-in handoff and the published Linux packages
> still await their recorded human checks; see
> [the founder test plan](docs/FOUNDER_TEST_PLAN.md). This is maintainer testing,
> not an independent audit, and passing Store certification does not change
> that: certification checks policy compliance, not cryptography.

Find the project on [AlternativeTo](https://alternativeto.net/software/open-desktop-authenticator/about/).

---

## Why this exists

The original [Steam Desktop Authenticator project](https://github.com/Jessecar96/SteamDesktopAuthenticator)
is no longer supported and warns about counterfeit downloads. A team member's
[account of losing a Steam inventory](https://opendesktopauthenticator.com/steam-inventory-stolen)
after installing a suspected counterfeit helped motivate ODA. That account is
personal testimony, not an independently verified forensic report.

ODA provides a desktop option with public source and identifiable release channels.
Users can inspect the connection between the publisher, source and distributed files:

**website → company → GitHub org → source → public CI build → published hash + provenance**

Direct releases are built in public CI from a tag and published with hashes and
provenance. These checks establish release origin, not that the software is free
of vulnerabilities. ODA's four official download sources are the Microsoft Store,
GitHub Releases, Softonic and Uptodown.

**Verification depends on the package.** A GitHub download can be traced all the
way back: its hash is published, and a sigstore attestation
names the workflow run, the commit and the tag that
produced it. Windows downloads from Softonic or Uptodown should be checked against
that same GitHub release evidence. The Store package is built by that same workflow run, but it is then
submitted to Partner Center by hand and re-signed by Microsoft — so what you can
verify there is that Microsoft distributed it, not which commit it came from.
That is a real limit, it is Microsoft's design rather than ours, and it is the
trade-off of Store distribution. Store signing does not guarantee that every device
policy will permit the application.

### Don't trust us. Verify us.

**Check the source and the file before installing an authenticator.** Our product
website hosts no installer. Its download links lead to the Microsoft Store,
GitHub Releases, Softonic or Uptodown. For a Windows download through either
distributor, check the actual file against the matching GitHub release's
checksums, provenance and publisher-signature instructions. A listing alone does
not verify a file. Treat other download sources as unverified.

On Windows the Store is the route we point people at, because Microsoft re-signs
the package and nobody has to be talked through comparing a hash on the day they
are already worried about their account. The releases page stays for Linux, for
Windows images with no Store, for the portable build, and for anyone who would
rather check the bytes than be told they are fine.

---

## What it does

- Encrypted multi-account vault — your passphrase, on every platform
- Import your existing SDA maFiles
- Steam Guard codes
- Trade and market confirmations: view, accept, deny
- Optional auto-confirm, per account, per type, off by default
- Optional desktop notifications when a confirmation needs you, per account, off by default
- Optional per-account network routing
- Runs entirely on your machine

**No ODA backend. No ODA account. No cloud sync. No telemetry.** No paid tiers.
Steam operations go from your machine to Valve, using any route or proxy you
configure, without passing through an ODA service.

## What it will not do

No trade automation beyond confirmations. No market or inventory tooling. No
analytics of any kind, including "anonymous" or opt-in. These are not roadmap
items; they are deliberate non-goals.

---

## Status

|                                                    |          |
| -------------------------------------------------- | -------- |
| Phase 0 — protocol validated against live accounts | **done** |
| Phase 1 — app shell, security posture, CI, docs    | **done** |
| 0.1 — vault, import, codes, confirmations          | **done** |
| 0.1 — sign-in, tray, settings, auto-confirm        | **done** |
| 1.0 — packaged public releases, Windows + Linux    | **done** |
| 1.5 — in-app browser, notifications, arm64         | **done** |

**macOS is not supported.** Signing it requires Apple Developer enrollment as an
organization, which we have not completed. We will not ship an unsigned macOS
build — an authenticator you cannot verify is not worth installing. See
[MAINTENANCE.md](MAINTENANCE.md).

---

## Documentation

|                                                        |                                                     |
| ------------------------------------------------------ | --------------------------------------------------- |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)           | What we protect, what we do not, what we accept     |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)           | How it is built and why                             |
| [docs/PHASE0_FINDINGS.md](docs/PHASE0_FINDINGS.md)     | What live testing taught us, including the mistakes |
| [docs/FOUNDER_TEST_PLAN.md](docs/FOUNDER_TEST_PLAN.md) | What still has to be verified by hand, and why      |
| [SECURITY.md](SECURITY.md)                             | Reporting a vulnerability                           |
| [MAINTENANCE.md](MAINTENANCE.md)                       | Who maintains this and what happens if we stop      |
| [CONTRIBUTING.md](CONTRIBUTING.md)                     | Setup and the rules that get PRs rejected           |

## Development

```bash
nvm use && npm ci && npm run dev
```

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
```

`/spike` is the Phase 0 CLI: reference code, never shipped, kept because it is
the record of how the Steam protocol actually behaves.

---

## Credits

Steam Desktop Authenticator was created by **Jessecar96** and community
contributors. It is no longer maintained. This is an independent, modern
independent open-source alternative inspired by it — not a fork, and not affiliated with it.

**DoctorMcKay's** open-source Steam libraries are how this protocol is
documented in practice, and we use them where they are the right tool.
**`steam-session` handles signing in.** ODA uses its maintained implementation
instead of duplicating that work (D14). `steam-totp` is
not shipped, but our code generation is checked against it on every push (D13).
`steamcommunity` is not shipped either, for reasons recorded in Q19. Open Desktop
Authenticator is an independent project and is not affiliated with or endorsed by
DoctorMcKay.

## Licence

MIT. See [LICENSE](LICENSE).

---

Open Desktop Authenticator is an independent open-source project maintained by
MASTERPANEL LLC. Not affiliated with, endorsed by, or sponsored by Valve
Corporation. Steam and the Steam logo are trademarks of Valve Corporation.

---

<sub>`PROJECT_MASTER_PLAN.md` is referenced throughout these documents and is
deliberately not in the repository: the canonical copy lives with the founder,
and retyping a document full of exact-wording assets would invite silent drift.
Every decision taken since it was written is recorded in
[docs/PLAN_AMENDMENTS.md](docs/PLAN_AMENDMENTS.md), which is public and is the
authority where the two disagree.</sub>
