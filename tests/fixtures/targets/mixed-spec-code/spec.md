# Session Store Requirements Specification

## Requirements

Sessions survive a single node restart.

## User stories

- As a user, my session persists across a failover.

## Acceptance criteria

- A restarted node resumes existing sessions.
- No session data is lost during cutover.

## Constraints

Backed by the shared store only.

## Out of scope

Cross-region session replication.

## Non-functional requirements

Session read latency under 3ms.
