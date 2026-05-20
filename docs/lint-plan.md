# 55NDeep Strict Lint — Implementation Plan

> **Status: ALL 3 PHASES COMPLETE** ✅ (2026-05-20)
> Replace all external linters with 55NDeep-owned strict lint engines.
> 3 phases, 8 languages, shared engine core, ~5,000 lines of new code.

## Overview

| Phase | Languages | Packages | Replaces | Rules |
|-------|-----------|----------|----------|-------|
| 1 | TypeScript, JavaScript | `tool-lint-core`, `tool-lint-ts` | ESLint | 29 ✅ |
| 2 | Python | `tool-lint-py` | Ruff, Bandit | 34 ✅ |
| 3 | Shell, C/C++, Rust, Go, SQL | `tool-lint-sh`, `tool-lint-c`, `tool-lint-rs`, `tool-lint-go`, `tool-lint-sql` | bash -n, (none) | ~46 ✅ |

**Kept**: tsc for type checking, gitnexus for git diff, graphify for import graphs.

---

## Architecture

```
packages/
├── tool-lint-core/         # shared engine
│   ├── src/
│   │   ├── engine.ts       # LintEngine class
│   │   ├── rules.ts        # Rule interface + registry
│   │   ├── walker.ts       # file walker
│   │   └── index.ts
│   └── tests/
├── tool-lint-ts/           # TS/JS rules
│   ├── src/
│   │   ├── rules/
│   │   │   ├── style.ts
│   │   │   ├── correct.ts
│   │   │   ├── safety.ts
│   │   │   ├── perf.ts
│   │   │   └── maintain.ts
│   │   └── index.ts
│   └── tests/
├── tool-lint-py/           # Python rules
├── tool-lint-sh/           # Shell rules
├── tool-lint-c/            # C/C++ rules
├── tool-lint-rs/           # Rust rules
├── tool-lint-go/           # Go rules
└── tool-lint-sql/          # SQL rules
```

**Deprecated** (removed after migration):
- `tool-eslint` — ESLint wrapper
- `tool-python` — Python tool wrappers

**Kept**:
- `tool-tsc` — TypeScript type checking
- `tool-gitnexus` — git diff
- `tool-graphify` — import graph
- `tool-secdev` — folded into language rule sets

---

## Shared Engine: `@55ndeep/tool-lint-core`

```ts
interface LintRule {
  id: string;
  category: "style" | "correct" | "safety" | "perf" | "maintain";
  severity: "critical" | "high" | "med" | "low" | "info";
  pattern: RegExp;
  message: string;
  languages: string[];
}

class LintEngine {
  constructor(opts: { cwd: string; eventBus?: EventBus; files?: string[] });
  addRule(rule: LintRule): void;
  addRules(rules: LintRule[]): void;
  async run(): Promise<LintResult>;
}

interface LintResult {
  source: string;
  status: "pass" | "error";
  errors: number;
  warnings: number;
  filesScanned: number;
  durationMs: number;
  details: LintFinding[];
}

interface LintFinding {
  file: string;
  line: number;
  rule: string;
  category: string;
  severity: string;
  message: string;
}
```

**Key design choices:**
- Regex-based scanning (like secdev) — fast, no AST dependency
- AST-aware where needed for import/export detection in TS phase 2
- Emits `verify.lint` events on EventBus
- Scannable extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`
- Excludes: `node_modules/`, `dist/`, `.git/`
- Max file size: 1MB (skip larger files)

---

## Phase 1: TypeScript / JavaScript Rules (`@55ndeep/tool-lint-ts`) ✅ IMPLEMENTED

### STYLE (8 rules)

| Rule | Pattern | Severity |
|------|---------|----------|
| no-var | `\bvar\s+` | high |
| prefer-const | `\blet\s+\w+\s*=` (with no reassignment check) | low |
| no-any | `:\s*any\b` | high |
| no-non-null-assert | `\w+!\.` | med |
| no-console | `console\.(log\|warn\|error\|debug)` | med |
| no-debugger | `\bdebugger\b` | med |
| no-alert | `\balert\(\|confirm\(\|prompt\(` | med |
| naming-convention | PascalCase for classes, camelCase for vars | low |
| max-params | function with >4 params | low |
| max-depth | nesting >4 levels | low |
| max-lines | file >200 lines | info |
| no-magic-numbers | unexplained numeric literals | low |

### CORRECT (10 rules)

| Rule | Pattern | Severity |
|------|---------|----------|
| no-eq-null | `[!=]= null` | high |
| no-unused-vars | declared but unreferenced | high |
| no-shadow | inner scope shadows outer | med |
| no-duplicate-imports | same module imported twice | med |
| no-unreachable | code after return/throw/break | high |
| no-fallthrough | case without break/return | med |
| no-unsafe-optional | `?.` on undefined | med |
| no-misused-promise | missing await on promise | high |
| no-return-await | `return await` (redundant) | low |
| no-throw-literal | `throw "string"` not `throw new Error()` | high |

### SAFETY (7 rules)

| Rule | Pattern | Severity |
|------|---------|----------|
| no-eval | `eval\(` | critical |
| no-implied-eval | `setTimeout\(['"]` | high |
| no-new-func | `new Function\(` | high |
| no-process-env | `process\.env\.` | med |
| no-dynamic-require | `require\(` with non-literal | med |
| no-unsafe-regex | ReDoS patterns `(a+)+` | med |
| no-assign-in-cond | `if (x = y)` | med |

### PERF (4 rules)

| Rule | Pattern | Severity |
|------|---------|----------|
| no-sync-in-async | `fs\.readFileSync` in async | med |
| prefer-array-methods | `for` loop over `.map`/`.filter` | low |
| no-unnecessary-spread | `[...arr].forEach` | low |
| no-large-array-literal | >100 elements inline | info |

### MAINTAIN (5 rules)

| Rule | Pattern | Severity |
|------|---------|----------|
| no-todo-fixme | `// TODO\|// FIXME` | info |
| no-dead-code | large commented-out blocks | low |
| require-jsdoc | exported functions without JSDoc | low |
| no-circular-imports | import cycle detection | high |
| prefer-early-return | deep nesting that could be early return | low |

---

## Phase 2: Python Rules (`@55ndeep/tool-lint-py`)

### STYLE (8 rules)

| Rule | Pattern | Severity |
|------|---------|----------|
| no-bare-except | `except:` | high |
| no-mutable-defaults | `def f(x=[])` | high |
| no-print | `print(` in module scope | med |
| naming-convention | snake_case vars, PascalCase classes | low |
| max-params | >4 params | low |
| max-lines | >200 lines | info |
| no-trailing-whitespace | `\s+$` | low |
| no-tabs | `\t` | low |

### CORRECT (7 rules)

| Rule | Pattern | Severity |
|------|---------|----------|
| no-undefined-var | AST check for undefined | high |
| no-unused-import | `import X` where X unused | med |
| no-unused-var | assigned but not used | med |
| no-redefined-outer | outer scope shadowed | med |
| no-duplicate-key | `{a:1, a:2}` | med |
| no-assert-on-tuple | `assert(x, y)` | high |
| no-incorrect-type-is | `type() ==` | med |

### SAFETY (8 rules)

| Rule | Pattern | Severity |
|------|---------|----------|
| no-eval | `eval(\|exec(` | critical |
| no-os-system | `os\.system(` | high |
| no-subprocess-shell | `subprocess.*shell=True` | high |
| no-pickle | `pickle\.loads(` | high |
| no-yaml-load | `yaml\.load(` | high |
| no-request-verify-false | `verify=False` | med |
| no-hardcoded-password | `password\s*=\s*['"]` | high |
| no-hardcoded-secret | extends secdev patterns | critical |

### PERF (4 rules)

| Rule | Pattern | Severity |
|------|---------|----------|
| no-range-len | `range(len(` | med |
| no-list-in-loop | `.append` in for loop | med |
| no-dict-keys-iterate | `.keys()` in for | low |
| no-string-concat-loop | `+=` on strings in loop | med |

### MAINTAIN (5 rules)

| Rule | Pattern | Severity |
|------|---------|----------|
| require-docstring | public functions without docstring | low |
| no-commented-code | large commented blocks | low |
| no-todo-fixme | `# TODO\|# FIXME` | info |
| prefer-pathlib | `os\.path` → `pathlib` | low |
| no-wildcard-import | `from X import *` | med |

---

## Phase 3: Shell, C/C++, Rust, Go, SQL

### Shell (`@55ndeep/tool-lint-sh`) — 10 rules

| Rule | Pattern | Severity |
|------|---------|----------|
| no-unquoted-vars | `$var` not in quotes | high |
| no-backticks | backtick command substitution | med |
| no-eval | `eval ` | critical |
| no-sudo | `sudo ` | med |
| no-curl-bash-pipe | `curl.*\| bash` | critical |
| no-unset-vars | `${var:?}` usage | med |
| require-shebang | missing `#!/bin/` | med |
| no-cd-fail | `cd` without error check | med |
| no-rm-rf-star | `rm -rf *` | critical |
| max-lines | >200 lines | info |

### C/C++ (`@55ndeep/tool-lint-c`) — 10 rules

| Rule | Pattern | Severity |
|------|---------|----------|
| no-gets | `gets(` | critical |
| no-strcpy | `strcpy(` | high |
| no-sprintf | `sprintf(` | high |
| no-system | `system(` | high |
| no-malloc-cast | `(int*)malloc(` | med |
| no-void-main | `void main(` | med |
| no-missing-include-guard | no `#ifndef` before `#define` | med |
| no-ternary-nest | nested ternary | med |
| no-goto | `goto ` | med |
| max-func-lines | >100 lines per function | low |

### Rust (`@55ndeep/tool-lint-rs`) — 8 rules

| Rule | Pattern | Severity |
|------|---------|----------|
| no-unwrap | `.unwrap()` | high |
| no-expect-in-prod | `.expect(` | med |
| no-unsafe | `unsafe {` | high |
| no-clone-on-copy | `.clone()` on Copy types | low |
| no-println-in-lib | `println!` in library | med |
| no-todo | `todo!()` | info |
| no-dbg | `dbg!()` | low |
| max-params | >4 params | low |

### Go (`@55ndeep/tool-lint-go`) — 7 rules

| Rule | Pattern | Severity |
|------|---------|----------|
| no-naked-return | `return` with named returns | med |
| no-panic | `panic(` | high |
| no-global-var | package-level `var` | med |
| no-init-side-effect | `func init()` with side effects | med |
| no-unhandled-error | `val, _ :=` | high |
| no-defer-in-loop | `defer` in for loop | med |
| no-string-title | `strings.Title` | low |

### SQL (`@55ndeep/tool-lint-sql`) — 6 rules

| Rule | Pattern | Severity |
|------|---------|----------|
| no-select-star | `SELECT *` | med |
| no-implicit-join | `FROM a, b WHERE a.id = b.id` | med |
| no-drop-table | `DROP TABLE` | critical |
| no-truncate | `TRUNCATE` | critical |
| no-unsafe-delete | `DELETE FROM.*without WHERE` | high |
| no-dynamic-sql-injection | `\$\{.*\}.*SELECT\|INSERT` | critical |

---

## Implementation Order

| Step | Task | Session |
|------|------|---------|
| 1 | Build `@55ndeep/tool-lint-core` shared engine | 1 ✅ |
| 2 | Build `@55ndeep/tool-lint-ts` 29 rules | 1 ✅ |
| 3 | Wire into emitter-factory, replace ESLint | 1 ✅ |
| 4 | Build `@55ndeep/tool-lint-py` 34 rules | 1 ✅ |
| 5 | Wire Python lint, deprecate Ruff+Bandit | 1 ✅ |
| 6 | Build Phase 3 packages (Shell, C, Rust, Go, SQL) | 2 ✅ |
| 7 | Tests for all 8 lint packages (30 new tests) | 3 ✅ |
| 8 | Clean up, finalize tests, update docs | 3 ✅ |
| **Total** | | **~14** |

## Migration (All Complete ✅)

1. ✅ Build `tool-lint-core`
2. ✅ Migrate `tool-secdev` rules into language rule sets
3. ✅ Build `tool-lint-ts` → remove `tool-eslint`
4. ✅ Build `tool-lint-py` → remove `tool-python`
5. ✅ Build remaining 5 packages (Shell, C/C++, Rust, Go, SQL)
6. ✅ Keep `tool-tsc` for type checking
7. ✅ Keep `tool-gitnexus`, `tool-graphify` for git/graph domains
8. ✅ Full test coverage: 8 packages, 30+ tests across all languages
9. ✅ `emitter-factory.ts` routes all 8 languages through native engines
