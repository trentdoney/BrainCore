---
status: resolved
opened: "2026-02-20T03:15:00Z"
closed: "2026-02-20T04:30:00Z"
severity: P2
devices: [server-a]
services: [nginx, api]
root_cause: SSL certificate expired, causing 502 errors for all HTTPS traffic
fix_summary: Renewed certificate, configured auto-renewal cron, added expiry monitoring
tags: [ssl, nginx, certificate, automation]
---

# INC-003: SSL Certificate Expiration

## Timeline

- **03:15** — Automated monitoring detected 502 errors spike
- **03:20** — Investigated nginx logs: `SSL_do_handshake() failed (SSL: error:... certificate has expired)`
- **03:25** — Confirmed: Let's Encrypt certificate expired 15 minutes ago
- **03:30** — Ran `certbot renew` — renewal succeeded
- **03:35** — Reloaded nginx: `systemctl reload nginx`
- **03:40** — HTTPS traffic restored, 502 errors cleared
- **04:00** — Added certbot auto-renewal cron job
- **04:15** — Added certificate expiry monitoring (alert 14 days before expiry)
- **04:30** — Verified all services accessible, closed incident

## Root Cause

Let's Encrypt certificate auto-renewal was not configured. The certificate expired after 90 days, causing nginx to reject all TLS handshakes.

## Remediation

1. Renewed certificate immediately with `certbot renew`
2. Added cron: `0 0 1 * * certbot renew --quiet --post-hook "systemctl reload nginx"`
3. Added monitoring: check certificate expiry daily, alert at 14 days remaining
4. Documented renewal process in runbook

## Lessons Learned

- Certificate auto-renewal must be verified after initial setup
- Monitor certificate expiry proactively (14+ days warning)
- Keep a manual renewal runbook accessible for emergency use
