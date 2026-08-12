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

cert=/etc/letsencrypt/live/opendesktopauthenticator.com/cert.pem
if [ -r "$cert" ]; then
  ends=$(date -d "$(openssl x509 -in "$cert" -noout -enddate | cut -d= -f2)" +%s)
  days=$(( (ends - $(date +%s)) / 86400 ))
  # Renewal runs at 30 days. Below 21 means renewal has failed twice in silence.
  if [ "$days" -lt 21 ]; then log err "certificate expires in $days days; renewal is failing"; fail=1;
  elif [ "$days" -lt 30 ]; then log warning "certificate expires in $days days"; fi
else
  log err "certificate unreadable at $cert"; fail=1
fi

used=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "$used" -gt 90 ]; then log err "disk ${used}% full"; fail=1
elif [ "$used" -gt 80 ]; then log warning "disk ${used}% full"; fi

[ "$fail" -eq 0 ] && log info "ok"
exit "$fail"
