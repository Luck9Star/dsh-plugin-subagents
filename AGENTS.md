# AGENTS.md

Guidance for AI agents (DeepSeek Harness agents, Claude Code, Codex, …)
working in this repository.

## What this is

`dsh-plugin-subagents` — a DeepSeek Harness (Cordis) bundle plugin that
unifies two subagent backends behind one tool family taking over the official
`subagent` / `subagent_fork` names: **native** in-process subagents with
per-call overrides (including `cwd` via two distributed patches), and
**bridge** subagents over external agent CLIs (Claude Code, Codex, the
grok-native streaming-json bridge, any ACP agent) with a declarative role
library, a delegation permission ceiling, and durable session recovery. The
bare `grok` name belongs to the user's `config.providers` (see
`lib/providers.js` NAMING OWNERSHIP). It fully replaces `legacy-cwd-plugin` and
`legacy-bridges-plugin`; the design record is
[docs/DESIGN.md](docs/DESIGN.md) and the task breakdown is
[docs/TASKS.md](docs/TASKS.md).

## Commands

```bash
npm install        # install dependencies
npm run setup:peer # symlink the RUNNING harness's @deepseek-ai/dsh-tools
npm test           # node:test suite (pure logic + fake bridge/driver/ctx)
npm run lint       # node --check every module + dsh-subagent import whitelist
```

Never add a test that requires a real product CLI, an API key, or a network —
the suite must stay green on a bare runner. When migrating code from the
predecessors, do not weaken migrated assertions; new cases add coverage, they
don't change old semantics.

## Repo layout

```
cordis.patch.yml      # bundle patch: disable official rows + insert the single instance
lib/
  index.js            # apply(): config, self-checks, migration, drivers, tool registration
  config.js           # zod strict config (dual branch: full schema / preset-row shape)
  drivers/            # SubagentDriver contract + native/bridge drivers + assembly
  native-delegate.js  # pure functions migrated from legacy-cwd-plugin
  tools/              # one module per model-facing tool (subagent*, legacy alias)
  bridges/            # one bridge per product protocol (claude / codex / grok / acp)
  providers.js        # config-driven provider registry (+ custom ACP agents)
  roles.js            # role library loader (backend + overrides)
  ceiling.js          # permission rank + delegation ceiling check
  registry.js         # durable registry (0600 atomic writes, 500-entry cap)
  bindings.js         # child→remote bindings + display-only log markers
  availability.js     # CLI detection (never executes the CLIs)
  run.js              # cross-platform process launching (Windows .cmd shims)
  redact.js           # secret redaction at the capture boundary (task-weaver port)
  progress.js         # session-log folding (progress/trace/token usage)
roles/                # declarative role files (*.json), seven defaults
patches/              # two cwd patches + install/verify/uninstall (sh + ps1) + probe
scripts/              # install-preset L1/L2 (sh + ps1), lint, link-harness-dsh-tools
test/                 # node:test suite (fakes only)
docs/DESIGN.md        # the architecture record — read before changing semantics
docs/TASKS.md         # task breakdown and acceptance criteria
```

## Design rules (non-negotiable)

Inherited from the predecessor's seven plus five new ones — all twelve are
binding (DESIGN §9):

1. **The relay model is always a read-only pipe.** A relay child's toolFilter
   only ever contains `subagent_submit` (plus `subagent` when the role allows
   delegation). Never add a write-capable tool to a relay child.
2. **Permissions are for the remote product.** `permissionMode`
   (`readonly` / `default` / `full`) maps to each product's own CLI flags.
3. **Permissions inherit down the delegation tree and can never be raised**
   (`readonly < default < full`); unknown permission modes fail closed to
   `readonly`.
4. **The bridge contract is fixed**: `create` / `submit` / `reconnect` /
   `dispose`. Adding a product = a new bridge + a provider entry; a plain ACP
   CLI needs no code at all (`config.providers`).
5. **Cross-platform.** All CLI launches go through `lib/run.js` (Windows
   `.cmd` shims, `/d /s /c` outer quoting, `taskkill /T /F`). Paths use
   `join()` and `fileURLToPath` — never string concatenation or
   `URL.pathname`.
6. **The registry is the only recovery source.** The `PRODUCT_SESSION:` log
   marker is display-only; recovery must restore the recorded `settings`
   (the permission ceiling).
7. **Task text always goes after `--`**, and flag/config values are
   whitelisted (`safeFlagValue` / `safeConfigValue`) — relayed content can
   never inject product CLI flags. One sanctioned exception to the LITERAL
   form: grok 1.0.4's clap parser rejects `-p -- <task>`, so the grok bridge
   (`lib/bridges/grok.js`) carries the task as an ATTACHED value
   `--single=<task>` — everything after `=` is one literal prompt value the
   parser never re-parses as flags. That preserves the rule's SUBSTANCE
   (relayed content can never flip into a flag); it is a deliberate,
   documented transport decision, not a violation to "fix".
8. **Capability mismatches are always loud errors; parameters are never
   silently ignored** (the parameter-capability matrix, DESIGN §3.5).
9. **Config stays a superset of the official `dsh-tool-subagent` row**, so a
   preset row can be rewritten to point at this package seamlessly (the
   precondition for preset adaptation L2).
10. **Shared state is held by the single global instance**: bindings /
    registry / concurrency slots exist only in the global `apply()` instance;
    `presetRow` instances are stateless.
11. **The install/doctor scripts never hardcode paths or use pick-a-root
    heuristics.** The live root is always resolved dynamically
    (`which dsh` → realpath → walk up to `node_modules`, with the
    `DSH_HARNESS_ROOT` explicit override); anchors are verified before
    patching and drift fails loudly; the doctor exits non-zero on any drift.
12. **Imports from `@deepseek-ai/dsh-subagent` are forever a pure-function
    whitelist** — `{ assertSubagentMaxDepth, settleRun }` — enforced by lint;
    that package is deliberately NOT part of the symlink dedupe (DESIGN
    §6.4.4: a stale real copy still yields correct pure functions, a dangling
    symlink after an npx hash switch would kill the whole plugin load).

## Config surface

`lib/config.js` (zod, strict — unknown keys fail loudly) validates two
branches: the full plugin schema (`toolNames`, `register`, `presetRow`,
native defaults `provider` / `enableRunInBackground` / `backgroundMode` /
`agentOptions` / `persona` / `toolFilter` / `maxDepth` / `presetHints` /
`fork`, bridge keys `providers` / `registryPath` / `idleTimeoutMs` /
`maxConcurrentChildren` / `rolesDir`, the bridge-side switches
`relayReportGuard` / `redactSecrets`, and `legacyProductAliases`) and, when
`presetRow: true`, the official tool-row shape (`provider` required,
`toolName` default `subagent`, shared native fields only). Roles live in
`roles/*.json` (`backend`, `permissionMode`, `allowDelegation`,
`instructions`, native `overrides`); the role id IS the file basename;
unknown role ids fail loudly, only an omitted role defaults to `general`.

## Conventions

- Update `README.md` and `README.zh.md` **together** — the two must stay
  section-for-section aligned whenever the config surface, tools, install
  flow, or effect matrix change.
- Add a `CHANGELOG.md` entry for every user-visible change.
- Code migrated from the predecessors stays line-for-line equivalent except
  where the design doc explicitly requires a rename or extension; preserve
  original comment semantics.
- Keep `lib/index.js` thin; tools live in `lib/tools/`, one module per tool.
