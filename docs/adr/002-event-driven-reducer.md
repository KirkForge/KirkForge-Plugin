# ADR 002: Event-driven reduction for state convergence

## Status
Accepted

## Date
2026-05-13

## Context
The verification battery runs 5 emitters in parallel. Each emitter produces signals asynchronously. The orchestration layer needs a single consolidated verdict from these 5 independent signals, and it must handle missing or failed signals safely.

## Decision
Use an EventBus + StateReducer pattern:

1. **EventBus** (`core-events`) — in-process typed pub/sub with SHA256-based idempotency, buffer capacity limits, and graceful drain on shutdown
2. **StateReducer** (`orchestrator/reducer`) — subscribes to all 5 verifier event kinds, accumulates per-task, and `reduce()` produces a single `ReducedStatePacket`

The reducer operates on a **fail-closed** principle:
- Missing signal → default values that imply failure (`errors: 1`, `brokenEdges: 1`, `critical: 1`)
- Explicit verifier `"error"` status → fail
- Only when all 5 signals arrive clean does the verdict become `pass`

## Consequences

- Asynchronous verification tools do not need callbacks or coordination — they just emit events
- The reducer is the single source of truth for any task's verification state
- Fail-closed semantics mean the system prefers false negatives (reporting passing code as failing) over false positives (accepting broken code)
- Every `taskPass: true` from an external validator that the reducer marks `fail` is a bug in the reducer
