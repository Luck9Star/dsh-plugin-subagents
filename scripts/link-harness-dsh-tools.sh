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
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${REPO_DIR}/node_modules/@deepseek-ai/dsh-tools"

# Allow an explicit override: HARNESS_DSH_TOOLS=/path/to/dsh-tools ./scripts/link-harness-dsh-tools.sh
if [ -n "${HARNESS_DSH_TOOLS:-}" ]; then
  HARNESS_TOOLS="${HARNESS_DSH_TOOLS}"
else
  CANDIDATES=$(ls -d "${HOME}"/.npm/_npx/*/node_modules/@deepseek-ai/dsh-tools 2>/dev/null || true)
  if [ -z "${CANDIDATES}" ]; then
    echo "ERROR: no @deepseek-ai/dsh-tools found under ~/.npm/_npx (how is dsh launched?)" >&2
    echo "Hint: HARNESS_DSH_TOOLS=/path/to/dsh-tools $0" >&2
    exit 1
  fi
  HARNESS_TOOLS=$(echo "${CANDIDATES}" | tail -1)
  if [ "$(echo "${CANDIDATES}" | wc -l)" -gt 1 ]; then
    echo "NOTE: multiple npx cache copies found, using: ${HARNESS_TOOLS}" >&2
  fi
fi

if [ ! -d "${HARNESS_TOOLS}" ]; then
  echo "ERROR: ${HARNESS_TOOLS} is not a directory" >&2
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
