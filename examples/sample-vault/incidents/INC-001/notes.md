---
status: resolved
opened: "2026-01-15T08:30:00Z"
closed: "2026-01-15T10:15:00Z"
severity: P2
devices: [server-a]
services: [docker]
root_cause: Docker daemon ran out of disk space due to unrotated container logs
fix_summary: Configured log rotation, cleaned old images, added disk monitoring
tags: [docker, disk-space, monitoring]
---

# INC-001: Docker Daemon Disk Space Exhaustion

## Timeline

- **08:30** — Monitoring alert: server-a disk usage at 95%
- **08:35** — Investigated: `/var/lib/docker/containers/` consuming 45GB
- **08:40** — Found container logs growing unbounded (no rotation configured)
- **08:50** — Truncated largest log files to restore immediate capacity
- **09:00** — Configured Docker daemon log rotation: max-size=10m, max-file=3
- **09:15** — Ran `docker system prune` to clean unused images and volumes
- **09:30** — Added Grafana disk usage alert with 80% threshold
- **10:15** — Verified disk usage stable at 62%, closed incident

## Root Cause

Docker daemon was configured without log rotation. Container stdout/stderr logs grew unbounded over 3 months, eventually filling the disk partition.

## Remediation

1. Added `log-opts` to `/etc/docker/daemon.json`: `{"log-driver": "json-file", "log-opts": {"max-size": "10m", "max-file": "3"}}`
2. Restarted Docker daemon
3. Pruned unused images and build cache
4. Added proactive disk monitoring alert at 80%

## Lessons Learned

- Always configure log rotation for containerized services
- Disk space alerts should trigger well before critical thresholds
- Regular `docker system prune` should be part of maintenance schedule
