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

inspect_firewall() {
	local inspected
	if ! inspected=$(ufw status numbered); then
		echo "could not inspect the firewall; refusing to claim or change its exposure" >&2
		return 1
	fi
	if ! printf '%s\n' "$inspected" | grep -qx 'Status: active'; then
		echo "ufw is not active or returned an unfamiliar status; refusing to continue" >&2
		return 1
	fi
	printf '%s\n' "$inspected"
}

# Print exact app-owned rules as "PORT CIDR" pairs.
#
# The comment is the ownership boundary, but it is not enough by itself: a
# malformed or future rule carrying that comment must stop the script rather
# than be turned into a guessed delete command. Numbered status is still used as
# an authenticated snapshot shape; the number itself is deliberately discarded.
cloudflare_rules() {
	local inspected=$1 line port cidr
	while IFS= read -r line; do
		case "$line" in
			*'# cloudflare'*) ;;
			*) continue ;;
		esac

		if [[ "$line" =~ ^\[[[:space:]]*[0-9]+\][[:space:]]+(80|443)/tcp[[:space:]]+ALLOW[[:space:]]+IN[[:space:]]+(([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2})[[:space:]]+\#[[:space:]]cloudflare[[:space:]]*$ ]]; then
			port=${BASH_REMATCH[1]}
			cidr=${BASH_REMATCH[2]}
		elif [[ "$line" =~ ^\[[[:space:]]*[0-9]+\][[:space:]]+(80|443)/tcp[[:space:]]+\(v6\)[[:space:]]+ALLOW[[:space:]]+IN[[:space:]]+([0-9a-fA-F:]+/[0-9]{1,3})[[:space:]]+\#[[:space:]]cloudflare[[:space:]]*$ ]]; then
			port=${BASH_REMATCH[1]}
			cidr=${BASH_REMATCH[2]}
		else
			echo "could not understand an app-owned Cloudflare firewall rule; refusing to delete it" >&2
			return 1
		fi
		printf '%s %s\n' "$port" "$cidr"
	done <<< "$inspected"
}

# Delete by the complete rule identity, never by a number from a prior status
# snapshot. fail2ban inserts at rule 1 and renumbers every later rule; this
# command continues to name the same Cloudflare CIDR after that insertion.
delete_cloudflare_rule() {
	local port=$1 cidr=$2
	ufw --force delete allow from "$cidr" to any port "$port" proto tcp comment 'cloudflare' >/dev/null
}

# Print 80 and/or 443 when one numeric UFW port specification exposes them.
#
# UFW application profiles ultimately expand to these same specifications, for
# example `80,443/tcp`. Ranges matter too: a custom `79:81/tcp` profile exposes
# port 80 even though neither the profile name nor its displayed rule says so.
web_ports_from_spec() {
	local spec protocol ports piece first last
	spec=$(printf '%s' "$1" | tr -d '[:space:]')
	case "$spec" in
		*/*)
			protocol=${spec##*/}
			ports=${spec%/*}
			;;
		*)
			# A rule without `/udp` includes TCP.
			protocol=any
			ports=$spec
			;;
	esac
	if [ "$protocol" != tcp ] && [ "$protocol" != any ]; then
		return 0
	fi

	local IFS=','
	for piece in $ports; do
		if [[ "$piece" =~ ^([0-9]+):([0-9]+)$ ]]; then
			first=${BASH_REMATCH[1]}
			last=${BASH_REMATCH[2]}
			if [ "$first" -le 80 ] && [ "$last" -ge 80 ]; then printf '%s\n' 80; fi
			if [ "$first" -le 443 ] && [ "$last" -ge 443 ]; then printf '%s\n' 443; fi
		elif [ "$piece" = 80 ] || [ "$piece" = 443 ]; then
			printf '%s\n' "$piece"
		fi
	done
}

# Print every web port exposed by an unrestricted inbound rule.
#
# `ufw status numbered` displays application rules by profile *name* —
# `Nginx Full`, or any locally-defined name — rather than by the ports that
# profile opens. Looking only for `80/tcp` and `443/tcp` therefore certified an
# origin as restricted while an unrestricted profile still exposed both. Resolve
# every non-numeric target through UFW itself; an unresolvable target is an
# inspection failure, never evidence that it is safe.
unrestricted_web_ports() {
	local inspected=$1 line target numeric profile specs code
	while IFS= read -r line; do
		if [[ ! "$line" =~ ^\[[[:space:]0-9]+\][[:space:]]+(.+)[[:space:]]+ALLOW[[:space:]]+IN[[:space:]]+(Anywhere([[:space:]]+\(v6\))?|0\.0\.0\.0/0|::/0)([[:space:]]+\#.*)?$ ]]; then
			continue
		fi

		target=${BASH_REMATCH[1]}
		# Trim the fixed-width status column, its IPv6 label and an optional
		# interface suffix before deciding whether this is a port or a profile.
		target="${target%"${target##*[![:space:]]}"}"
		target=${target% (v6)}
		target=${target%% on *}
		target="${target%"${target##*[![:space:]]}"}"

		if [ "$target" = Anywhere ]; then
			printf '%s\n' 80 443
			continue
		fi

		numeric=${target//[[:space:]]/}
		if [[ "$numeric" =~ ^[0-9,:]+(/[[:alnum:]]+)?$ ]]; then
			web_ports_from_spec "$numeric"
			continue
		fi

		if profile=$(ufw app info "$target"); then
			:
		else
			code=$?
			echo "could not inspect UFW application profile '$target'" >&2
			return "$code"
		fi
		specs=$(
			printf '%s\n' "$profile" | awk '
				/^Ports:[[:space:]]*/ {
					inside = 1
					line = $0
					sub(/^Ports:[[:space:]]*/, "", line)
					if (line != "") print line
					next
				}
				inside && /^[[:space:]]+/ {
					line = $0
					sub(/^[[:space:]]+/, "", line)
					if (line != "") print line
					next
				}
				inside { exit }
			'
		)
		if [ -z "$specs" ]; then
			echo "UFW application profile '$target' did not report its ports" >&2
			return 1
		fi
		while IFS= read -r spec; do
			web_ports_from_spec "$spec"
		done <<< "$specs"
	done <<< "$inspected"
}

if [ "${1:-}" = "--off" ]; then
	status=$(inspect_firewall)
	while :; do
		if cloudflare=$(cloudflare_rules "$status"); then
			:
		else
			code=$?
			exit "$code"
		fi
		[ -n "$cloudflare" ] || break
		read -r port cidr _ <<< "$cloudflare"
		delete_cloudflare_rule "$port" "$cidr"
		# Re-read after every mutation. Concurrent rule insertion is harmless to an
		# exact delete, and the next iteration proves what still remains.
		status=$(inspect_firewall)
	done
	ufw allow 80/tcp  comment 'http - acme challenge and redirect' >/dev/null
	ufw allow 443/tcp comment 'https' >/dev/null
	status=$(inspect_firewall)
	if cloudflare=$(cloudflare_rules "$status"); then
		:
	else
		exit $?
	fi
	if [ -n "$cloudflare" ]; then
		echo "Cloudflare-only rules remain; the origin was not reopened" >&2
		exit 1
	fi
	if web_exposure=$(unrestricted_web_ports "$status"); then
		:
	else
		exit $?
	fi
	if ! printf '%s\n' "$web_exposure" | grep -qx 80; then
		echo "the final firewall state has no unrestricted HTTP rule" >&2
		exit 1
	fi
	if ! printf '%s\n' "$web_exposure" | grep -qx 443; then
		echo "the final firewall state has no unrestricted HTTPS rule" >&2
		exit 1
	fi
	echo "origin reopened to the world"
	exit 0
fi

status=$(inspect_firewall)
ranges=$(mktemp)
ranges_v4=$(mktemp)
ranges_v6=$(mktemp)
trap 'rm -f "$ranges" "$ranges_v4" "$ranges_v6"' EXIT
# **Separate files are load-bearing.** The IPv4 list does not end in a newline,
# so concatenating the two produced `131.0.72.0/222400:cb00::/32` — one corrupt
# line that ufw rejected outright. Keeping the responses apart also makes their
# family and count independently checkable before either can affect UFW.
#
# **`tr -d '\r'` is written as an escape, not as a literal carriage return.** It
# was a literal one once. A pass that normalised this directory's line endings
# then rewrote it to a newline, leaving `tr -d` deleting the separator between
# the ranges instead of the stray CR after each — every range fused into one
# unparseable line, which is precisely the corruption the paragraph above
# describes. The escape means the same thing to tr and survives being
# normalised. `bash -n` does not catch the literal form, because a string with a
# newline in it is perfectly valid shell.
curl -fsS --max-time 20 https://www.cloudflare.com/ips-v4 \
	| tr -d '\r' \
	| grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$' > "$ranges_v4"
curl -fsS --max-time 20 https://www.cloudflare.com/ips-v6 \
	| tr -d '\r' \
	| grep -E '^[0-9a-fA-F:]+/[0-9]{1,3}$' > "$ranges_v6"
v4_count=$(wc -l < "$ranges_v4")
v6_count=$(wc -l < "$ranges_v6")
count=$((v4_count + v6_count))
# Refuse to touch the firewall on a partial fetch — a truncated list would lock
# out most of Cloudflare and take the site down. The families are counted
# separately: fifteen valid IPv4 ranges must not make an empty-but-successful
# IPv6 response look complete and cause every existing IPv6 allow to be removed
# as stale.
if [ "$count" -lt 15 ] || [ "$v4_count" -lt 5 ] || [ "$v6_count" -lt 5 ]; then
	echo "only $v4_count IPv4 and $v6_count IPv6 ranges fetched, refusing to change anything"
	exit 1
fi
cat "$ranges_v4" "$ranges_v6" > "$ranges"

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
# Only rules this script wrote are considered: matched on the exact `cloudflare`
# comment and the exact CIDR/port/protocol shape, so a hand-added allow is never
# touched. Deletion uses that semantic identity rather than a number which a
# concurrent fail2ban insertion can invalidate.
#
# Nothing being stale is the normal outcome, not an error. It is handled as
# grep's specific exit 1 below instead of with `|| true`: the latter also hid a
# real failure from `ufw status numbered`, then printed a success claim about a
# firewall the script had not managed to inspect.
removed=0

# Re-inspect after each removal. Besides avoiding stale rule numbers, this makes
# every next deletion conditional on the exact semantic rule still being
# present in a fresh, successfully parsed firewall snapshot.
while :; do
	status=$(inspect_firewall)
	if cloudflare=$(cloudflare_rules "$status"); then
		:
	else
		exit $?
	fi
	stale=''
	while read -r port cidr; do
		[ -n "$port" ] || continue
		if ! grep -Fxq -- "$cidr" "$ranges"; then
			stale="$port $cidr"
			break
		fi
	done <<< "$cloudflare"
	[ -n "$stale" ] || break
	read -r port cidr <<< "$stale"
	delete_cloudflare_rule "$port" "$cidr"
	removed=$((removed + 1))
done

status=$(inspect_firewall)
if web_exposure=$(unrestricted_web_ports "$status"); then
	:
else
	exit $?
fi
if printf '%s\n' "$web_exposure" | grep -qE '^(80|443)$'; then
	echo "an unrestricted web rule remains; the origin is not Cloudflare-only" >&2
	exit 1
fi
if cloudflare=$(cloudflare_rules "$status"); then
	:
else
	exit $?
fi

# Prove the complete desired set, not merely that one IPv4 and one IPv6 rule
# survived. A successful UFW command followed by a missing rule is still a
# failed lockdown.
for family in IPv4 IPv6; do
	if [ "$family" = IPv4 ]; then
		expected_ranges=$ranges_v4
	else
		expected_ranges=$ranges_v6
	fi
	while read -r cidr; do
		[ -n "$cidr" ] || continue
		for port in 80 443; do
			if ! printf '%s\n' "$cloudflare" | grep -Fxq -- "$port $cidr"; then
				echo "the final firewall state has no $family Cloudflare allow rule for $cidr on port $port" >&2
				exit 1
			fi
		done
	done < "$expected_ranges"
done

# The removal loop already enforces this; repeat it against the final snapshot
# so a changed or incomplete mutation can never be followed by a success claim.
while read -r port cidr; do
	[ -n "$port" ] || continue
	if ! grep -Fxq -- "$cidr" "$ranges"; then
		echo "a withdrawn Cloudflare range remains allowed for port $port: $cidr" >&2
		exit 1
	fi
done <<< "$cloudflare"

rm -f "$ranges" "$ranges_v4" "$ranges_v6"
trap - EXIT
if [ "$removed" -gt 0 ]; then
	echo "origin restricted to $count Cloudflare ranges ($removed withdrawn range(s) removed)"
else
	echo "origin restricted to $count Cloudflare ranges"
fi
