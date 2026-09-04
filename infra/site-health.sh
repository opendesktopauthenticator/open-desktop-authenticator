#!/bin/bash
#
# What can be checked from the box itself.
#
# **This is not uptime monitoring.** A check running on the server cannot tell
# anyone the server is unreachable — that needs something outside it, which
# needs an account somebody has to create. What this does catch is the slower
# failures that kill a site quietly: a certificate nobody renewed, a disk that
# filled with logs, nginx serving errors, fail2ban having stopped.
#
# Writes to the journal, tagged, so `journalctl -t site-health` is the history.
set -uo pipefail
log() { logger -t site-health -p "daemon.$1" "$2"; }
fail=0

if ! systemctl is-active --quiet nginx; then log err "nginx is NOT running"; fail=1; fi
if ! systemctl is-active --quiet fail2ban; then log err "fail2ban is NOT running"; fail=1; fi
if ! ufw status | grep -q "^Status: active"; then log err "ufw is NOT active"; fail=1; fi

code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
  --resolve opendesktopauthenticator.com:443:127.0.0.1 \
  https://opendesktopauthenticator.com/ 2>/dev/null)
if [ "$code" != "200" ]; then log err "site returned $code from the origin"; fail=1; fi

# The ticket service, which is the domain's only dynamic part.
#
# Checking nginx and `/` proves the static site is up and says nothing about
# this: the ticket routes are `proxy_pass`ed to 127.0.0.1:8787, so when the unit
# is dead or crash-looping those 502 while `/` still answers 200 — and this job
# logged "ok" through an outage of report submission, reporter access and the
# admin queue alike.
if ! systemctl is-active --quiet tickets; then log err "tickets.service is NOT running"; fail=1; fi

# A route nginx actually proxies. `/support` is served by `try_files` from
# support.html, so it answered 200 with the ticket service dead — only
# /support/submit, /support/attach, /support/ticket/* and /admin* reach
# Node. An unknown reference is answered 404 *by Node*, which is the proof
# wanted: a dead or hung service gives 502/504 from nginx instead.
ticket=$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
  --resolve opendesktopauthenticator.com:443:127.0.0.1 \
  https://opendesktopauthenticator.com/support/ticket/ODA-HEALTHCHECK 2>/dev/null)
if [ "$ticket" != "404" ]; then log err "ticket service returned $ticket, expected 404"; fail=1; fi

cert=${ODA_CERT_FILE:-/etc/letsencrypt/live/opendesktopauthenticator.com/cert.pem}
if [ -r "$cert" ]; then
  ends=$(date -d "$(openssl x509 -in "$cert" -noout -enddate | cut -d= -f2)" +%s)
  days=$(( (ends - $(date +%s)) / 86400 ))
  # Renewal runs at 30 days. Below 21 means renewal has failed twice in silence.
  if [ "$days" -lt 21 ]; then log err "certificate expires in $days days; renewal is failing"; fail=1;
  elif [ "$days" -lt 30 ]; then log warning "certificate expires in $days days"; fi
else
  log err "certificate unreadable at $cert"; fail=1
fi

# Do not turn arbitrary output into a plausible percentage by deleting the
# characters we do not understand. `df` failing, returning nothing, or changing
# its format is itself a health failure; treating `8x%` as `8%` reports the exact
# opposite. `pipefail` carries a failure from either command in the pipeline.
if ! disk_raw=$(df --output=pcent / | tail -1); then
  log err "disk usage probe failed"
  fail=1
else
  # The real value may be padded around one number and one percent sign. Match
  # that complete shape instead of deleting whitespace: `8 1%` is malformed,
  # not a different spelling of `81%`.
  if [[ ! "$disk_raw" =~ ^[[:space:]]*([0-9]{1,3})%[[:space:]]*$ ]]; then
    log err "disk usage probe returned an invalid value"
    fail=1
  else
    used=${BASH_REMATCH[1]}
    # Explicit base ten so a padded value such as 081 is not read as octal.
    used_number=$((10#$used))
    if [ "$used_number" -gt 100 ]; then
      log err "disk usage probe returned an out-of-range value"
      fail=1
    elif [ "$used_number" -gt 90 ]; then
      log err "disk ${used_number}% full"
      fail=1
    elif [ "$used_number" -gt 80 ]; then
      log warning "disk ${used_number}% full"
    fi
  fi
fi

[ "$fail" -eq 0 ] && log info "ok"
exit "$fail"
