// examples/verify-broken-repo/src/bugs.ts
// Three intentional defects used by the end-to-end demo:
//
//   1. Type error: assigning a string to a number-typed variable.
//      tsc will emit error TS2322.
//
//   2. Lint violation: `eval` in safety category. The KirkForge TS
//      lint engine (tool-lint-core) has a "no-eval" rule under category
//      "safety" / severity "critical" — and that finding is forwarded
//      to verify.security, so the security slot fails too.
//
//   3. Graph broken edge: importing from "./does-not-exist" — the
//      Graphify emitter will report a broken import edge.

export const count: number = "this is a string, not a number"; // (1) type error

export function runUserCode(input: string): unknown {
  // (2) no-eval safety violation
  return eval(input);
}

export { somethingMissing } from "./does-not-exist.js"; // (3) broken graph edge
