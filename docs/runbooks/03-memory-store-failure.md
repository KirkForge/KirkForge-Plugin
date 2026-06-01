# Runbook: Memory Store Failure

## Symptom

- `recordObservation()` returns errors
- `recallRoutingBias()` returns null unexpectedly
- Logs show filesystem or write errors in memory-palace

## Diagnosis

1. Check PVC status:
   ```bash
   kubectl get pvc
   ```
2. Check disk usage:
   ```bash
   kubectl exec deploy/kirkforge -- df -h /app/.kirkforge
   ```
3. Check pod events:
   ```bash
   kubectl describe pod -l app.kubernetes.io/name=kirkforge
   ```

## Resolution

1. If PVC is full: increase `persistence.size` in Helm values and apply.
2. If PVC is pending: check storage class availability.
3. If using memory backend (no PVC): data is ephemeral; restart pod to clear corrupted state:
   ```bash
   kubectl rollout restart deploy/kirkforge
   ```

## Prevention

- Set up PVC usage alerts (80% threshold)
- Enable TTL eviction on MemoryStore
- Use SQLite/Postgres backend for production (more resilient than file)
