# Cache Service Runbook

## Overview

Operational procedures for the cache service.

## Alerting

Page when hit ratio drops below the threshold for five minutes.

## Procedures

- Restart the cache facade.
- Flush the eviction queue.

## Rollback steps

Disable the feature flag to bypass the cache.

## On-call

The platform team owns the pager rotation.

## Escalation

Escalate to the service owner if latency stays elevated.

## Recovery

Warm the cache by replaying recent reads.
