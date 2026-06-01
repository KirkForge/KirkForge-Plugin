# Migration Guide

## API Versioning

KirkForge uses URL-path versioning for its HTTP API. All routes are available under:

- `/v1/` — Current stable API (v1.x)
- Root paths (`/healthz`, `/readyz`, `/metrics`) — Legacy compat (v0.x)

### v1 Routes

| Endpoint           | Method | Description                    |
| ------------------ | ------ | ------------------------------ |
| `/v1/healthz`      | GET    | Liveness check                 |
| `/v1/readyz`       | GET    | Readiness check                |
| `/v1/metrics`      | GET    | Prometheus text-format metrics |
| `/v1/metrics/json` | GET    | JSON metrics (legacy format)   |

### v0 → v1 Migration

**Health checks (v0 → v1):**

- `GET /healthz` → `GET /v1/healthz` (identical response format)
- `GET /readyz` → `GET /v1/readyz` (identical response format)

**Metrics (v0 → v1):**

- `GET /metrics` (JSON) → `GET /v1/metrics/json`
- NEW: `GET /v1/metrics` (Prometheus text format)

**Breaking changes in v1:**

- Security headers added on all responses (CSP, X-Frame-Options, etc.)
- W3C `traceparent`/`traceresponse` headers propagated
- Auth is now Bearer-token only (no API key query param)

## Plugin API (npm)

The `@kirkforge/plugin` package follows semantic versioning:

- **Patch (1.0.x)**: Bug fixes, no API changes
- **Minor (1.x.0)**: New features, backward-compatible
- **Major (x.0.0)**: Breaking API changes

### Deprecation Policy

- Deprecated APIs emit warnings for 2 minor releases
- Removed on the next major release
- Check `changelog.md` for deprecation notices

### Upgrading from v0 to v1

1. Update workspace deps from `*` to `^1.0.0`
2. `MemoryStore` now requires `backend` option (default: `"memory"`)
3. `verifyWorkspace` now returns `Result<ReducedStatePacket, Error>` instead of raw packet
4. `recordObservation` requires explicit `MemoryStore` parameter

## Helm Chart

### v1.0.0 → v1.1.0

- `securityContext.readOnlyRootFilesystem` changed from `false` to `true`
- Added `/tmp` `emptyDir` volume for runtime scratch space
- Added `auth.apiKey` field for health endpoint auth

### Upgrade steps

```bash
helm upgrade kirkforge ./deploy/helm/kirkforge \
  --set image.tag=v1.1.0 \
  --set auth.apiKey=$(openssl rand -hex 32)
```
