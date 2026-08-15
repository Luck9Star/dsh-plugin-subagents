// Cross-platform syntax check: `node --check` every module, then enforce the
// `@deepseek-ai/dsh-subagent` pure-function import whitelist (red line 12,
// DESIGN §6.4.4 / §9 / T20).
//
// The old `for f in …; do …; done` lint script was POSIX-shell syntax that
// cmd.exe cannot run, which broke `npm run lint` on Windows CI.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))

// Red line 12: imports from `@deepseek-ai/dsh-subagent` are forever restricted
// to these pure functions (parameter validation + result normalization — no
// module state, no Symbol identity). Test fakes that import the package are
// bound by the same whitelist, so no exception is carved out for test/.
export const WHITELIST = ['assertSubagentMaxDepth', 'settleRun']
const PACKAGE = '@deepseek-ai/dsh-subagent'

// One named import statement: `import { specifiers } from "@…/dsh-subagent"`.
// `[^}]*` spans the brace content across newlines (multi-line imports); the
// module specifier is matched by a permissive run up to the closing quote so
// single- and double-quoted specifiers both work.
const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*['"]@deepseek-ai\/dsh-subagent['"]/g

// Namespace import form — `import * as ns from "@…/dsh-subagent"`. Red line 12's
// whitelist is a set of NAMED pure functions; a namespace import smuggles the
// whole module (module state + Symbol identity) past the brace regeg, so this
// shape is an unconditional violation (never in whitelist semantics). Non-brace
// namespace imports from OTHER modules stay legal (the regex is anchored to the
// package).
const NAMESPACE_RE = /import\s*\*\s*as\s+(\w+)\s*from\s*['"]@deepseek-ai\/dsh-subagent['"]/g

// Iterate every explicit `from '@deepseek-ai/dsh-subagent'` named import in a
// single source string and return each offending symbol as a line/col entry.
// Handles both single-line (`import { a } from …`) and multi-line
// (`import {\n  a,\n  b,\n} from …`) forms; `import * as ns` without braces is
// not matched here and is flagged separately by NAMESPACE_RE below.
export function checkWhitelist(sources) {
  const violations = []
  for (const file of Object.keys(sources)) {
    const src = sources[file]
    let m
    IMPORT_RE.lastIndex = 0
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const symbols = m[1]
        .split(',')
        .map((s) => s.trim())
        // drop empty/whitespace entries from a trailing comma
        .filter(Boolean)
        .map((s) => s.split(/\s+as\s+/)[0].trim()) // `a as b` -> `a`
      for (const symbol of symbols) {
        if (!WHITELIST.includes(symbol)) {
          // Offset the whole match to report the import's line.
          const before = src.slice(0, m.index)
          const line = (before.match(/\n/g) || []).length + 1
          violations.push({ file, line, symbol })
        }
      }
    }
    // Namespace imports of the package are always violations.
    NAMESPACE_RE.lastIndex = 0
    while ((m = NAMESPACE_RE.exec(src)) !== null) {
      const before = src.slice(0, m.index)
      const line = (before.match(/\n/g) || []).length + 1
      violations.push({ file, line, symbol: m[1] })
    }
  }
  return violations
}

function walk(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p, files)
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      files.push(p)
    }
  }
}

function run() {
  // 1. Syntax check every module under lib/ and test/ (as before).
  const files = []
  walk(join(root, 'lib'), files)
  walk(join(root, 'test'), files)
  for (const file of files) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  }

  // 2. Whitelist check over lib/, test/, scripts/ source files.
  const sources = {}
  for (const dir of ['lib', 'test', 'scripts']) {
    const dirFiles = []
    walk(join(root, dir), dirFiles)
    for (const file of dirFiles) {
      sources[file] = readFileSync(file, 'utf8')
    }
  }
  const violations = checkWhitelist(sources)
  if (violations.length > 0) {
    for (const { file, line, symbol } of violations) {
      console.error(
        `${file}:${line}: illegal import from ${PACKAGE}: '${symbol}' ` +
          `(whitelist: ${WHITELIST.join(', ')})`,
      )
    }
    process.exit(1)
  }

  console.log(
    `lint ok: ${files.length} files, ` +
      `${Object.keys(sources).length} sources whitelist-clean`,
  )
}

run()
