#!/usr/bin/env bash
# uninstall.sh — revert the two cwd patches applied by install.sh (T16).
#
# Restores each patched target from its .bak_cwd backup and removes the
# patches/.applied stamp (a stale stamp claiming applied/native-verified would
# wrongly re-enable per-call cwd).
#
# DELIBERATELY does NOT roll back the Stage A dsh-tools links: they point at
# the live harness root and are a deployment-health property, not this plugin's
# private state (DESIGN §6.4.2 uninstall note — reverting them would reintroduce
# the two-instance Symbol failure mode).
#
# Usage:  ./uninstall.sh
# Exit:   0 always (restoring is best-effort and loud, nothing here is fatal).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=resolve-root.sh
. "$SCRIPT_DIR/resolve-root.sh"

if [ -n "${DSH_PLUGIN_ROOT:-}" ]; then
	PLUGIN_ROOT="$(cd "$DSH_PLUGIN_ROOT" && pwd)"
else
	PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
STAMP_PATH="$PLUGIN_ROOT/patches/.applied"

# Prefer the live root; fall back to the root recorded in the stamp (covers
# "npx switched cache dir after install" — the OLD root is where the patched
# files and backups actually live).
LIVE_ROOT=$(resolve_live_root 2>/dev/null) || LIVE_ROOT=''
if [ -z "$LIVE_ROOT" ] && [ -f "$STAMP_PATH" ]; then
	_stamped_root=$(node -e '
	const fs = require("fs");
	try { const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(doc.liveRoot || ""); } catch {}
	' "$STAMP_PATH" 2>/dev/null || true)
	if [ -n "$_stamped_root" ] && [ -d "$_stamped_root" ]; then
		LIVE_ROOT=$_stamped_root
		echo "[info] live root unresolvable; using the stamp-recorded root: $LIVE_ROOT"
	fi
fi

RESTORED=0
UNRECOVERABLE=0

restore_target() {
	_pkg=$1
	_slot=$2
	_target="$LIVE_ROOT/node_modules/$_pkg/lib/index.js"
	_bak="$_target.bak_cwd"
	if [ -z "$LIVE_ROOT" ] || [ ! -f "$_target" ]; then
		echo "[skip] $_slot: target not found ($_target)"
		return
	fi
	if [ -f "$_bak" ]; then
		cp "$_bak" "$_target"
		rm -f "$_bak"
		echo "[ok]   $_slot: restored $_target from $(basename "$_bak")"
		RESTORED=$((RESTORED + 1))
	else
		if grep -qF -- "$(cwd_patch_marker_of "$_slot")" "$_target" 2>/dev/null; then
			echo "[warn] $_slot: patch marker present but NO backup — cannot restore automatically:" >&2
			echo "       $_target" >&2
			echo "       reinstall the @deepseek-ai package or re-run install.sh to regenerate a backup." >&2
			UNRECOVERABLE=1
		else
			echo "[skip] $_slot: not patched, nothing to restore ($_target)"
		fi
	fi
}

# marker lookup mirrors resolve-root.sh descriptors
cwd_patch_marker_of() {
	case "$1" in
	driver) cwd_patch_marker_driver ;;
	bundle) cwd_patch_marker_bundle ;;
	esac
}

restore_target "$CWD_PATCH_DRIVER_PKG" 'driver'
restore_target "$CWD_PATCH_BUNDLE_PKG" 'bundle'

if [ -f "$STAMP_PATH" ]; then
	rm -f "$STAMP_PATH"
	echo "[ok]   stamp removed: $STAMP_PATH"
fi

echo ""
echo "[note] Stage A dsh-tools links were intentionally LEFT IN PLACE (deployment"
echo "       health, not plugin state — see DESIGN §6.4.2 uninstall note)."
if [ "$RESTORED" -eq 0 ] && [ "$UNRECOVERABLE" -eq 0 ]; then
	echo "Done. Nothing was patched; nothing to do."
else
	echo "Done. Restart dsh for the restored files to take effect."
fi
exit 0
