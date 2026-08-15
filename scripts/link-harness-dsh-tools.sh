#!/usr/bin/env bash
# link-harness-dsh-tools.sh — symlink the RUNNING harness's @deepseek-ai/dsh-tools
# into this repo's node_modules.
#
# Why: @deepseek-ai/dsh-tools is a peerDependency. dsh-tools registers its
# tool-runtime scheduler under a module-level Symbol (TOOL_RUNTIME_SCHEDULER),
# so a second physical copy of the package (e.g. hoisted into a profile tree by
# a regular dependency, or installed here for development) is a SECOND module
# instance with a SECOND Symbol. The agent loop then fails every tool call:
#   Cannot read properties of undefined (reading 'prepare')
# Linking to the copy the harness itself runs keeps a single instance.
#
# Re-run after a dsh upgrade (new npx cache dir) or an `npm install` here.
#
# Relationship to patches/install.sh (A 段): install.sh --links-only repairs the
# dsh-plugin-subagents↔profile symlinks and stops; THIS script repairs the
# peer @deepseek-ai/dsh-tools symlink, which install.sh does not manage. Both
# resolve the live root THE SAME way — by sourcing `patches/resolve-root.sh`
# (red line 11: no hardcoded cache-hash paths, no `ls ~/.npm/_npx/* | tail -1`
# pick-a-root heuristics). `resolve_live_root` walks `command -v dsh` → realpath
# → upward to the node_modules parent (or honors DSH_HARNESS_ROOT), and the
# peer package is then read from that root. Use this script (or the explicit
# HARNESS_DSH_TOOLS override) to keep dsh-tools in sync after a harness move.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${REPO_DIR}/node_modules/@deepseek-ai/dsh-tools"

# Allow an explicit override: HARNESS_DSH_TOOLS=/path/to/dsh-tools ./scripts/link-harness-dsh-tools.sh
if [ -n "${HARNESS_DSH_TOOLS:-}" ]; then
  HARNESS_TOOLS="${HARNESS_DSH_TOOLS}"
else
  # Resolve the live harness root via the shared function library (red line 11).
  RESOLVE_ROOT="$(cd "$(dirname "$0")/../patches" && pwd)/resolve-root.sh"
  if [ ! -f "${RESOLVE_ROOT}" ]; then
    echo "ERROR: resolve-root.sh not found at ${RESOLVE_ROOT} (independent distribution?)" >&2
    echo "Hint: HARNESS_DSH_TOOLS=/path/to/dsh-tools $0" >&2
    exit 1
  fi
  # shellcheck source=../patches/resolve-root.sh
  . "${RESOLVE_ROOT}"
  LIVE_ROOT="$(resolve_live_root)" || {
    echo "ERROR: cannot resolve the live dsh harness root (see resolve-root diagnostics above)" >&2
    echo "Hint: run patches/install.sh --links-only (it resolves the live root the same way), or" >&2
    echo "      HARNESS_DSH_TOOLS=/path/to/dsh-tools $0" >&2
    exit 1
  }
  HARNESS_TOOLS="${LIVE_ROOT}/node_modules/@deepseek-ai/dsh-tools"
fi

if [ ! -d "${HARNESS_TOOLS}" ]; then
  echo "ERROR: ${HARNESS_TOOLS} is not a directory" >&2
  echo "Hint: run patches/install.sh --links-only if the harness peer is missing from the live root" >&2
  exit 1
fi

mkdir -p "${REPO_DIR}/node_modules/@deepseek-ai"
if [ -L "${TARGET}" ] && [ "$(readlink "${TARGET}")" = "${HARNESS_TOOLS}" ]; then
  echo "OK: ${TARGET} -> ${HARNESS_TOOLS} (already correct)"
  exit 0
fi
rm -rf "${TARGET}"
ln -s "${HARNESS_TOOLS}" "${TARGET}"
echo "LINKED: ${TARGET} -> ${HARNESS_TOOLS}"
