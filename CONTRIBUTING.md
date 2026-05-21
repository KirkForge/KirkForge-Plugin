# Contributing to 55NDeep

## Commit Convention

Follow the rules in `REPORULES.md`. In short:

- Use **conventional commits**: `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`, `ci:`
- Breaking changes: add `!` after the type, e.g. `feat!: drop Node 18 support`
- No merge commits on PRs — rebase and squash.

## Pull Request Process

1. Fork the repo and create a feature branch from `master`.
2. Run `npm run ci` locally before pushing (build → typecheck → lint → test → adapter test).
3. Ensure new code is covered by tests (aim for 80%+ branch/line coverage on changed packages).
4. Update documentation if the public API (`packages/plugin/src/index.ts`) changes.
5. Add a changelog entry under the appropriate version header.
6. Open a PR against `master` with a descriptive title and body.
7. All CI checks must pass before merge.

## Development Setup

```bash
git clone https://github.com/KirkForge/55NDeep-plugin.git
cd 55NDeep-plugin
npm ci
npm run build
```

### Running Tests

```bash
npm test              # all 525+ tests
npm run test:coverage # with coverage
npm run test:adapter  # shell adapter smoke tests
npm run ci            # full CI gate
```

### Package Structure

See `README.md` for the full architecture diagram. Key packages:

- `packages/plugin/` — public API surface (`verifyWorkspace`, `doctor`, etc.)
- `packages/orchestrator/` — verification pipeline and state reduction
- `packages/correction-core/` — correction prompt generation
- `packages/memory-palace/` — routing memory and task observations
- `packages/core-*` — shared types, errors, config, secrets, telemetry, tenancy
- `packages/tool-*` — language-specific tool adapters
- `apps/cli/` — CLI entrypoint for standalone use

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
