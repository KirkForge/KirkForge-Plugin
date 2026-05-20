# ADR 004: Memory as a weighted pass-rate routing engine

## Status
Accepted

## Date
2026-05-13

## Context
Different models perform differently on different types of tasks. Running the orchestration loop generates outcome data (pass/fail, token counts, duration). This data should feed back into routing decisions so the orchestrator picks better providers and models over time.

## Decision
Implement a lightweight empirical recommendation engine (`buildEmpiricalRecommendation` in `memory-palace`) that:

1. **Fingerprints** tasks by tokenizing the description, detecting language, inferring task family, and FNV-1a hashing into a 64-dim vector
2. **Recalls** similar past observations using cosine similarity (threshold: 0.18) plus a 0.25 bonus for same task family
3. **Ranks** models and modes by weighted pass rate across similar observations
4. **Produces** a `RoutingBias` with `prefer[]` (passRate >= 0.62), `avoid[]` (passRate <= 0.38, evidence >= 0.35), and confidence scores

The bias has 0.25 influence — it nudges the orchestrator's choice but does not override explicit user configuration.

## Consequences

- No external vector database, embedding API, or ML model required — pure statistics
- Memory persists via `FileAdapter` (JSON file). No SQLite dependency despite earlier plans
- The bias only activates with confidence >= 0.75 and evidence >= 3 similar observations for mode routing; confidence >= 0.65 for model preference
- Cold starts have no routing bias — the system falls back to configured defaults
- Every delegation outcome is recorded as an observation, building the empirical base
