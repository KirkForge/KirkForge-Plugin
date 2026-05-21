# Access control policy (starter)

This document describes a minimal access control posture for enterprise deployments.

## Roles (recommended)

- **Admin**: manage config/policy, tenant provisioning, key rotation, audit export
- **Operator**: view dashboards, restart services, view health, view audit
- **Developer**: run verification workflows within their tenant
- **Reader**: read-only access to status and results

## Authentication

- Prefer OIDC (JWT bearer tokens) for daemon endpoints.
- Service-to-service auth should use short-lived tokens.

## Authorization

- Enforce RBAC at every endpoint/tool boundary.
- Deny-by-default is the recommended posture.

## Audit

- All privileged actions must emit audit events:
  - policy changes
  - tenant provisioning
  - secret access
  - configuration changes

## Operational controls

- Require MFA at the IdP.
- Periodic access reviews.

> This is intentionally minimal and should be adapted to your org.
