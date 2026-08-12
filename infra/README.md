# Server configuration

The configuration running `opendesktopauthenticator.com`, mirrored from the host
so it exists somewhere other than the host.

Until this directory existed, every hardening decision — the SSH policy, the
firewall, the security headers, the fail2ban jails — lived only on one Contabo
VPS and nowhere else. If that box had been lost, rebuilding it would have meant
reconstructing the reasoning from memory. These files are the record.

**They are a copy, not the source of truth.** Nothing deploys from here
automatically. Editing a file in this directory changes nothing on the server;
the server is still edited directly, and this copy has to be refreshed
afterwards. That is a real limitation and worth fixing if the setup grows.

## Where each file belongs

| Repository path                          | Host path                                     |
| ---------------------------------------- | --------------------------------------------- |
| `nginx/conf.d/00-hardening.conf`         | `/etc/nginx/conf.d/00-hardening.conf`         |
| `nginx/snippets/security-headers.conf`   | `/etc/nginx/snippets/security-headers.conf`   |
| `nginx/snippets/tls.conf`                | `/etc/nginx/snippets/tls.conf`                |
| `nginx/sites-available/oda`              | `/etc/nginx/sites-available/oda`              |
| `nginx/sites-available/000-default-deny` | `/etc/nginx/sites-available/000-default-deny` |
| `sshd_config.d/00-hardening.conf`        | `/etc/ssh/sshd_config.d/00-hardening.conf`    |
| `fail2ban/jail.local`                    | `/etc/fail2ban/jail.local`                    |
| `sysctl.d/99-hardening.conf`             | `/etc/sysctl.d/99-hardening.conf`             |

Both `sites-available` files need a symlink into `sites-enabled` to take effect.

## Not in here, on purpose

- **Certificates and keys.** `/etc/letsencrypt/` holds the private key for the
  origin certificate and is never copied into a repository, least of all a
  public one.
- **`/etc/nginx/conf.d/10-cloudflare-realip.conf`.** Generated from Cloudflare's
  published ranges, which change. Regenerate it with
  `/usr/local/sbin/refresh-cloudflare-ips` rather than restoring a stale copy.
- **The administrator's IP.** `jail.local` exempts the founder's home address
  from fail2ban, after a ban during setup locked out the person setting it up.
  That address is redacted here as `ADMIN_IP_REDACTED`; the deployed file has
  the real one.

## The ticket service

`tickets/server.mjs` in this repository is deployed to `/opt/tickets` and run by
`systemd/tickets.service` as an unprivileged user, listening on loopback only.
It is the sole executing thing on the domain; everything else is a file on disk.

The unit is the fence: `ProtectSystem=strict` with one writable path,
`SystemCallFilter=@system-service`, `IPAddressDeny=any` with only localhost
allowed, no new privileges, 256MB and 64 tasks. None of that is because the code
is suspected — it is so the cost of being wrong is bounded before anyone needs
it to be.

**Setting the administrator passphrase.** There is no sign-up. On first run the
service prints a one-time setup token to its journal, so setting the passphrase
requires access to the server:

```bash
journalctl -u tickets | grep -o 'setup token: [A-Za-z0-9_-]*' | tail -1
```

Open `/admin/bootstrap` on the site, paste the token into the form along with a
passphrase of 16 characters or more, and the token stops existing.

The token is a **form field, never a query parameter**, and that is deliberate.
A secret in a URL is written to the nginx access log as part of `$request`,
written again as the `$http_referer` of every subresource the page pulls, kept
in browser history, and offered by autocomplete afterwards. The access log is
mode 640 `www-data:adm` and is retained compressed for fourteen days, so a
token that is still valid would outlive the minute it was needed for. A POST
body appears in none of those places. The service refuses a token supplied in
the query string even when it is the correct one, so the leaky path cannot come
back by habit.

There is no reset: losing the passphrase means deleting the row from `admins`
in `/var/lib/tickets/tickets.db` and bootstrapping again.

## Monitoring, such as it is

`site-health.sh` runs every 15 minutes and logs to the journal under
`site-health`. It catches the failures that happen quietly — a certificate
nobody renewed, a full disk, nginx serving errors, fail2ban having stopped.

**It is not uptime monitoring.** A check running on the server cannot tell
anyone the server is unreachable. That needs something outside it, which needs
an account somebody has to create, so it remains undone rather than faked.

`oda-backup.sh` writes a dated archive of the configuration that exists nowhere
else — TLS keys, nginx, ufw, fail2ban, sshd — to `/var/backups/oda`, keeping a
fortnight. It restores a box you have broken, not one you have lost; copying
off-site needs a destination and a credential.

## The origin is closed to everything but Cloudflare

`cloudflare-only.sh` (deployed at `/usr/local/sbin/cloudflare-only`) restricts
ports 80 and 443 to Cloudflare's published ranges. Before it ran, anyone who
knew the address could reach the origin directly and skip the WAF, the rate
limiting and the DDoS protection entirely — and the address is in DNS history,
so it should be assumed known.

**The trade-off, stated plainly:** if the domain is ever grey-clouded, the site
becomes unreachable until this is turned off.

```bash
cloudflare-only --off   # reopen to the world
cloudflare-only         # lock it down again, refreshing the ranges
```

Port 22 is never touched, so the box stays reachable either way. Cloudflare's
ranges change; re-run the script to pick up new ones.

## Deploying the site

The site itself is generated, not stored:

```bash
node site/build.mjs                       # -> site/dist
node site/verify.mjs                      # structure, metadata, links
tar -czf - -C site/dist . | ssh root@HOST 'tar -xzf - -C /var/www/oda/public'
node site/verify.mjs https://opendesktopauthenticator.com
```

The second `verify` run is not the same check as the first. One reads the files;
the other asks the server for them and inspects status codes, content types and
security headers. A page can be perfect on disk and unreachable in nginx.

## Things worth knowing before changing anything

- **`add_header` does not accumulate.** A `location` that sets any header
  discards every header inherited from the server block. Every location that
  adds one must re-`include snippets/security-headers.conf`, or it silently
  serves no security headers at all. This has already happened once.
- **`00-` in the sshd filename is deliberate.** sshd takes the first value it
  sees for a keyword, and the cloud image ships
  `50-cloud-init.conf` turning password authentication back on.
- **fail2ban's filters expect the combined log format.** The custom `log_format`
  in `nginx/conf.d/00-hardening.conf` keeps the combined fields first and appends
  extras. Reorder them and every nginx jail silently matches nothing.
- **nginx here is 1.24**, where `http2` is a `listen` parameter rather than its
  own directive.
- **Cloudflare proxies this domain.** The A record shows Cloudflare's edge, never
  the origin. A 521 means Cloudflare could not reach the origin on the port its
  SSL mode implies — with Full or Full (strict), that is 443.
