# resolve-root.sh — POSIX function library for the dsh-plugin-subagents
# install/verify/uninstall scripts (DESIGN §6.4.1; red line 11).
#
# Source me, never execute me:
#   . "$(dirname "$0")/resolve-root.sh"
#
# Contents (all output on stdout, all diagnostics on stderr):
#   resolve_live_root()      dynamic live-harness-root resolution + self-verification
#   rr_realpath <path>       canonicalize a file/dir path (realpath, node fallback)
#   live_dsh_version <root>  read the live root's @deepseek-ai/dsh version
#   cwd_patch_*              shared cwd-patch descriptors (single source of truth
#                            for anchors/markers/replacements — mirrors the hunks
#                            in 01-in-process-driver.patch / 02-subagent-bundle.patch)
#   cwd_patch_classify       three-way text classification: applied | unpatched | drifted
#
# RED LINE 11 (DESIGN §9-11): no hardcoded cache-hash paths, no cache-directory
# enumeration / last-entry root-picking heuristics. The live root is ALWAYS
# resolved dynamically:
#   1. $DSH_HARNESS_ROOT explicit override (exotic launch forms), self-verified;
#   2. `command -v dsh` → realpath → walk up to the first `node_modules` parent;
#      (Windows: install.ps1 extracts the bin.js target from the npm shim text
#      and walks up the same way.)
# Both paths self-verify that <root>/node_modules/@deepseek-ai/dsh-subagent exists
# and fail loud when they cannot.
#
# Environment overrides honored by all sourced scripts (documented for tests and
# exotic layouts; none of them can bypass the probe gate):
#   DSH_HARNESS_ROOT          live harness root override
#   DSH_HOME                  dsh user home (profiles live under $DSH_HOME/profiles;
#                             same variable name as @deepseek-ai/dsh-home-paths)
#   DSH_PLUGIN_ROOT           this plugin package root (stamp + repo-side link)

# ---------------------------------------------------------------- helpers ----

# Loud failure diagnostic naming the three supported launch forms (§6.4.1).
rr_loud() {
	printf 'resolve-root: ERROR: %s\n' "$1" >&2
	printf 'resolve-root: the live harness root must be resolvable one of these ways:\n' >&2
	printf 'resolve-root:   1. dsh launched from an npx cache install — `command -v dsh` then\n' >&2
	printf 'resolve-root:      realpath + upward walk to the enclosing node_modules parent;\n' >&2
	printf 'resolve-root:   2. dsh installed globally (npm install -g) — same resolution;\n' >&2
	printf 'resolve-root:   3. exotic launch forms — export DSH_HARNESS_ROOT=/path/to/root explicitly.\n' >&2
}

# Canonicalize an existing file or directory. realpath first (macOS 12+/Linux),
# node fallback (node is a hard prerequisite of everything else here anyway).
rr_realpath() {
	if command -v realpath >/dev/null 2>&1; then
		realpath "$1" 2>/dev/null || return 1
	else
		node -e 'const fs=require("fs");process.stdout.write(fs.realpathSync(process.argv[1]))' "$1" 2>/dev/null || return 1
	fi
}

# ------------------------------------------------------- live root resolve ----

# Resolve the live harness root. Prints it on stdout; returns 1 (loud) on any
# failure. Never picks a root heuristically — only the running `dsh` (or the
# explicit override) defines "live".
resolve_live_root() {
	_rr_root=''

	if [ -n "${DSH_HARNESS_ROOT:-}" ]; then
		_rr_root=$(rr_realpath "$DSH_HARNESS_ROOT") || {
			rr_loud "DSH_HARNESS_ROOT is set to '$DSH_HARNESS_ROOT' but that path does not exist or cannot be canonicalized"
			return 1
		}
	else
		_rr_bin=$(command -v dsh 2>/dev/null) || _rr_bin=''
		if [ -z "$_rr_bin" ]; then
			rr_loud '`command -v dsh` found no dsh executable on PATH'
			return 1
		fi
		_rr_real=$(rr_realpath "$_rr_bin") || {
			rr_loud "cannot canonicalize the dsh binary at '$_rr_bin'"
			return 1
		}
		# Walk up from <root>/node_modules/@deepseek-ai/dsh/lib/bin.js to the
		# first directory NAMED node_modules; its parent is the harness root.
		_rr_dir=$(dirname "$_rr_real")
		while [ -n "$_rr_dir" ] && [ "$_rr_dir" != '/' ]; do
			if [ "$(basename "$_rr_dir")" = 'node_modules' ]; then
				_rr_root=$(dirname "$_rr_dir")
				break
			fi
			_rr_dir=$(dirname "$_rr_dir")
		done
		if [ -z "$_rr_root" ]; then
			rr_loud "the running dsh binary '$_rr_real' is not inside a node_modules tree (unexpected install layout)"
			return 1
		fi
	fi

	# Self-verification (§6.4.1): the root must actually host the harness's
	# dsh-subagent package, or we resolved something that is not a live root.
	if [ ! -d "$_rr_root/node_modules/@deepseek-ai/dsh-subagent" ]; then
		rr_loud "self-verification failed: '$_rr_root/node_modules/@deepseek-ai/dsh-subagent' does not exist — this is not a live dsh harness root"
		return 1
	fi

	printf '%s\n' "$_rr_root"
}

# Read the live root's @deepseek-ai/dsh version (gate 1 input, §6.4.2 state c).
live_dsh_version() {
	node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1]+"/node_modules/@deepseek-ai/dsh/package.json","utf8"));process.stdout.write(String(p.version))' "$1"
}

# ------------------------------------------------- cwd patch descriptors ----
# Single source of truth for the two rc.6 cwd-forwarding patches. The strings
# below are byte-identical to the hunks in 01-in-process-driver.patch and
# 02-subagent-bundle.patch (tab-indented exactly like the stock files). Every
# consumer (install/verify/uninstall, sh and ps1 alike) must use THESE shapes.

# Target packages (relative to the live root's node_modules).
CWD_PATCH_DRIVER_PKG='@deepseek-ai/dsh-subagent-in-process-driver'
CWD_PATCH_BUNDLE_PKG='@deepseek-ai/dsh-subagent'

# Patch 1 — foreground (one-shot) driver, 2-tab anchor.
cwd_patch_anchor_driver() {
	printf '\t\tmeta: childSessionMeta(parent, childDepth, activationBoundary),'
}
cwd_patch_marker_driver() {
	printf '\t\t\t...childSessionMeta(parent, childDepth, activationBoundary),'
}
cwd_patch_replacement_driver() {
	printf '\t\t\tmeta: {\n\t\t\t\t...childSessionMeta(parent, childDepth, activationBoundary),\n\t\t\t\t...request.cwd !== void 0 ? { cwd: request.cwd } : {}\n\t\t\t},'
}

# Patch 2 — continuable manager inside the dsh-subagent BUNDLE (lib/index.js is
# the bundle; lib/types/continuation.js is NOT the runtime — see the patch file),
# 6-tab anchor.
cwd_patch_anchor_bundle() {
	printf '\t\t\t\t\t\tmeta: childSessionMeta(parent, childDepth, lineageSeedLength),'
}
cwd_patch_marker_bundle() {
	printf '\t\t\t\t\t\t\t...childSessionMeta(parent, childDepth, lineageSeedLength),'
}
cwd_patch_replacement_bundle() {
	printf '\t\t\t\t\t\tmeta: {\n\t\t\t\t\t\t\t...childSessionMeta(parent, childDepth, lineageSeedLength),\n\t\t\t\t\t\t\t...request.cwd !== void 0 ? { cwd: request.cwd } : {}\n\t\t\t\t\t\t},'
}

# Three-way text classification of one patch target (fixed-string, tab-exact):
#   applied   — the patched marker line is present (our merge is in place)
#   unpatched — the stock anchor line is present (patchable)
#   drifted   — neither: the anchor no longer matches this dsh build
# NOTE: classification is ANCHOR-based only. When a target classifies as
# `drifted`, whether dsh natively supports request.cwd is decided EXCLUSIVELY
# by the two hard gates in install.sh (version whitelist + behavioral probe).
# Grepping the whole file for `request.cwd` is FORBIDDEN as evidence (§6.4.2-c).
cwd_patch_classify() {
	_cp_target=$1
	_cp_anchor=$2
	_cp_marker=$3
	if grep -qF -- "$_cp_marker" "$_cp_target" 2>/dev/null; then
		printf 'applied\n'
	elif grep -qF -- "$_cp_anchor" "$_cp_target" 2>/dev/null; then
		printf 'unpatched\n'
	else
		printf 'drifted\n'
	fi
}
