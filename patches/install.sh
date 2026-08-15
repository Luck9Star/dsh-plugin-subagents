#!/usr/bin/env bash
# install.sh — two-stage installer for the cwd capability (DESIGN §6.4.2; T16).
#
# Usage:  ./install.sh [--links-only]
#
# Stage A (MANDATORY, runs first, its own success/failure): fix BOTH
#   @deepseek-ai/dsh-tools references so they resolve to the LIVE harness
#   root's copy — the profile side (<$DSH_HOME>/profiles/*/node_modules/…) and
#   this plugin repo's node_modules copy. dsh-tools registers its tool-runtime
#   scheduler under a module-level Symbol, so a second physical copy kills
#   every tool call ("Cannot read properties of undefined (reading 'prepare')")
#   — this stage absorbs fix-dsh-tools-dedupe.sh / link-harness-dsh-tools.sh.
#   --links-only stops after this stage.
#
# Stage B (capability stage, per-patch four-state machine, never blocks or
#   rolls back Stage A): apply the two rc.6 cwd-forwarding patches to the live
#   root. Per patch target:
#     a  anchor present, marker absent        → apply (.bak_cwd backup,
#                                               anchored replace, node --check)
#     b  marker present                       → idempotent skip
#     c  neither, dsh natively forwards cwd   → HARD double gate, fail closed:
#          gate 1  dsh version ∈ NATIVE_CWD_VERSIONS (manually verified list,
#                  initially EMPTY — red line 12; DSH_NATIVE_CWD_VERSIONS env
#                  may add candidates for testing/ops, gate 2 still applies);
#          gate 2  behavioral probe probe-cwd.mjs must actually observe a
#                  child session creation meta.cwd === request.cwd through the
#                  LIVE subagent start path (probe failure or not-executable
#                  both refuse native);
#          both gates pass → no-op + stamp 'native-verified'.
#        Grepping the file for request.cwd is FORBIDDEN as native evidence.
#     d  neither, gates fail                  → loud failure, two flavors:
#          d1 drift-anchor  — anchor mismatch, needs a newer plugin release;
#          d2 unverified-native — whitelist hit but probe refused, re-check
#                  with patches/verify.sh --probe.
#
# Stage C: write <plugin>/patches/.applied (dshVersion, liveRoot, appliedAt,
#   per-patch states, mtimes, stage-A link results) — the native driver only
#   releases per-call cwd for states applied | native-verified.
#
# Exit codes: 0 = success (fresh or idempotent); 1 = live-root resolution or
#   Stage A failure (fatal, nothing else ran); 3 = Stage B drift (Stage A
#   results REMAIN in place — the output says so explicitly).
#
# Environment overrides (tests / exotic layouts; see resolve-root.sh):
#   DSH_HARNESS_ROOT, DSH_HOME, DSH_PLUGIN_ROOT, DSH_NATIVE_CWD_VERSIONS.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=resolve-root.sh
. "$SCRIPT_DIR/resolve-root.sh"

# Plugin package root: stamp + repo-side dsh-tools link live here.
if [ -n "${DSH_PLUGIN_ROOT:-}" ]; then
	PLUGIN_ROOT="$(cd "$DSH_PLUGIN_ROOT" && pwd)"
else
	PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
STAMP_PATH="$PLUGIN_ROOT/patches/.applied"

# Gate 1 constant (§6.4.2-c): dsh versions MANUALLY verified to forward
# request.cwd natively. Space-separated exact versions (shell-portable form of
# the constant array). INTENTIONALLY EMPTY for 0.1.0-rc.6 — rc.6 does NOT
# support it (DESIGN §2.1). Update only together with a plugin release after
# running patches/verify.sh --probe against the new dsh build.
NATIVE_CWD_VERSIONS=''

version_whitelisted() {
	case " $NATIVE_CWD_VERSIONS ${DSH_NATIVE_CWD_VERSIONS:-} " in
		*" $1 "*) return 0 ;;
		*) return 1 ;;
	esac
}

LINKS_ONLY=0
for arg in "$@"; do
	case "$arg" in
		--links-only) LINKS_ONLY=1 ;;
		-h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "install.sh: unknown argument '$arg' (expected --links-only)" >&2; exit 1 ;;
	esac
done

# ---------------------------------------------------------------- 0. root ----

LIVE_ROOT=$(resolve_live_root) || {
	echo "install.sh: FATAL: live harness root could not be resolved — nothing was modified." >&2
	exit 1
}
DSH_VERSION=$(live_dsh_version "$LIVE_ROOT") || {
	echo "install.sh: FATAL: cannot read the live dsh version under '$LIVE_ROOT'." >&2
	exit 1
}

echo "[ok] live root  : $LIVE_ROOT"
echo "[ok] dsh version: $DSH_VERSION"
echo "[ok] plugin root: $PLUGIN_ROOT"

# ------------------------------------------------------------ Stage A --------

EXPECTED_TOOLS="$LIVE_ROOT/node_modules/@deepseek-ai/dsh-tools"
LINK_LINES=''

link_ok() {
	_path=$1
	[ -L "$_path" ] || return 1
	_cur=$(readlink "$_path") || return 1
	case "$_cur" in
		/*) _target=$(rr_realpath "$_cur") || return 1 ;;
		*) _target=$(rr_realpath "$(dirname "$_path")/$_cur") || return 1 ;;
	esac
	_expected=$(rr_realpath "$EXPECTED_TOOLS") || return 1
	[ "$_target" = "$_expected" ]
}

fix_link() {
	_path=$1
	_key=$2
	if link_ok "$_path"; then
		echo "[link] ok (already correct): $_path"
		LINK_LINES="$LINK_LINES
$_key ok"
		return 0
	fi
	rm -rf "$_path"
	mkdir -p "$(dirname "$_path")"
	if ! ln -s "$EXPECTED_TOOLS" "$_path"; then
		echo "install.sh: FATAL: failed to create symlink $_path -> $EXPECTED_TOOLS" >&2
		exit 1
	fi
	echo "[link] fixed: $_path -> $EXPECTED_TOOLS"
	LINK_LINES="$LINK_LINES
$_key fixed"
}

echo ""
echo "== Stage A: dsh-tools single-instance links (mandatory) =="

if [ ! -d "$EXPECTED_TOOLS" ]; then
	echo "install.sh: FATAL: the live root's dsh-tools package is missing ('$EXPECTED_TOOLS')." >&2
	exit 1
fi

# A.1 — this plugin repo's node_modules copy (npm ≥7 installs peers as real
# directories; every `npm install` here recreates it — re-run after installs).
fix_link "$PLUGIN_ROOT/node_modules/@deepseek-ai/dsh-tools" 'plugin-repo'

# A.2 — profile trees: fix every profile whose dsh-tools exists as a real
# directory or points at the wrong root (dangling links included); profiles
# that are already correct are skipped; profiles without the path are left
# alone (nothing to dedupe there).
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
if [ -d "$DSH_HOME_DIR/profiles" ]; then
	for _profile in "$DSH_HOME_DIR"/profiles/*/; do
		[ -d "$_profile" ] || continue
		_profile_tools="$_profile/node_modules/@deepseek-ai/dsh-tools"
		if [ -d "$_profile_tools" ] || [ -L "$_profile_tools" ]; then
			fix_link "$_profile_tools" "profile:$(basename "$_profile")"
		fi
	done
fi

echo "[ok] stage A complete: both dsh-tools references point at the live root."

if [ "$LINKS_ONLY" -eq 1 ]; then
	echo ""
	echo "Done (--links-only): cwd patches were NOT evaluated; patches/.applied was not written."
	exit 0
fi

# ------------------------------------------------------------ Stage B --------

echo ""
echo "== Stage B: cwd patches (per-patch four-state machine) =="

T_DRIVER="$LIVE_ROOT/node_modules/$CWD_PATCH_DRIVER_PKG/lib/index.js"
T_BUNDLE="$LIVE_ROOT/node_modules/$CWD_PATCH_BUNDLE_PKG/lib/index.js"

ST_DRIVER='missing'
ST_BUNDLE='missing'
B_ERRORS=0

# Apply one patch target (state a). Keeps a pre-existing .bak_cwd untouched —
# it holds the pristine stock file; restores it if the patched result fails
# node --check.
apply_patch() {
	_target=$1
	_anchor=$2
	_replacement=$3
	_bak="$_target.bak_cwd"
	if [ ! -f "$_bak" ]; then
		cp "$_target" "$_bak"
		echo "[bak]   $_bak"
	fi
	if ! FROM="$_anchor" TO="$_replacement" FILE="$_target" node -e '
		const fs = require("fs");
		const file = process.env.FILE;
		const src = fs.readFileSync(file, "utf8");
		const at = src.indexOf(process.env.FROM);
		if (at < 0) { console.error("anchor disappeared before replacement"); process.exit(1); }
		fs.writeFileSync(file, src.slice(0, at) + process.env.TO + src.slice(at + process.env.FROM.length));
	'; then
		echo "[ERROR] anchored replacement failed on $_target — restoring backup" >&2
		cp "$_bak" "$_target"
		return 1
	fi
	if ! node --check "$_target"; then
		echo "[ERROR] node --check rejected the patched $_target — restoring backup" >&2
		cp "$_bak" "$_target"
		return 1
	fi
	echo "[patch] applied: $_target"
}

# Behavioral probe (gate 2). Runs at most once per install; rc 0 = verified,
# anything else = refused (fail / not-executable distinction is in the output).
PROBE_RAN=0
PROBE_RC=1
PROBE_OUT=''
run_probe() {
	if [ "$PROBE_RAN" -eq 0 ]; then
		PROBE_RAN=1
		set +e
		PROBE_OUT=$(node "$SCRIPT_DIR/probe-cwd.mjs" "$LIVE_ROOT" 2>&1)
		PROBE_RC=$?
		set -e
		echo "[probe] behavioral probe exit code: $PROBE_RC"
		printf '%s\n' "$PROBE_OUT" | sed 's/^/        /'
	fi
}

d1_report() {
	_label=$1
	echo "[ERROR] $_label: drift-anchor — the cwd patch anchor no longer matches dsh $DSH_VERSION." >&2
	echo "        Remediation: a NEWER PLUGIN RELEASE must re-export the patches for this dsh build;" >&2
	echo "        check the dsh-plugin-subagents releases / issues." >&2
}

d2_report() {
	_label=$1
	echo "[ERROR] $_label: unverified-native — dsh $DSH_VERSION is whitelisted for native request.cwd" >&2
	echo "        but the behavioral probe did not confirm it (suspected whitelist mis-entry or probe" >&2
	echo "        environment problem). Re-check with: patches/verify.sh --probe   and file an issue to" >&2
	echo "        update NATIVE_CWD_VERSIONS." >&2
}

# Evaluate one patch target through the four-state machine; sets a global
# ST_<slot> to applied | native-verified | missing | drift-anchor | unverified-native.
evaluate_patch() {
	_slot=$1
	_target=$2
	_anchor=$3
	_marker=$4
	_replacement=$5

	if [ ! -f "$_target" ]; then
		echo "[ERROR] $_slot: target file not found in the live root: $_target" >&2
		B_ERRORS=$((B_ERRORS + 1))
		return
	fi

	_state=$(cwd_patch_classify "$_target" "$_anchor" "$_marker")

	case "$_state" in
	applied)
		echo "[patch] already applied (idempotent): $_target"
		if [ ! -f "$_target.bak_cwd" ]; then
			echo "[warn]  no .bak_cwd backup next to $_target — uninstall will not be able to restore it." >&2
		fi
		eval "ST_$_slot=applied"
		;;
	unpatched)
		if apply_patch "$_target" "$_anchor" "$_replacement"; then
			eval "ST_$_slot=applied"
		else
			eval "ST_$_slot=missing"
			B_ERRORS=$((B_ERRORS + 1))
		fi
		;;
	drifted)
		# Anchor is gone. Native support needs BOTH gates (fail closed);
		# whole-file request.cwd grepping is not evidence (§6.4.2-c).
		if version_whitelisted "$DSH_VERSION"; then
			run_probe
			if [ "$PROBE_RC" -eq 0 ]; then
				echo "[patch] native-verified: dsh $DSH_VERSION forwards request.cwd natively — no patch applied: $_target"
				eval "ST_$_slot=native-verified"
			else
				d2_report "$_slot"
				eval "ST_$_slot=unverified-native"
				B_ERRORS=$((B_ERRORS + 1))
			fi
		else
			d1_report "$_slot"
			eval "ST_$_slot=drift-anchor"
			B_ERRORS=$((B_ERRORS + 1))
		fi
		;;
	esac
}

evaluate_patch DRIVER "$T_DRIVER" \
	"$(cwd_patch_anchor_driver)" "$(cwd_patch_marker_driver)" "$(cwd_patch_replacement_driver)"
evaluate_patch BUNDLE "$T_BUNDLE" \
	"$(cwd_patch_anchor_bundle)" "$(cwd_patch_marker_bundle)" "$(cwd_patch_replacement_bundle)"

# ------------------------------------------------------------ Stage C --------

ST_DRIVER_STATE="$ST_DRIVER" ST_BUNDLE_STATE="$ST_BUNDLE" ST_LINK_LINES="$LINK_LINES" \
	node -e '
	const fs = require("fs");
	const liveRoot = process.argv[1];
	const targets = {
		inProcessDriver: process.argv[2],
		subagentBundle: process.argv[3],
	};
	const out = process.argv[4];
	const version = JSON.parse(fs.readFileSync(liveRoot + "/node_modules/@deepseek-ai/dsh/package.json", "utf8")).version;
	const mtime = (p) => { try { return fs.statSync(p).mtime.toISOString(); } catch { return null; } };
	const links = {};
	for (const line of (process.env.ST_LINK_LINES || "").split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const at = trimmed.indexOf(" ");
		links[trimmed.slice(0, at)] = trimmed.slice(at + 1);
	}
	const doc = {
		dshVersion: version,
		liveRoot,
		appliedAt: new Date().toISOString(),
		patches: {
			inProcessDriver: process.env.ST_DRIVER_STATE,
			subagentBundle: process.env.ST_BUNDLE_STATE,
		},
		mtimes: {
			inProcessDriver: mtime(targets.inProcessDriver),
			subagentBundle: mtime(targets.subagentBundle),
		},
		links,
	};
	fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
' "$LIVE_ROOT" "$T_DRIVER" "$T_BUNDLE" "$STAMP_PATH"
echo "[ok] stamp written: $STAMP_PATH"

# ------------------------------------------------------------- summary -------

echo ""
echo "Summary: inProcessDriver=$ST_DRIVER  subagentBundle=$ST_BUNDLE"

if [ "$B_ERRORS" -gt 0 ]; then
	echo ""
	echo "[note] Stage A (dsh-tools links) already completed — only the cwd patch stage failed." >&2
	echo "       The dedupe links above remain in place; per-call cwd stays disabled until the" >&2
	echo "       patch states are applied | native-verified." >&2
	exit 3
fi

echo "Done. Restart dsh for the patched files to take effect."
exit 0
