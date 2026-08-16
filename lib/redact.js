/**
 * Conservative default redactor for captured process stdout/stderr and for
 * the final text bridges return to the model.
 *
 * Ported from task-weaver `packages/agent-runtime/src/redact.ts` (57 lines,
 * zero dependencies, pure string operations) — logic-equivalent, TypeScript
 * types stripped for this plain-JS ESM repo. Upstream name:
 * `defaultProcessRedactor`; renamed `redactText` to match this repo's verb
 * style (call sites read `redactText(chunk)`).
 *
 * Why a built-in catalog (upstream comment, preserved): agent-runtime must
 * not depend on testkit — this is a small catalog of common secret shapes
 * (API keys, `sk-…`, Bearer tokens, PATs, JWTs). task-weaver redacts BEFORE
 * anything is buffered or parsed ("redaction happens before the parser
 * sink"); this port applies the same rule at lib/run.js's capture path and
 * at each bridge's final-text boundary, so a secret printed by a product CLI
 * never leaks into the conversation context.
 *
 * Known trade-off (inherited from upstream): the patterns match token-shaped
 * runs wherever they appear, including INSIDE a JSONL line — a line whose
 * own keys look secret-shaped (`{"api_key": "…"}`) can be structurally
 * corrupted by the replacement and then fails to parse. That is deliberate:
 * unparsable evidence is dropped or surfaced redacted, never passed through
 * raw (fail closed, not secret-passthrough).
 */

/**
 * One secret shape: a stable `kind` (used in the placeholder) and the match
 * pattern. Order matters: more specific / multi-token forms first so a
 * Bearer header is scrubbed before a nested JWT fragment is re-matched.
 */
export const DEFAULT_PROCESS_REDACTOR_PATTERNS = Object.freeze([
  Object.freeze({
    kind: 'bearer',
    pattern: /Bearer\s+[A-Za-z0-9._\-+/=]+/gi,
  }),
  Object.freeze({
    kind: 'openai_key',
    pattern: /sk-[A-Za-z0-9_-]{16,}/g,
  }),
  Object.freeze({
    kind: 'github_pat',
    pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g,
  }),
  Object.freeze({
    kind: 'api_key',
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*["']?[^\s"']{8,}/gi,
  }),
  Object.freeze({
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  }),
])

const placeholder = (kind) => `[REDACTED:${kind}]`

/**
 * Replace common secret shapes in `text` with `[REDACTED:<kind>]`
 * placeholders. Safe as a default for process retention — never
 * identity-passthrough.
 *
 * Idempotent: the placeholders themselves never match any later pattern, so
 * re-running on already-redacted text is a no-op.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactText(text) {
  let out = text
  for (const { kind, pattern } of DEFAULT_PROCESS_REDACTOR_PATTERNS) {
    // Fresh RegExp per pass so sticky/global `lastIndex` never leaks across calls.
    const re = new RegExp(pattern.source, pattern.flags)
    out = out.replace(re, placeholder(kind))
  }
  return out
}
