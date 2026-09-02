#!/bin/bash
#
# Restrict ports 80 and 443 to Cloudflare's published ranges, or undo it.
#
#   cloudflare-only         lock the origin down
#   cloudflare-only --off   reopen to the world
#
# **Why.** With the proxy in front, everything legitimate arrives from
# Cloudflare. Leaving the origin open to the internet means the WAF, the rate
# limiting and the DDoS protection are all optional for anyone who learns the
# address — and the address is in DNS history, so assume it is known.
#
# **The footgun, stated plainly.** If the domain is ever grey-clouded, the site
# becomes unreachable until this is turned off. That is the trade, and `--off`
# is the way back. Port 22 is never touched, so the box stays reachable either
# way.
set -euo pipefail

if [ "${1:-}" = "--off" ]; then
	while ufw status numbered | grep -qE '# cloudflare'; do
		n=$(ufw status numbered | grep -E '# cloudflare' | head -1 | grep -oE '^\[[ 0-9]+\]' | tr -d '[] ')
		ufw --force delete "$n" >/dev/null
	done
	ufw allow 80/tcp  comment 'http - acme challenge and redirect' >/dev/null
	ufw allow 443/tcp comment 'https' >/dev/null
	echo "origin reopened to the world"
	exit 0
fi

ranges=$(mktemp)
# **The `echo` between fetches is load-bearing.** The IPv4 list does not end in
# a newline, so concatenating the two produced `131.0.72.0/222400:cb00::/32` —
# one corrupt line that ufw rejected outright. The grep then keeps only lines
# that are actually a CIDR, so a future change of format cannot quietly feed
# junk to the firewall.
#
# **`tr -d '\r'` is written as an escape, not as a literal carriage return.** It
# was a literal one once. A pass that normalised this directory's line endings
# then rewrote it to a newline, leaving `tr -d` deleting the separator between
# the ranges instead of the stray CR after each — every range fused into one
# unparseable line, which is precisely the corruption the paragraph above
# describes. The escape means the same thing to tr and survives being
# normalised. `bash -n` does not catch the literal form, because a string with a
# newline in it is perfectly valid shell.
{
	curl -fsS --max-time 20 https://www.cloudflare.com/ips-v4
	echo
	curl -fsS --max-time 20 https://www.cloudflare.com/ips-v6
	echo
} | tr -d '\r' | grep -E '^[0-9a-fA-F:.]+/[0-9]{1,3}$' > "$ranges"
count=$(wc -l < "$ranges")
# Refuse to touch the firewall on a partial fetch — a truncated list would lock
# out most of Cloudflare and take the site down.
if [ "$count" -lt 15 ]; then
	echo "only $count ranges fetched, refusing to change anything"; rm -f "$ranges"; exit 1
fi

while read -r cidr; do
	[ -n "$cidr" ] || continue
	ufw allow from "$cidr" to any port 80  proto tcp comment 'cloudflare' >/dev/null
	ufw allow from "$cidr" to any port 443 proto tcp comment 'cloudflare' >/dev/null
done < "$ranges"

# Only now remove the open rules, so there is never a window with neither.
ufw --force delete allow 80/tcp  >/dev/null 2>&1 || true
ufw --force delete allow 443/tcp >/dev/null 2>&1 || true

# ── remove ranges Cloudflare no longer publishes ─────────────────────────────
#
# **Adding was never the whole job.** ufw keeps every rule it is given, so each
# refresh added the current list and left every previously-allowed range in
# place for ever. A CIDR Cloudflare gives up — reassigned to somebody else, as
# address space routinely is — stayed permanently allowed to reach the origin
# directly, past the WAF, the rate limiting and the DDoS protection. The script
# whose job is closing that door was quietly propping it open a little wider
# every time it ran.
#
# Only rules this script wrote are considered: matched on the `cloudflare`
# comment, so a hand-added allow is never touched. Deleted by number in
# descending order, because deleting renumbers everything below it.
#
# `|| true` because **nothing being stale is the normal outcome**, not an error.
# The loop above has just re-added exactly the currently-published ranges, so the
# `grep -v` usually matches nothing and exits 1 - and under `set -euo pipefail` an
# assignment whose command substitution fails kills the script. It died here on
# every healthy run: the firewall ended up correct, then the shell exited 1 before
# `rm -f "$ranges"` and before the confirmation line, so the temp file leaked and
# the operator saw no output and a failure status from the one script that can
# take the site offline.
stale=$(
	ufw status numbered \
		| grep -E '# cloudflare' \
		| grep -vFf <(sed 's/^/ /' "$ranges") \
		| grep -oE '^\[[ 0-9]+\]' \
		| tr -d '[] ' \
		| sort -rn || true
)
removed=0
for n in $stale; do
	ufw --force delete "$n" >/dev/null
	removed=$((removed + 1))
done

rm -f "$ranges"
if [ "$removed" -gt 0 ]; then
	echo "origin restricted to $count Cloudflare ranges ($removed withdrawn range(s) removed)"
else
	echo "origin restricted to $count Cloudflare ranges"
fi
