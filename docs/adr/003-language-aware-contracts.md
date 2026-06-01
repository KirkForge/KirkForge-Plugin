# ADR 003: Language-aware emission contracts

## Status

Accepted

## Date

2026-05-13

## Context

Early versions used a single hardcoded TypeScript-shaped contract template for all tasks. The `### FILE: path` / `### END` artifact format was universal. But the system supports 10 languages (TypeScript, JavaScript, Python, Shell, C++, C, Rust, Go, SQL, text). A TypeScript-flavored prompt template confuses Python workers — they see `output.ts`, TypeScript wrappers, JS-style imports, and produce wrong artifacts.

## Decision

Each language gets its own native-feeling emission contract:

1. **Artifact mode** — the `### FILE:` / `### END` markers remain universal, but the prompt's `{{languageHint}}`, `{{defaultFile}}`, and `{{checkCommand}}` variables are populated from the detected task profile
2. **Contract mode** (ts-contract) — `buildContractTemplate(language, hint)` generates a language-specific contract that asks for language-specific findings, idioms, and conventions
3. **Correction prompts** — `toolNames(language)` in `@kirkforge/correction-core` substitutes the correct tool names (ruff/pyright/bandit for Python, eslint/tsc/secdev for TypeScript)
4. **Verifier selection** — `emitter-factory.ts` routes Python files to ruff/pyright/bandit, TypeScript/JavaScript to eslint/tsc/secdev
5. **Graphify** — only runs on TypeScript/TypeScript JSX files. Non-TS files receive `"skipped"` status with zero errors

## Consequences

- 10 languages are supported through a single `detectTaskProfile()` function with regex-based classification
- Default language is TypeScript — any unrecognized task gets the TypeScript profile
- The `TaskLanguage` union type is the authoritative list of supported languages (defined in `@kirkforge/correction-core`)
- `TaskProfile` and `detectTaskProfile()` live in the orchestrator; the `TaskLanguage` type itself is in `@kirkforge/correction-core`
- Language detection is static (regex matching on task description). Dynamic detection (by actual file extension inspection) happens in emitters as a fallback
