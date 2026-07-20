# Cache Layer Design

## Context

The service currently recomputes derived values on every request. This document
describes the design of a shared cache layer.

## Problem

Recomputation dominates p99 latency under load.

## Goals

- Reduce redundant computation.
- Keep read-after-write consistency.

## Non-goals

- Distributed invalidation across regions.

## Architecture

A process-local LRU sits in front of the store, with a write-through path.

## Components

- Cache facade
- Eviction policy
- Metrics probe

## Data flow

Requests resolve through the facade, which consults the store on a miss.

## Alternatives

We considered a read-through-only variant and rejected it.

## Trade-offs

Memory pressure increases in exchange for lower latency.

## Observability

Hit ratio and eviction counters are exported.

## Migration

The cache is introduced behind a feature flag.
