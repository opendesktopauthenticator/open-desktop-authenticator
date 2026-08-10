# Maintenance

Nobody in this category publishes one of these. That is exactly why it exists: an
authenticator you depend on should tell you who maintains it, what they have
committed to, and what happens when they stop.

## Maintainer of record

**MASTERPANEL LLC**, and personally its founder, who is named on the product
website's About page along with the company's other properties. We do not
maintain this anonymously, and we do not hide where we come from — we come from
the Steam trading world, we lost money to a fake authenticator download in it,
and we built this because of that.

At launch this is a **single-maintainer project**. That is a real risk to you and
it is stated rather than glossed over. Mitigations are below.

## Commitments

| Situation                                              | What we do                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Valve breaks a core flow (login, codes, confirmations) | Status posted on a pinned issue within **24 hours** of detection; work starts within **48 hours** |
| Security report                                        | See [SECURITY.md](SECURITY.md)                                                                    |
| Routine maintenance                                    | Monthly window: Electron and dependency updates, canary review, triage                            |
| Chromium security patches                              | Non-optional. Shipped in the monthly window, or immediately if severity warrants                  |

Detection is not left to chance: canaries run daily against dedicated throwaway
accounts and exercise login, code generation, and confirmation fetching. The
intent is to hear about a break from a robot within 24 hours rather than from an
angry forum thread in 72.

## Supported platforms

**Windows and Linux.**

**macOS is not supported.** Signing a macOS build requires Apple Developer
enrollment as an organization, which we have not completed. We will not ship an
unsigned macOS build — an authenticator you cannot verify is not worth
installing, and teaching users to click through Gatekeeper warnings would
undermine the one habit that actually protects them.

If that changes it will be announced here and on the product site. Anything
claiming to be a macOS build of this application today is not ours.

## Bus factor

The honest failure mode of a single-maintainer security tool is that the
maintainer disappears and the project rots while still looking alive.

- **Break-glass escrow, from day one.** Sealed documentation covering signing
  material locations, GitHub organisation recovery, the domain registrar, and the
  release procedure — stored offline in two separate places.
- **Second maintainer.** Recruited from credible early contributors, targeted
  before 1.0, given release access and escrow knowledge. Until that exists, the
  escrow document is the bridge.
- **Quarterly**: escrow refresh and a restore-from-backup fire drill.

## If we step away

We will say so, publicly and in this file, and then do one of two things:

1. **Hand over** the organisation to vetted maintainers, announced in advance; or
2. **Archive** with a clear, dated final notice explaining that the project is no
   longer maintained and what users should do instead.

**We will not let this project silently rot while appearing alive.** That is what
happened to the tool this one replaces, and the vacuum it left is what the clone
sites filled.

## Release cadence

No fixed schedule. Releases happen when there is something worth shipping:
a fix, a security patch, or a feature that is finished. Every release is signed,
hashed, attested, and published only on GitHub Releases.

We would rather ship nothing than ship something we cannot stand behind.

## Where things live

|                           |                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------- |
| Source, issues, releases  | This repository                                                                        |
| Security reports          | [SECURITY.md](SECURITY.md)                                                             |
| Threat model              | [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)                                           |
| Contributing              | [CONTRIBUTING.md](CONTRIBUTING.md)                                                     |
| Release procedure         | [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)                                 |
| Official domains registry | [opendesktopauthenticator.com/official](https://opendesktopauthenticator.com/official) |
