# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). It is the preferred channel: it is
private, it threads, and it does not depend on an email address staying valid.

You can also email **security@opendesktopauthenticator.com**. Private GitHub
reporting is still preferred — it threads, and it does not depend on an address
staying monitored — but the mailbox is read.

Nothing else is a security channel. Not Discord, not a forum DM, not a comment on
an unrelated issue.

## What to expect

| Stage               | Commitment                                                 |
| ------------------- | ---------------------------------------------------------- |
| Acknowledgement     | Within 72 hours                                            |
| Initial assessment  | Within 7 days                                              |
| Fix or a dated plan | Within 30 days for confirmed high/critical                 |
| Public disclosure   | 90 days from report, coordinated, or sooner if a fix ships |

These are commitments from a **single maintainer** (§18), stated honestly rather
than optimistically. If we are going to miss one, we will say so before the
deadline rather than after.

## Coordinated disclosure

Default is 90 days. We will move faster if a fix is ready and slower only by
agreement with you. If a vulnerability is being actively exploited, we will ship
and disclose immediately rather than wait.

We will not ask you to stay quiet indefinitely, and we will not threaten legal
action against good-faith research.

## Credit

You will be credited in the release notes and the advisory by whatever name or
handle you choose, unless you ask us not to be. Say so in your report.

**There is no bug bounty.** This project is free and takes donations only (§17);
we are not going to promise money we may not have. That is stated up front so
nobody spends time expecting otherwise.

## What is in scope

- The application: main process, preload, renderer, vault, IPC surface.
- Release integrity: signing, hashes, provenance, the update mechanism.
- Anything that contradicts a claim in
  [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) — including "your threat model is
  wrong about X", with no working exploit required.

## What is out of scope

Please read [docs/THREAT_MODEL.md §4](docs/THREAT_MODEL.md) first. In short:

- Attacks assuming a fully compromised OS, or code execution as the user while
  the vault is unlocked.
- Vulnerabilities in Steam itself — report those to Valve.
- Missing hardening with no described attack path ("you should also do X").
- Advisories in dependencies with no demonstrated reachable path in our code. We
  track those separately in CI; a report is welcome but is not treated as a
  vulnerability in this application unless you can show it is reachable.
- Social engineering of the maintainer, and physical attacks.

## A note on this file's promises

Everything above is a promise made by one named maintainer at one company. If
that changes — including if the project is handed over or wound down — this file
and [MAINTENANCE.md](MAINTENANCE.md) will say so publicly. The project will not
silently rot while appearing alive.
