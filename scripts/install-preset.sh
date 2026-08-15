#!/bin/sh
# install-preset.sh — adapt a DSH agent preset for dsh-plugin-subagents (T17, DESIGN §6.3).
#
# WHY THIS IS NEEDED
#   In the `web` profile a session's tool surface is owned by its agent PRESET:
#   a preset-layer row shadows any host-plane tool with the same name. The
#   shipped `standard` preset mounts `subagent` / `subagent_fork` rows pointing
#   at the official @deepseek-ai/dsh-tool-subagent, which would shadow this
#   plugin's unified tools. This script copies the source preset and adapts the
#   COPY (the source is never modified):
#
#   L1 (default)      delete the generic delegation rows (name
#                     '@deepseek-ai/dsh-tool-subagent' + toolName
#                     subagent|subagent_fork) so the host-plane plugin tools
#                     become visible. A preset without such rows (e.g.
#                     `orchestrator`) is a no-op copy.
#   L2 (--enhance-rows) rewrite every '@deepseek-ai/dsh-tool-subagent' row to
#                     `name: 'dsh-plugin-subagents'` + `presetRow: true`,
#                     keeping all other config keys and deleting nothing.
#
#   The actual YAML transform lives in preset-adapt.mjs (node + the repo's
#   `yaml` dependency; round-trip safe for comments and `!!js` tags) — this
#   wrapper only resolves DSH_HOME and forwards there.
#
# Idempotent: a copy carrying the plugin marker (.dsh-plugin-subagents-adapted)
# is skipped. Uninstall: switch back to the source preset in the UI and delete
# the <source>-subagents directory.
#
# Usage: install-preset.sh [<source-preset-id>] [--enhance-rows]
#        source defaults to `standard`; DSH_HOME defaults to ~/.dsh
#        ($DSH_HOME environment variable overrides).

set -eu
# pipefail is not POSIX sh (dash lacks it) — enable it only where supported.
if (set -o pipefail) 2>/dev/null; then
  set -o pipefail
fi

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ADAPT_SCRIPT="$SCRIPT_DIR/preset-adapt.mjs"

usage() {
  cat <<'EOF'
Usage: install-preset.sh [<source-preset-id>] [--enhance-rows]

Adapt a DSH agent preset for dsh-plugin-subagents (DESIGN §6.3):
  L1 (default)        delete the generic subagent/subagent_fork delegation rows
                      from the copy, so the host-plane plugin tools show through
  --enhance-rows (L2) rewrite the official dsh-tool-subagent rows to
                      dsh-plugin-subagents + presetRow: true

Options:
  <source-preset-id>  preset id under $DSH_HOME/.agent-presets (default: standard)
  -h, --help          show this help

Environment:
  DSH_HOME            DSH home directory (default: ~/.dsh)
EOF
}

SOURCE_PRESET='standard'
SOURCE_SET=0
ENHANCE_ROWS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --enhance-rows)
      ENHANCE_ROWS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "[error] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ "$SOURCE_SET" -ne 0 ]; then
        echo "[error] unexpected extra argument: $1" >&2
        usage >&2
        exit 2
      fi
      SOURCE_PRESET=$1
      SOURCE_SET=1
      shift
      ;;
  esac
done

if [ -z "${DSH_HOME:-}" ]; then
  DSH_HOME="$HOME/.dsh"
fi

if ! command -v node >/dev/null 2>&1; then
  echo '[error] node is required (the YAML transform runs via node + the yaml package).' >&2
  exit 1
fi

if [ ! -f "$ADAPT_SCRIPT" ]; then
  echo "[error] missing adapter script: $ADAPT_SCRIPT" >&2
  exit 1
fi

# preset-adapt.mjs echoes "[info] DSH_HOME = ..." itself.
if [ "$ENHANCE_ROWS" -eq 1 ]; then
  exec node "$ADAPT_SCRIPT" --dsh-home "$DSH_HOME" --source "$SOURCE_PRESET" --enhance-rows
fi
exec node "$ADAPT_SCRIPT" --dsh-home "$DSH_HOME" --source "$SOURCE_PRESET"
