# Benchmark Methodology

This document defines the methodology, versioning, and evidence standards
for 55NDeep benchmarks. It distinguishes between **infrastructure smoke
tests** (which validate that tools run at all) and **product performance
claims** (which make assertions about verification quality, latency, or
accuracy under controlled conditions).

## Scope

All benchmark results cited in documentation, ADRs, or marketing must follow
this methodology. Results that do not meet these standards must be labeled as
**preliminary**, **infrastructure smoke**, or **anecdotal** — never as product
performance claims.

## Definitions

| Term                           | Definition                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **Benchmark version**          | A tagged release of the benchmark harness and task panel. Format: `bench/v1.0.0`.                                                |
| **Task panel**                 | A fixed, versioned set of verification tasks with known expected outcomes.                                                       |
| **Infrastructure smoke**       | A test that validates tools run, configurations parse, and pipelines execute — but does not make accuracy or performance claims. |
| **Product performance**        | A benchmark that measures pass rate, latency, cost, or failure modes against a versioned task panel with statistical confidence. |
| **Negative evidence**          | Tasks where the expected outcome is "fail" (intentional bugs, security vulnerabilities, or type errors).                         |
| **Deterministic verification** | A verification mode where the same inputs produce the same pass/fail outcome regardless of the model used for generation.        |

## Methodology Standards

### 1. Versioning

Every benchmark run must reference:

- **Benchmark version**: `bench/vX.Y.Z`
- **55NDeep version**: Git commit SHA or release tag
- **Task panel version**: `panel/vX.Y.Z`
- **Date**: ISO 8601
- **Environment**: Hardware specs, OS, Node version

### 2. Task Panel

The task panel is a fixed set of verification tasks, each with:

- A unique task ID
- A description
- An expected outcome (pass/fail)
- A language
- A validator command
- A classification (positive/negative evidence)

Task panels must include at least 20% negative evidence (tasks expected to fail).

### 3. Statistical Confidence

Product performance claims must report:

- **Sample size**: Number of tasks in the panel
- **Pass rate**: With 95% confidence interval
- **Latency**: p50, p95, p99
- **Cost**: Tokens consumed (if applicable)
- **Failure modes**: Categorized by type (validator missing, tool error, etc.)

No claim should be made from a sample size of fewer than 30 tasks.

### 4. Reproducibility

Benchmark runs must be reproducible:

- All task files, validator commands, and configurations are committed to the repository
- The benchmark harness is idempotent (same input → same output)
- Results include the exact command used to run the benchmark

### 5. Negative Evidence

Benchmarks must include **negative evidence**:

- Tasks with known bugs that should fail verification
- Security vulnerabilities that should be detected
- Type errors that should cause verification failure
- Missing validators that should produce warnings

Negative evidence prevents the benchmark from being gamed by a system that
always reports "pass."

### 6. Infrastructure Smoke vs. Product Performance

| Aspect            | Infrastructure Smoke    | Product Performance              |
| ----------------- | ----------------------- | -------------------------------- |
| Purpose           | Validate that tools run | Measure accuracy and performance |
| Panel size        | 3–5 tasks               | ≥30 tasks (≥6 negative)          |
| Statistical rigor | None required           | 95% CI required                  |
| Claim level       | "Tools execute"         | "Pass rate ≥ X%"                 |
| Versioning        | Not required            | Required                         |
| Negative evidence | Not required            | ≥20% of panel                    |

### 7. Regression Guardrails

CI should include a regression guard:

- Run the full task panel on every PR
- Alert if pass rate drops below the established baseline
- Alert if latency p95 exceeds 2x baseline
- Block merge on regression unless explicitly overridden

## Reporting Template

```markdown
## Benchmark Report: bench/vX.Y.Z

- **55NDeep version**: commit SHA / release tag
- **Task panel**: panel/vX.Y.Z
- **Date**: YYYY-MM-DD
- **Environment**: [hardware, OS, Node version]

### Results

| Metric        | Value | 95% CI |
| ------------- | ----- | ------ |
| Pass rate     | X%    | ±Y%    |
| Latency p50   | Xms   | —      |
| Latency p95   | Xms   | —      |
| Latency p99   | Xms   | —      |
| Cost (tokens) | X     | —      |

### Failure Modes

| Category          | Count | Percentage |
| ----------------- | ----- | ---------- |
| Validator missing | X     | Y%         |
| Tool error        | X     | Y%         |
| False positive    | X     | Y%         |
| False negative    | X     | Y%         |

### Negative Evidence

| Task ID | Expected | Actual | Correct? |
| ------- | -------- | ------ | -------- |
| neg-001 | fail     | fail   | ✓        |
| neg-002 | fail     | pass   | ✗        |

### Version Trend

| Version | Pass Rate | p95 Latency | Date       |
| ------- | --------- | ----------- | ---------- |
| v1.0.0  | X%        | Yms         | 2026-XX-XX |
| v1.1.0  | X%        | Yms         | 2026-XX-XX |
```

## Re-benchmarking Procedure

1. Make no code changes to the path under test.
2. Run the benchmark suite 3 times on the target hardware.
3. Record median p50/p95/p99 and throughput values.
4. Update `docs/load-test-baseline.md` with the new baselines.
5. Update SLO constants in test files if thresholds need adjustment.
6. Commit results with the benchmark version tag.

## Existing Caveats

Some earlier benchmark runs were **infrastructure smoke tests** with skipped
validators. These are valid for confirming tool availability but must not be
cited as product performance claims. When referencing older results, label
them explicitly as "infrastructure smoke" and link to this methodology document.

## Last Updated

- **Date**: 2026-05-27
- **Author**: Enterprise readiness review
