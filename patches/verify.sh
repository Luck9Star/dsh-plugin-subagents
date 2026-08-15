#!/usr/bin/env bash
# verify.sh — read-only doctor for the cwd capability + dsh-tools dedupe
# (DESIGN §6.4.3; T16). Checks, each printed, then a summary:
#
#   (a) live harness root        resolve_live_root() (§6.4.1, no heuristics)
#   (b) both cwd patches         five states per patch, TWO DIFFERENT FILES at
#       in the live root         two different merge points:
#         (b1) @deepseek-ai/dsh-subagent-in-process-driver/lib/index.js
#              — the one-shot driver's agents.create({ meta }) merge point;
#         (b2) @deepseek-ai/dsh-subagent/lib/index.js — the BUNDLE's inline
#              continuable manager create.meta merge point.
#         applied | native-verified | missing | drift-anchor | unverified-native
#   (c) both dsh-tools links     readlink vs the live root's dsh-tools realpath
#       (plugin repo + profiles) ok | wrong-root | dangling | unexpected-copy
#   (d) repo dsh-subagent copy   version vs live root — WARNING only (§6.4.4:
#       vs live root             pure-function imports make drift non-fatal)
#
# Any drift in (a)/(b)/(c) → non-zero exit + one-line fix hint. (d) never
# fails the run. NOTHING is modified: --probe re-runs the behavioral probe as
# an independent deep check and only REPORTS (recording native-verified in the
# stamp stays install's job — the native driver trusts the stamp alone).
#
# Usage:  ./verify.sh [--probe]
# Exit:   0 healthy; 1 drift somewhere; 2 usage error.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=resolve-root.sh
. "$SCRIPT_DIR/resolve-root.sh"

if [ -n "${DSH_PLUGIN_ROOT:-}" ]; then
	PLUGIN_ROOT="$(cd "$DSH_PLUGIN_ROOT" && pwd)"
else
	PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
STAMP_PATH="$PLUGIN_ROOT/patches/.applied"

# Must stay in sync with install.sh (the release-verified list; see §6.4.2-c).
NATIVE_CWD_VERSIONS=''

version_whitelisted() {
	case " $NATIVE_CWD_VERSIONS ${DSH_NATIVE_CWD_VERSIONS:-} " in
		*" $1 "*) return 0 ;;
		*) return 1 ;;
	esac
}

PROBE=0
for arg in "$@"; do
	case "$arg" in
		--probe) PROBE=1 ;;
		-h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "verify.sh: unknown argument '$arg' (expected --probe)" >&2; exit 2 ;;
	esac
done

DRIFT=0

# ------------------------------------------------------------- (a) root ------

if LIVE_ROOT=$(resolve_live_root); then
	echo "(a) live root        : OK — $LIVE_ROOT"
else
	echo "(a) live root        : DRIFT — could not resolve the live harness root." >&2
	echo '    fix: make sure `command -v dsh` finds the running dsh, or export DSH_HARNESS_ROOT.' >&2
	echo "    fix: then re-run patches/install.sh" >&2
	exit 1
fi
DSH_VERSION=$(live_dsh_version "$LIVE_ROOT") || DSH_VERSION='(unknown)'
echo "    dsh version       : $DSH_VERSION"

# ----------------------------------------------------------- (b) patches -----

# stamp lookup: prints "<state>|<stampLiveRoot>|<stampDshVersion>" or nothing.
stamp_record() {
	[ -f "$STAMP_PATH" ] || return 1
	node -e '
	const fs = require("fs");
	try {
		const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
		const state = doc && doc.patches ? doc.patches[process.argv[2]] : undefined;
		process.stdout.write(`${state ?? ""}|${doc && doc.liveRoot ? doc.liveRoot : ""}|${doc && doc.dshVersion ? doc.dshVersion : ""}`);
	} catch { process.exit(1); }
	' "$STAMP_PATH" "$1" 2>/dev/null || return 1
}

run_probe_report() {
	set +e
	_probe_out=$(node "$SCRIPT_DIR/probe-cwd.mjs" "$LIVE_ROOT" 2>&1)
	_probe_rc=$?
	set -e
	echo "    probe re-run      : exit $_probe_rc"
	printf '%s\n' "$_probe_out" | sed 's/^/        /'
	if [ "$_probe_rc" -eq 0 ]; then
		echo "    → native forwarding WORKS on this live root; the stamp still needs install to record it:" >&2
		echo "      re-run patches/install.sh (state c, no-op) or update the stamp manually if you know why." >&2
	else
		echo "    → native forwarding NOT confirmed; treat per-call cwd as unavailable until patches apply." >&2
	fi
}

report_patch() {
	_slot=$1
	_key=$2
	_label=$3
	_target=$4
	_anchor=$5
	_marker=$6

	if [ ! -f "$_target" ]; then
		echo "(b) $_slot : DRIFT missing — target file not in the live root: $_target" >&2
		DRIFT=1
		return
	fi

	_state=$(cwd_patch_classify "$_target" "$_anchor" "$_marker")

	case "$_state" in
	applied)
		echo "(b) $_slot : applied — $_label"
		;;
	unpatched)
		echo "(b) $_slot : missing — the patch is NOT applied (anchor present) — $_label" >&2
		echo "    fix: re-run patches/install.sh" >&2
		DRIFT=1
		;;
	drifted)
		if ! version_whitelisted "$DSH_VERSION"; then
			echo "(b) $_slot : drift-anchor — anchor mismatch and dsh $DSH_VERSION is not whitelisted — $_label" >&2
			echo "    fix: a newer plugin release must re-export the patches; check releases/issues." >&2
			DRIFT=1
		else
			_record=$(stamp_record "$_key" || true)
			_stamped=${_record%%|*}
			_rest=${_record#*|}
			_root=${_rest%%|*}
			_ver=${_rest#*|}
			if [ "$_stamped" = 'native-verified' ] && [ "$_root" = "$LIVE_ROOT" ] && [ "$_ver" = "$DSH_VERSION" ]; then
				echo "(b) $_slot : native-verified — stamped for this root+dsh $DSH_VERSION — $_label"
			else
				echo "(b) $_slot : unverified-native — dsh $DSH_VERSION is whitelisted but no verified stamp for this root — $_label" >&2
				echo "    fix: re-run patches/verify.sh --probe to re-check, then patches/install.sh to record the verdict." >&2
				DRIFT=1
			fi
		fi
		;;
	esac
}

report_patch 'b1 driver ' 'inProcessDriver' 'one-shot driver agents.create({ meta }) merge' \
	"$LIVE_ROOT/node_modules/$CWD_PATCH_DRIVER_PKG/lib/index.js" \
	"$(cwd_patch_anchor_driver)" "$(cwd_patch_marker_driver)"
report_patch 'b2 bundle ' 'subagentBundle' 'dsh-subagent BUNDLE continuable create.meta merge' \
	"$LIVE_ROOT/node_modules/$CWD_PATCH_BUNDLE_PKG/lib/index.js" \
	"$(cwd_patch_anchor_bundle)" "$(cwd_patch_marker_bundle)"

if [ "$PROBE" -eq 1 ]; then
	echo ""
	echo "--probe: behavioral probe deep check (read-only)"
	run_probe_report
fi

# ------------------------------------------------------------- (c) links -----

EXPECTED_TOOLS="$LIVE_ROOT/node_modules/@deepseek-ai/dsh-tools"
_expected_real=$(rr_realpath "$EXPECTED_TOOLS" 2>/dev/null || true)

report_link() {
	_path=$1
	_label=$2
	if [ -L "$_path" ]; then
		_cur=$(readlink "$_path")
		case "$_cur" in
			/*) _t=$_cur ;;
			*) _t="$(dirname "$_path")/$_cur" ;;
		esac
		if [ ! -e "$_t" ]; then
			echo "(c) link $_label: DRIFT dangling — $_path -> $_cur" >&2
			DRIFT=1
			return
		fi
		_real=$(rr_realpath "$_t" 2>/dev/null || true)
		if [ -n "$_expected_real" ] && [ "$_real" = "$_expected_real" ]; then
			echo "(c) link $_label: OK — $_path -> $_cur"
		else
			echo "(c) link $_label: DRIFT wrong-root — resolves to $_real, live root has $_expected_real" >&2
			DRIFT=1
		fi
	elif [ -d "$_path" ]; then
		echo "(c) link $_label: DRIFT unexpected-copy — $_path is a REAL directory, not the live-root link" >&2
		DRIFT=1
	elif [ -e "$_path" ]; then
		echo "(c) link $_label: DRIFT — $_path exists but is neither symlink nor directory" >&2
		DRIFT=1
	else
		echo "(c) link $_label: DRIFT missing — $_path not found" >&2
		DRIFT=1
	fi
}

echo ""
echo "(c) dsh-tools links vs live root:"
report_link "$PLUGIN_ROOT/node_modules/@deepseek-ai/dsh-tools" 'plugin-repo'
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
if [ -d "$DSH_HOME_DIR/profiles" ]; then
	for _profile in "$DSH_HOME_DIR"/profiles/*/; do
		[ -d "$_profile" ] || continue
		_profile_tools="$_profile/node_modules/@deepseek-ai/dsh-tools"
		if [ -d "$_profile_tools" ] || [ -L "$_profile_tools" ]; then
			report_link "$_profile_tools" "profile:$(basename "$_profile")"
		fi
	done
fi

# --------------------------------------------------------- (d) version -------

echo ""
REPO_SUBAGENT="$PLUGIN_ROOT/node_modules/$CWD_PATCH_BUNDLE_PKG/package.json"
LIVE_SUBAGENT="$LIVE_ROOT/node_modules/$CWD_PATCH_BUNDLE_PKG/package.json"
if [ -f "$REPO_SUBAGENT" ] && [ -f "$LIVE_SUBAGENT" ]; then
	_repo_v=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version||""))' "$REPO_SUBAGENT")
	_live_v=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version||""))' "$LIVE_SUBAGENT")
	if [ "$_repo_v" = "$_live_v" ]; then
		echo "(d) dsh-subagent copy : OK — repo and live root are both $_repo_v (warning-only check)"
	else
		echo "(d) dsh-subagent copy : WARNING — repo copy $_repo_v vs live root $_live_v (non-fatal:" >&2
		echo "    pure-function imports only, §6.4.4; refresh with npm install if you need parity)" >&2
	fi
else
	echo "(d) dsh-subagent copy : skipped — no repo/local copy to compare (warning-only check)"
fi

# ------------------------------------------------------------- summary -------

echo ""
if [ "$DRIFT" -ne 0 ]; then
	echo "verify: FAIL — drift detected. One-line fix: re-run patches/install.sh" >&2
	echo "        (stage A repairs the links, stage B re-applies/re-judges the patches;" >&2
	echo "         use --links-only if you only want the dedupe links)." >&2
	exit 1
fi
echo "verify: OK — live root, both cwd patches, and both dsh-tools links are healthy."
exit 0
