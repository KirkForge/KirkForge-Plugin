# KirkForge Shell Adapter Example

A runnable shell script demonstrating the KirkForge plugin CLI contract.

## What it does

1. Verifies a workspace directory using `kirkforge verify-workspace`
2. If verification reports any issues, builds a correction prompt using `kirkforge prompt`
3. Records the task outcome using `kirkforge observe`

No model calls. Entirely deterministic.

## Requirements

- `kirkforge` CLI installed and in `PATH`
- `jq` installed and in `PATH`

## Usage

```sh
kirkforge-post-generation.sh \
  --workspace /path/to/project \
  --task-id task-1234 \
  --task-desc "fix auth bug" \
  --language typescript \
  --mode hard-prompt \
  --model gpt-4 \
  --outcome pass \
  --memory ./kirkforge-memory.json \
  --elapsed-ms 5000
```

## Arguments

| Argument       | Required | Description                                                                                                  |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `--workspace`  | yes      | Path to the project root to verify                                                                           |
| `--task-id`    | yes      | Task identifier for correlation                                                                              |
| `--task-desc`  | yes      | Natural-language task description                                                                            |
| `--language`   | yes      | Language hint (typescript, python, etc.)                                                                     |
| `--mode`       | yes      | Delegation mode (hard-prompt, ts-contract, artifact)                                                         |
| `--model`      | yes      | Worker model used for this task                                                                              |
| `--outcome`    | yes      | Task outcome: `pass`, `fail`, or `escalate`. Must be provided by the host, not derived from verifier status. |
| `--memory`     | yes      | Path to the memory store file                                                                                |
| `--elapsed-ms` | no       | Wall-clock time in milliseconds (defaults to 0)                                                              |

## Stdout contract

- **When verification passes**: nothing on stdout (silent success).
- **When verification fails/warns**: the correction prompt text on stdout.
- **All diagnostics** go to stderr.

The host should read stdout for the correction prompt and feed it back into its model loop. This is not an installed integration for any specific host; it is a contract-conforming shell adapter that any host CLI can invoke.

**Why `--outcome` is host-provided**: Verifier pass/fail measures whether the code passes lint, types, and security checks. It does not measure whether the task the user asked for is actually complete. Only the host knows whether the task succeeded. Recording verifier status as task outcome would poison routing memory with false positives.

## Exit codes

| Code | Meaning                                                                                  |
| ---- | ---------------------------------------------------------------------------------------- |
| 0    | Verification completed; observation recorded. Check stdout for correction prompt if any. |
| 1    | Missing dependency, missing required argument, or CLI command failure.                   |

## Testing

```sh
npm run test:adapter
```

Or directly:

```sh
bash examples/shell-adapter/test-adapter.sh
```

Contract tests validate: missing dependency detection, argument validation, `--outcome` enum enforcement, stdout/stderr separation, and host-provided outcome propagation.

## See also

- [PLUGIN_CLI_CONTRACT.md](../../docs/PLUGIN_CLI_CONTRACT.md) — Full command reference
- [PLUGIN_STRATEGY.md](../../docs/PLUGIN_STRATEGY.md) — Product boundary and API design
