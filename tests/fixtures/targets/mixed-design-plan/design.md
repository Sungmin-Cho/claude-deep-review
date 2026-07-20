# Session Store Design

## Context

Sessions are currently stored per-node, which breaks failover.

## Problem

A node restart drops active sessions.

## Architecture

Move sessions to a shared store fronted by a thin client.

## Components

- Session client
- Store adapter

## Data flow

Reads and writes route through the client to the shared store.

## Alternatives

Sticky sessions were rejected for failover reasons.

## Trade-offs

Adds a network hop per session access.
