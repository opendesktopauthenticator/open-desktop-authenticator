# Caching, and the one setting that is not in this repository

Every HTML response used to be fetched from the origin in Germany. Measured
live, that was **0.47s to 0.93s before the first byte**, on every page, for
every reader, forever — a straight LCP penalty on first view and the largest
remaining technical-SEO problem on the site.

## What the origin now sends

| Path                         | `Cache-Control`             | `CDN-Cache-Control`                                  |
| ---------------------------- | --------------------------- | ---------------------------------------------------- |
| HTML                         | `no-cache`                  | `public, max-age=300, stale-while-revalidate=86400`  |
| `/assets/` (content-hashed)  | `public, immutable`, 1 year | —                                                    |
| `/favicon.ico` and friends   | `no-cache`                  | `public, max-age=3600, stale-while-revalidate=86400` |
| `/support/ticket/`, `/admin` | `no-store`                  | —                                                    |

Two headers rather than one, deliberately. `Cache-Control: no-cache` keeps the
guarantee the site has always made: a browser revalidates every time, so a
corrected page is never served stale from somebody's disk. `CDN-Cache-Control`
is invisible to browsers and speaks only to shared caches, which is where the
five minutes lives.

### The trap

The obvious version is one header:

```
Cache-Control: public, max-age=0, s-maxage=300
```

It reads as "browsers revalidate, shared caches hold it for five minutes". It
was shipped first, and it did nothing: Cloudflare
[documents](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)
that it **does not cache** a response whose `Cache-Control` is `private`,
`no-store`, `no-cache`, **or `max-age=0`** — the `s-maxage` is not consulted.
The edge went on answering `cf-cache-status: DYNAMIC` and the deploy looked
successful.

`tests/infra-caching.test.ts` fails if `max-age=0` reappears in `Cache-Control`.

## The setting that has to be made in the dashboard

**Headers alone are not enough.** Cloudflare caches by file extension and
[does not treat HTML as eligible at all](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/#default-cached-file-extensions),
whatever the origin says, until a Cache Rule says so.

In **Caching → Cache Rules → Create rule**:

- **Name**: `Cache HTML at the edge`
- **When incoming requests match**: `Hostname equals opendesktopauthenticator.com`
  **and** `URI Path does not start with /support/` **and** `URI Path does not
start with /admin`
- **Cache eligibility**: `Eligible for cache`
- **Edge TTL**: `Use cache-control header if present, use default Cloudflare
caching behavior if not`
- **Browser TTL**: `Respect origin TTL`

The two path exclusions are belt and braces. Those routes already send
`no-store`, which is itself enough to keep them out of any shared cache, and
the rule excludes them as well so that a future header mistake cannot put
somebody's support thread on an edge node. **Both defences, not one.**

## Purging on deploy

With HTML cached for five minutes, a deploy is visible to a reader within five
minutes without any action. That is fine for content and wrong for a
correction, so purge after deploying anything urgent:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/purge_cache" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  --data '{"purge_everything":true}'
```

The token needs only `Zone → Cache Purge → Purge`. It is not in this repository
and should not be.

## How to tell whether it is working

```bash
curl -sSI https://opendesktopauthenticator.com/ | grep -i cf-cache-status
```

- `DYNAMIC` — not cached. The Cache Rule is missing or not matching.
- `MISS` — eligible, and this was the request that filled the cache.
- `HIT` — being served from the edge. This is the goal.

A `HIT` should also show a TTFB well under 0.2s from most locations, against
the 0.47–0.93s measured before.

## What was deliberately not done

Caching HTML for longer than five minutes. The gain past that point is small
and the cost is that a wrong page — a wrong recovery instruction, on a site
whose entire argument is that its claims can be checked — stays wrong for
longer. Five minutes is roughly one deploy.
