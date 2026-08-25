# Maintenance

Nobody in this category publishes one of these. That is exactly why it exists: an
authenticator you depend on should tell you who maintains it, what they have
committed to, and what happens when they stop.

## Maintainer of record

**MASTERPANEL LLC** — a registered company, named on the product website
alongside its other properties, and looked up in a state registry rather than
taken on faith.

**The founder is deliberately not named**, and this section used to claim
otherwise. The accountable entity is the company: it can be looked up, it can be
served, and it has other work to point at. Attaching an individual's name adds
nothing a reader can act on and follows one person around permanently — which is
the reasoning `site/pages/story.mjs` already records for telling that story
unattributed. What matters for trust is that the publisher is findable, and it
is.

At launch this is a **single-maintainer project**. That is a real risk to you and
it is stated rather than glossed over. Mitigations are below.

## Commitments

| Situation                                              | What we do                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Valve breaks a core flow (login, codes, confirmations) | Status posted on a pinned issue within **24 hours** of detection; work starts within **48 hours** |
| Security report                                        | See [SECURITY.md](SECURITY.md)                                                                    |
| Routine maintenance                                    | Monthly window: Electron and dependency updates, canary review, triage                            |
| Chromium security patches                              | Non-optional. Shipped in the monthly window, or immediately if severity warrants                  |

**Detection is currently manual, and this section used to claim otherwise.** It
said canaries run daily against dedicated throwaway accounts, exercising login,
code generation and confirmation fetching. No such workflow exists — the
repository contains `ci.yml` and `release.yml` and nothing scheduled — so the
sentence described the intent as though it were the arrangement.

The intent stands: hear about a Valve-side break from a robot within 24 hours
rather than from an angry forum thread in 72. Until that is built, breaks are
found by the maintainer using the application and by users reporting them, which
is slower and depends on somebody being awake. Treat the response times in the
table above as commitments once a break is _known_, not as a promise about how
quickly it becomes known.

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
- **Second maintainer.** Recruited from credible early contributors, given
  release access and escrow knowledge. This was targeted before 1.0 and did not
  happen — 1.0 shipped with one maintainer, and saying so is more use to you than
  a date that has already passed. Until it exists, the escrow document is the
  bridge, and this remains the project's largest single point of failure.
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
a fix, a security patch, or a feature that is finished. Every release is hashed
and reaches users through exactly two channels: the Microsoft Store, and GitHub
Releases. The website hosts no binary and never will.

**The two are not produced identically, and this used to say they were.** Every
GitHub artifact is hashed into `SHA256SUMS.txt` and covered by a build
provenance attestation. The Store package is built by the same workflow run, but
it is uploaded as a workflow artifact rather than a release asset, submitted to
Partner Center by hand, and re-signed by Microsoft — so it carries Microsoft's
signature rather than our attestation, and its build step is `continue-on-error`
precisely so a Store tooling failure cannot hold up the direct downloads.
Saying "every release is attested" flattened that into one guarantee it does not
have.

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
