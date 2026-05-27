# 55NDeep Service Level Agreement Definitions

This document defines the SLAs for 55NDeep enterprise deployments. These SLAs
apply to the **managed service** layer; self-hosted deployments should adjust
targets based on their infrastructure.

## Availability

| Metric                  | Target | Measurement              | Window         |
| ----------------------- | ------ | ------------------------ | -------------- |
| Service availability    | 99.9%  | Health endpoint checks   | Rolling 30-day |
| Health check latency    | <1s    | `/healthz` response time | p99            |
| Readiness check latency | <500ms | `/readyz` response time  | p99            |

## Verification Latency

| Operation                    | SLO Target | Measurement | Notes                             |
| ---------------------------- | ---------- | ----------- | --------------------------------- |
| Single-file verification     | <5s        | p95         | Depends on validator availability |
| Full-workspace verification  | <30s       | p95         | Up to 100 files                   |
| Correction prompt generation | <2s        | p95         | Single packet                     |
| Memory recall                | <200ms     | p99         | Up to 1000 observations           |
| Memory write                 | <100ms     | p99         | Single observation                |

## Authentication & Authorization

| Metric                     | Target | Measurement   | Notes                       |
| -------------------------- | ------ | ------------- | --------------------------- |
| JWT validation latency     | <50ms  | p99           | Including JWKS fetch        |
| API key validation latency | <5ms   | p99           | Timing-safe comparison      |
| RBAC check latency         | <1ms   | p99           | In-memory permission lookup |
| Auth failure rate          | <1%    | 7-day rolling | Excluding invalid tokens    |

## Audit Trail

| Metric                   | Target | Measurement   | Notes                                        |
| ------------------------ | ------ | ------------- | -------------------------------------------- |
| Audit write success rate | 99.9%  | 7-day rolling | Critical SLA                                 |
| Audit write latency      | <100ms | p99           | File sink                                    |
| Chain integrity          | 100%   | Continuous    | Tamper detection must be zero-false-positive |
| WORM segment rotation    | <1s    | p99           | Automatic rotation at 100MB                  |

## Policy Engine

| Metric                     | Target | Measurement   | Notes                                    |
| -------------------------- | ------ | ------------- | ---------------------------------------- |
| Policy check latency       | <10ms  | p99           | In-memory policy lookup                  |
| Policy deny rate           | <5%    | 7-day rolling | Some denials are expected (bad requests) |
| Signed bundle verification | <50ms  | p99           | HMAC-SHA256                              |
| Policy reload latency      | <5s    | p99           | Hot-reload of policy file                |

## Multi-Tenancy

| Metric                       | Target | Measurement   | Notes                                |
| ---------------------------- | ------ | ------------- | ------------------------------------ |
| Tenant isolation             | 100%   | Continuous    | Zero cross-tenant leakage events     |
| Per-tenant quota enforcement | 100%   | Continuous    | Quota checks must never be bypassed  |
| Rate limit accuracy          | >99%   | 7-day rolling | Within 1% of configured limit        |
| Tenant context propagation   | 100%   | Continuous    | All audit events must carry tenantId |

## Sandboxed Execution

| Metric                     | Target | Measurement   | Notes                                  |
| -------------------------- | ------ | ------------- | -------------------------------------- |
| Sandbox escape rate        | 0%     | Continuous    | No escape events tolerated             |
| Timeout enforcement        | 100%   | Continuous    | All processes killed within maxTimeMs  |
| Output truncation accuracy | >99%   | 7-day rolling | Truncation within 5% of maxOutputBytes |
| Docker container cleanup   | 100%   | Continuous    | No orphaned containers after execution |

## Data Durability

| Metric                         | Target | Measurement   | Notes                                   |
| ------------------------------ | ------ | ------------- | --------------------------------------- |
| Memory store write durability  | 99.9%  | 7-day rolling | SQLite backend                          |
| Memory store read availability | 99.95% | 7-day rolling |                                         |
| Audit log durability           | 99.99% | 7-day rolling | WORM sink with fsync                    |
| Configuration backup           | Daily  | Scheduled     | Automated backup of policy, RBAC config |

## Incident Response

| Metric                      | Target           | Measurement                  | Notes            |
| --------------------------- | ---------------- | ---------------------------- | ---------------- |
| Security incident detection | <15min           | From audit event to alert    | SIEM integration |
| Security incident response  | <4hr             | From detection to mitigation | P1 incidents     |
| Data breach notification    | <72hr            | Per regulatory requirement   | GDPR, CCPA       |
| Post-incident review        | <5 business days | Root cause and remediation   |                  |

## Escalation Matrix

| Severity | Description                               | Response Time | Resolution Target |
| -------- | ----------------------------------------- | ------------- | ----------------- |
| P0       | Service outage, data breach               | <15 min       | <4 hr             |
| P1       | Single-tenant impact, auth failure        | <1 hr         | <8 hr             |
| P2       | Performance degradation, partial features | <4 hr         | <24 hr            |
| P3       | Non-critical bug, feature request         | <24 hr        | Next release      |

## Measurement Methodology

1. **Availability**: Calculated as `(total_minutes - downtime_minutes) / total_minutes × 100`
2. **Latency percentiles**: Measured from the server-side, excluding network latency
3. **Error rates**: Calculated as `failed_requests / total_requests × 100`
4. **Audit trail**: Integrity verified hourly via `WormAuditSink.verifyIntegrity()`
5. **SLA compliance**: Reported monthly, with 30-day rolling windows

## Exclusions

- Force majeure events
- Scheduled maintenance windows (announced ≥24h in advance)
- Customer-caused misconfiguration
- Third-party provider outages (OIDC provider, cloud provider)

## Last Updated

- **Date**: 2026-05-27
- **Review cycle**: Quarterly
- **Next review**: 2026-08-27
