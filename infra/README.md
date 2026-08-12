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
