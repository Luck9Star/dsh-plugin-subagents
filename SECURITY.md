# Security

This plugin is a **configuration-as-trust-boundary** tool for the DeepSeek
Harness. Please read this before deploying it.

## What the plugin does

- It spawns the product CLIs you configure (`claude`, `codex`, `grok`,
  `opencode`, `cbc`, `agent`, …) as subprocesses and drives them over their
  native protocols. **Anything the configured `command` can do, the plugin
  can do.**
- The `full` permission mode passes the products' own "bypass all permission
  checks" flags (`claude --dangerously-skip-permissions`,
  `codex --dangerously-bypass-approvals-and-sandbox`). Only enable `full` for
  roles/agents you trust with arbitrary file and command access.
- The relay model (the in-process bridge child) is always read-only: it only
  ever sees `subagent_submit` (plus `subagent` when the role allows
  delegation). It never receives write-capable tools.
- Permissions cannot be raised down the delegation tree
  (`readonly < default < full`); unknown stored modes fail closed to
  `readonly`, and recovery restores the recorded settings so the ceiling
  survives restarts.
- Task text is always passed after `--`, and flag/config values are
  whitelisted (`safeFlagValue` / `safeConfigValue`), so relayed content can
  never inject product CLI flags.
- The installer additionally patches two files inside your **local dsh
  installation** (the npx cache root it resolves dynamically) to enable
  per-call `cwd`: each target keeps a `.bak_cwd` backup, `node --check` must
  pass, and `patches/uninstall` restores the originals. Run these scripts
  only from a copy of this repository you trust.

## What to keep private

- The durable session registry (default
  `~/.dsh/subagents-registry.json`) maps child session ids to remote product
  session ids and their permission settings. It is written owner-only
  (`0600`, atomic rename); treat it as private runtime state and never
  commit it.
- Product CLI credentials are read by the products themselves from their own
  configuration. The plugin passes `process.env` through to child processes;
  do not rely on it to scrub secrets.

## Reporting

Report vulnerabilities privately to the repository owner. Do not open public
issues for exploitable flaws.
