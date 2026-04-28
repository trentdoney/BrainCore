---
status: resolved
opened: "2026-02-03T14:20:00Z"
closed: "2026-02-03T16:00:00Z"
severity: P1
devices: [server-a, server-b]
services: [postgresql]
root_cause: PostgreSQL replication lag caused read replicas to serve stale data
fix_summary: Tuned WAL settings, increased wal_sender_timeout, added replication lag monitoring
tags: [postgresql, replication, data-consistency]
---

# INC-002: PostgreSQL Replication Lag

## Timeline

- **14:20** — User reports: search results showing data from 30 minutes ago
- **14:25** — Checked replication status: replica on server-b lagging 1800 seconds
- **14:30** — WAL sender on server-a showed blocked state
- **14:40** — Root cause: long-running query on replica blocking WAL apply
- **14:45** — Cancelled blocking query on replica
- **14:50** — Replication caught up within 2 minutes
- **15:00** — Added `max_standby_streaming_delay = 30s` to replica config
- **15:15** — Added replication lag alert: warn at 30s, critical at 120s
- **16:00** — Verified stable replication, closed incident

## Root Cause

A long-running analytical query on the read replica held locks that prevented WAL replay, causing replication lag to grow unbounded.

## Remediation

1. Set `max_standby_streaming_delay = 30s` on replicas
2. Set `hot_standby_feedback = on` for better conflict management
3. Added Grafana dashboard for replication lag monitoring
4. Created alert rule: warn > 30s, critical > 120s

## Lessons Learned

- Read replicas need timeout configuration to prevent WAL replay blocking
- Analytical queries should run on dedicated replicas or have statement timeouts
- Replication lag monitoring is essential for any primary-replica setup
