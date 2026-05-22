# Runbook: Missing External Tool

## Symptom

- `doctor()` reports a tool as unavailable
- Verification returns partial results
- Logs show `execFile` ENOENT errors for eslint/tsc/ruff/etc.

## Diagnosis

```bash
which eslint tsc ruff pyright bandit git
```

## Resolution

1. Install the missing tool in the container/VM:
   ```bash
   npm install -g eslint typescript
   pip install ruff pyright bandit
   ```
2. Rebuild the Docker image if using containerized deployment:
   ```bash
   docker build -t 55ndeep .
   ```
3. Verify with:
   ```bash
   npm run cli -- doctor
   ```

## Prevention

- CI matrix tests against real tooling (see `e2e/smoke.test.ts`)
- Dockerfile includes eslint + tsc in build stage
