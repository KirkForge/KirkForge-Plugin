# Runbook: Circuit Breaker Trip

## Symptom

- Worker model calls fail repeatedly
- Logs show `CircuitBreaker OPEN` or `half-open → open` transitions
- Orchestrator returns errors after repeated timeouts

## Diagnosis

1. Check provider API status:
   - OpenAI: https://status.openai.com
   - Anthropic: https://status.anthropic.com
2. Check API key validity:
   ```bash
   curl -s -H "Authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/models | jq .error
   ```
3. Check network connectivity from the pod:
   ```bash
   kubectl exec deploy/55ndeep -- curl -s -o /dev/null -w "%{http_code}" https://api.openai.com/v1/models
   ```

## Resolution

1. If provider is down: wait for recovery. Circuit breaker auto-resets after cooldown (default 30s).
2. If API key expired: rotate key via Vault/AWS Secrets Manager, update the secret:
   ```bash
   kubectl delete secret 55ndeep-secret
   helm upgrade 55ndeep ./deploy/helm/55ndeep --set auth.apiKey=$NEW_KEY
   ```
3. If rate-limited: reduce `orchestrator.maxConcurrent` in Helm values.

## Prevention

- Set up provider status monitoring alerts
- Configure API key rotation automation
- Use multiple provider fallbacks (OpenAI + Anthropic + Ollama)
