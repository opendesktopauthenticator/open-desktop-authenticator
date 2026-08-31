# Open Desktop Authenticator

An open-source desktop authenticator for Steam. Windows and Linux.
A maintained successor to SDA.

Built and maintained by **MASTERPANEL LLC** · [opendesktopauthenticator.com](https://opendesktopauthenticator.com)

> **1.0 is out.** Install it from the
> [Microsoft Store](https://apps.microsoft.com/detail/9NMM2XJ6HZ1D), or take a
> build from [the releases page](https://github.com/opendesktopauthenticator/open-desktop-authenticator/releases/latest)
> and check it against the published checksums. **Those two places, and nowhere
> else** — anything else claiming to be a build of this is not ours.
>
> The Store package is signed, because Microsoft re-signs what it distributes.
> The direct downloads are not signed yet, so Windows warns on first run; verify
> them against `SHA256SUMS.txt` and the build provenance attestation.
>
> It has been **exercised end to end against live Steam accounts** by the
> maintainer — import from SDA, enrollment, codes, confirmations, backup and
> recovery — with the defects that surfaced fixed. That is maintainer testing,
> not an independent audit, and passing Store certification does not change
> that: certification checks policy compliance, not cryptography.

---

## Why this exists

The tool an entire trading economy depends on — Steam Desktop Authenticator — is
no longer maintained. Search for it and page one is full of clone sites shipping
modified binaries that steal accounts. Our founder lost about **$3,000** to
exactly that scam, and the sites are still there, resurfacing under new domains
every time one gets reported.

Open source alone does not fix this. Attackers compile open source with malware
added. What fixes it is a chain a stranger can walk without trusting anyone:

**website → company → GitHub org → source → public CI build → published hash + provenance**

So: every release is built in public CI from a tag, published with hashes and
provenance, by a named company that does not hide where it came from. It reaches
you through the Microsoft Store, which re-signs the package, or from GitHub
Releases, where you can check the bytes yourself.

**The two channels are not equally provable, and it is worth saying which is
which.** A GitHub download can be traced all the way back: its hash is published,
and a sigstore attestation names the workflow run, the commit and the tag that
produced it. The Store package is built by that same workflow run, but it is then
submitted to Partner Center by hand and re-signed by Microsoft — so what you can
verify there is that Microsoft distributed it, not which commit it came from.
That is a real limit, it is Microsoft's design rather than ours, and it is the
trade you make for a package Windows never warns about.

### Don't trust us. Verify us.

**Never download an authenticator from a website — including ours.** Every button
on our site links somewhere else: the Microsoft Store listing, or a release asset
on this repository. The site hosts no binary and never will. Anything else
claiming to be this application is not.

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

**No servers. No sync. No telemetry. No accounts. No paid tiers. Ever.** We
operate no backend for this product — Steam communication happens directly
between your machine and Valve.

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
open-source successor inspired by it — not a fork, and not affiliated with it.

**DoctorMcKay's** open-source Steam libraries are how this protocol is
documented in practice, and we use them where they are the right tool.
**`steam-session` handles signing in** — it is the flow every Steam tool uses and
reimplementing it was a mistake we made once and reverted (D14). `steam-totp` is
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
