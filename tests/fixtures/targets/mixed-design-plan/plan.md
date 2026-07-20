# Session Store Implementation Plan

## Implementation steps

1. Add the store adapter.
2. Introduce the session client.
3. Cut traffic over behind a flag.

## Files to change

- `src/session/client.ts`
- `src/session/store.ts`

## Milestones

- M1: adapter merged
- M2: client merged

## Rollout

Percentage-based cutover.

## Rollback

Revert to per-node sessions via the flag.

## Definition of Done

All sessions served from the shared store.
