# ADR 001: Deterministic verification outside the model

## Status

Accepted

## Date

2026-05-13

## Context

AI-generated code is unreliable. Common approaches — recursive prompting, "reflection loops," LLM self-evaluation — add cost without adding trust. Another LLM validating an LLM is not materially better than the original generation.

## Decision

Run a battery of deterministic external tools on AI-generated output. No LLM in the verification path. The tool battery consists of:

- **Lint**: ESLint (TypeScript/JavaScript) or Ruff (Python) — catches syntax violations, unused variables, structural errors
- **Types**: tsc (TypeScript/JavaScript) or Pyright (Python) — catches type errors the model hallucinated
- **Security**: Secdev (regex-based secret scanning) or Bandit (Python AST scanner) — catches hardcoded keys, eval(), shell injection
- **Git diff**: Gitnexus — records what files changed, insertion/deletion counts
- **Import graph**: Graphify (TypeScript-only) — detects broken import edges and cycles

## Consequences

- Verification is objective and reproducible — same input produces same verdict every time
- No token cost for verification — all tools run locally
- The verifier battery can disagree with reality (TypeScript tsc can't validate Python code). Language-aware routing in emitter-factory.ts handles this.
- Graphify is TypeScript-only. Non-TS files get `skipped`, not `fail`.
- The approach is deliberately narrow and tool-focused, not a general-purpose evaluation framework
