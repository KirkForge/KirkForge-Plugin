# Host Integration Examples

Minimal post-generation hooks for three host CLIs. Each follows the same contract:

1. Host writes files to workspace
2. Hook calls `55ndeep verify-workspace` on the workspace
3. If verification fails, hook emits a correction prompt on stdout
4. Host reads the correction prompt and feeds it back into its model loop
5. After the task resolves, hook records the **host-provided** task outcome via `55ndeep observe`

**These are examples, not installed plugins.** Copy, adapt, and integrate into your host's hook system.

## Files

| Sketch | Host | Notes |
|--------|------|-------|
| `55ndeep-openai-codex-hook.sh` | OpenAI Codex CLI | Codex writes files, then shells out to this hook |
| `55ndeep-opencode-hook.sh` | OpenCode | Node-based CLI; config shown as YAML template |
| `55ndeep-claude-code-hook.sh` | Claude Code | Anthropic's CLI; hook config shown as JSON template |

## Common contract

All three sketches share the same invariants:

- **`--outcome` is host-provided.** The host decides whether the task passed, failed, or escalated. The verifier only checks code quality. Recording verifier status as task outcome poisons routing memory.
- **stdout is the correction prompt.** Hosts read stdout to inject the prompt back into the model loop.
- **stderr is diagnostics.** `[55ndeep]` prefixed status lines go to stderr.
- **Exit 0** = verification completed and observation recorded. Exit 1 = missing dependency, invalid args, or CLI failure.

## Required arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `--workspace` | yes | Project root to verify |
| `--task-id` | yes | Correlation ID |
| `--task-desc` | yes | What the task asked for |
| `--outcome` | yes | `pass`, `fail`, or `escalate` — provided by the host |
| `--memory` | yes | Path to memory store file |
| `--language` | no | Defaults to `typescript` |
| `--model` | no | Worker model name |
| `--elapsed-ms` | no | Wall-clock time, defaults to `0` |

## Requirements

- `55ndeep` CLI in PATH
- `jq` in PATH

## See also

- [shell-adapter/](../shell-adapter/) — Generic adapter with full arg validation and contract tests
- [PLUGIN_CLI_CONTRACT.md](../../docs/PLUGIN_CLI_CONTRACT.md) — Full command reference
- [PLUGIN_STRATEGY.md](../../docs/PLUGIN_STRATEGY.md) — Product boundary and API design