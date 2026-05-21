# Incident response (starter)

This is a minimal incident response playbook for enterprise deployments.

## Severity levels

- **SEV1**: Active security incident, data exposure, sustained outage
- **SEV2**: Partial outage, elevated error rates, suspected abuse
- **SEV3**: Degraded performance, non-urgent bugs

## First 30 minutes checklist

1. **Stabilize**: reduce blast radius
   - Disable risky features (policy: deny-by-default)
   - Reduce concurrency / apply quotas
   - If necessary, take the service read-only
2. **Preserve evidence**
   - Snapshot logs/audit events
   - Record time window + affected tenants
3. **Communicate**
   - Start an incident channel
   - Assign incident commander + scribe
4. **Triage**
   - Identify: auth failures? quota saturation? storage corruption?

## Common incident types

### Auth / token validation failures
- Check OIDC config (issuer/audience/JWKS)
- Verify clock skew and token expiry

### Storage corruption / memory write failures
- Switch to read-only mode if possible
- Restore from backup
- Run integrity check tool (to be implemented)

### Quota saturation / noisy neighbor
- Identify tenant causing saturation
- Apply stricter per-tenant caps
- Confirm metrics: blocked_count, queue depth

### Suspected data leakage
- Immediately isolate tenant namespaces
- Rotate keys/secrets
- Export and preserve audit trail

## Post-incident

- Root cause analysis
- Action items with owners and dates
- Add tests and regression gates

> This document should evolve into an org-specific runbook.
