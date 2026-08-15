# install-preset.ps1 — adapt a DSH agent preset for dsh-plugin-subagents (T17, DESIGN §6.3).
#
# WHY THIS IS NEEDED
#   In the `web` profile a session's tool surface is owned by its agent PRESET:
#   a preset-layer row shadows any host-plane tool with the same name. The
#   shipped `standard` preset mounts `subagent` / `subagent_fork` rows pointing
#   at the official @deepseek-ai/dsh-tool-subagent, which would shadow this
#   plugin's unified tools. This script copies the source preset and adapts the
#   COPY (the source is never modified):
#
#   L1 (default)          delete the generic delegation rows (name
#                         '@deepseek-ai/dsh-tool-subagent' + toolName
#                         subagent|subagent_fork) so the host-plane plugin
#                         tools become visible. A preset without such rows
#                         (e.g. `orchestrator`) is a no-op copy.
#   L2 (-EnhanceRows)     rewrite every '@deepseek-ai/dsh-tool-subagent' row to
#                         `name: 'dsh-plugin-subagents'` + `presetRow: true`,
#                         keeping all other config keys and deleting nothing.
#
#   The actual YAML transform lives in preset-adapt.mjs (node + the repo's
#   `yaml` dependency; round-trip safe for comments and `!!js` tags) — this
#   wrapper only resolves DSH_HOME and forwards there.
#
# Idempotent: a copy carrying the plugin marker (.dsh-plugin-subagents-adapted)
# is skipped. Uninstall: switch back to the source preset in the UI and delete
# the <source>-subagents directory.
#
# Usage:  powershell -ExecutionPolicy Bypass -File install-preset.ps1 [<source-preset-id>] [-EnhanceRows]
#         source defaults to `standard`; DSH_HOME defaults to ~/.dsh
#         ($env:DSH_HOME environment variable overrides).

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$SourcePreset = 'standard',
  [switch]$EnhanceRows,
  [string]$DshHome
)

$ErrorActionPreference = 'Stop'

$adaptScript = Join-Path $PSScriptRoot 'preset-adapt.mjs'
if (-not (Test-Path $adaptScript)) {
  Write-Error "[error] missing adapter script: $adaptScript"
}

$dshHomeValue = $DshHome
if (-not $dshHomeValue) { $dshHomeValue = $env:DSH_HOME }
if (-not $dshHomeValue) { $dshHomeValue = Join-Path $HOME '.dsh' }

$nodeArgs = @($adaptScript, '--dsh-home', $dshHomeValue, '--source', $SourcePreset)
if ($EnhanceRows) { $nodeArgs += '--enhance-rows' }

# preset-adapt.mjs echoes "[info] DSH_HOME = ..." itself.
& node @nodeArgs
exit $LASTEXITCODE
