# verify.ps1 — Windows twin of verify.sh (read-only doctor, DESIGN §6.4.3; T16).
# Usage:  powershell -File verify.ps1 [-Probe]
# Keep the anchors, markers and checks in sync with verify.sh.
# Exit codes: 0 healthy; 1 drift detected; 2 usage error. NOTHING is modified.

[CmdletBinding()]
param([switch]$Probe)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($env:DSH_PLUGIN_ROOT) { $PluginRoot = (Resolve-Path -LiteralPath $env:DSH_PLUGIN_ROOT).ProviderPath }
else { $PluginRoot = (Resolve-Path -LiteralPath (Join-Path $ScriptDir '..')).ProviderPath }
$StampPath = Join-Path $PluginRoot 'patches\.applied'

$script:NATIVE_CWD_VERSIONS = @()   # must stay in sync with install.ps1 / install.sh

function Test-VersionWhitelisted ([string]$Version) {
    $extra = @($env:DSH_NATIVE_CWD_VERSIONS -split '[,\s]+' | Where-Object { $_ })
    return (@($script:NATIVE_CWD_VERSIONS) + $extra) -contains $Version
}

function Resolve-LiveRoot {
    if ($env:DSH_HARNESS_ROOT) {
        try { return (Resolve-Path -LiteralPath $env:DSH_HARNESS_ROOT).ProviderPath }
        catch { throw "DSH_HARNESS_ROOT is set to '$($env:DSH_HARNESS_ROOT)' but cannot be resolved." }
    }
    $cmd = Get-Command dsh -ErrorAction SilentlyContinue
    if (-not $cmd) { throw '`Get-Command dsh` found no dsh on PATH.' }
    $binPath = $cmd.Source
    $real = $binPath
    if ($binPath -match '\.(cmd|bat|ps1)$') {
        $text = Get-Content -LiteralPath $binPath -Raw
        if ($text -match '([^\s''"]*[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js)') {
            $target = $Matches[1]
            if (-not [System.IO.Path]::IsPathRooted($target)) { $target = Join-Path (Split-Path -Parent $binPath) $target }
            $real = (Resolve-Path -LiteralPath $target).ProviderPath
        } else { throw "cannot extract the dsh bin.js target from the shim '$binPath'." }
    } else {
        for ($i = 0; $i -lt 10; $i++) {
            $item = Get-Item -LiteralPath $real -ErrorAction Stop
            if ($item.LinkType -eq 'SymbolicLink' -and $item.Target) { $real = $item.Target } else { break }
        }
    }
    $dir = Split-Path -Parent $real
    $root = $null
    while ($dir -and $dir -ne [System.IO.Path]::GetPathRoot($dir)) {
        if ((Split-Path -Leaf $dir) -eq 'node_modules') { $root = Split-Path -Parent $dir; break }
        $dir = Split-Path -Parent $dir
    }
    if (-not $root) { throw "the running dsh binary '$real' is not inside a node_modules tree." }
    return $root
}

$AnchorDriver = "`t`tmeta: childSessionMeta(parent, childDepth, activationBoundary),"
$MarkerDriver = "`t`t`t...childSessionMeta(parent, childDepth, activationBoundary),"
$AnchorBundle = "`t`t`t`t`t`tmeta: childSessionMeta(parent, childDepth, lineageSeedLength),"
$MarkerBundle = "`t`t`t`t`t`t`t...childSessionMeta(parent, childDepth, lineageSeedLength),"

function Get-PatchState ([string]$Target, [string]$Anchor, [string]$Marker) {
    $content = [System.IO]::ReadAllText($Target)
    if ($content.Contains($Marker)) { return 'applied' }
    if ($content.Contains($Anchor)) { return 'unpatched' }
    return 'drifted'
}

$script:Drift = 0

# (a) live root
try {
    $LiveRoot = Resolve-LiveRoot
    if (-not (Test-Path -LiteralPath (Join-Path $LiveRoot 'node_modules\@deepseek-ai\dsh-subagent') -PathType Container)) {
        throw "self-verification failed: '$LiveRoot' does not host @deepseek-ai/dsh-subagent."
    }
    Write-Host "(a) live root        : OK — $LiveRoot"
} catch {
    Write-Host "(a) live root        : DRIFT — $_" -ForegroundColor Red
    Write-Host '    fix: make sure Get-Command dsh finds the running dsh, or set DSH_HARNESS_ROOT; then re-run patches\install.ps1'
    exit 1
}
$pkg = Get-Content -LiteralPath (Join-Path $LiveRoot 'node_modules\@deepseek-ai\dsh\package.json') -Raw | ConvertFrom-Json
$DshVersion = [string]$pkg.version
Write-Host "    dsh version       : $DshVersion"

# (b) both cwd patches, five states
$Stamp = $null
if (Test-Path -LiteralPath $StampPath -PathType Leaf) {
    try { $Stamp = Get-Content -LiteralPath $StampPath -Raw | ConvertFrom-Json } catch { $Stamp = $null }
}

function Report-Patch ([string]$Slot, [string]$Label, [string]$Target, [string]$Anchor, [string]$Marker) {
    if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) {
        Write-Host "(b) $Slot : DRIFT missing — target not in the live root: $Target" -ForegroundColor Red
        $script:Drift = 1
        return
    }
    switch (Get-PatchState $Target $Anchor $Marker) {
        'applied' { Write-Host "(b) $Slot : applied — $Label" }
        'unpatched' {
            Write-Host "(b) $Slot : missing — patch NOT applied — $Label" -ForegroundColor Red
            Write-Host '    fix: re-run patches\install.ps1'
            $script:Drift = 1
        }
        'drifted' {
            if (-not (Test-VersionWhitelisted $DshVersion)) {
                Write-Host "(b) $Slot : drift-anchor — anchor mismatch, dsh $DshVersion not whitelisted — $Label" -ForegroundColor Red
                Write-Host '    fix: a newer plugin release must re-export the patches; check releases/issues.'
                $script:Drift = 1
            } else {
                $key = if ($Slot -like 'b1*') { 'inProcessDriver' } else { 'subagentBundle' }
                $stamped = $Stamp -and $Stamp.patches -and $Stamp.patches.$key
                if ($stamped -eq 'native-verified' -and $Stamp.liveRoot -eq $LiveRoot -and $Stamp.dshVersion -eq $DshVersion) {
                    Write-Host "(b) $Slot : native-verified — stamped for this root + dsh $DshVersion — $Label"
                } else {
                    Write-Host "(b) $Slot : unverified-native — whitelisted but no verified stamp for this root — $Label" -ForegroundColor Red
                    Write-Host '    fix: re-run patches\verify.ps1 -Probe to re-check, then patches\install.ps1 to record the verdict.'
                    $script:Drift = 1
                }
            }
        }
    }
}

Report-Patch 'b1 driver ' 'one-shot driver agents.create({ meta }) merge' `
    (Join-Path $LiveRoot 'node_modules\@deepseek-ai\dsh-subagent-in-process-driver\lib\index.js') $AnchorDriver $MarkerDriver
Report-Patch 'b2 bundle ' 'dsh-subagent BUNDLE continuable create.meta merge' `
    (Join-Path $LiveRoot 'node_modules\@deepseek-ai\dsh-subagent\lib\index.js') $AnchorBundle $MarkerBundle

if ($Probe) {
    Write-Host ''
    Write-Host '-Probe: behavioral probe deep check (read-only)'
    & node (Join-Path $ScriptDir 'probe-cwd.mjs') $LiveRoot
    Write-Host "    probe re-run exit code: $LASTEXITCODE (recording native-verified in the stamp stays install's job)"
}

# (c) both dsh-tools links
$ExpectedTools = Join-Path $LiveRoot 'node_modules\@deepseek-ai\dsh-tools'
$ExpectedReal = (Resolve-Path -LiteralPath $ExpectedTools -ErrorAction SilentlyContinue).ProviderPath

function Report-Link ([string]$Path, [string]$Label) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if (-not $item) {
        Write-Host "(c) link $Label`: DRIFT missing — $Path not found" -ForegroundColor Red
        $script:Drift = 1
        return
    }
    if ($item.LinkType -eq 'SymbolicLink') {
        $resolved = Resolve-Path -LiteralPath $item.Target -ErrorAction SilentlyContinue
        if (-not $resolved) {
            Write-Host "(c) link $Label`: DRIFT dangling — $Path -> $($item.Target)" -ForegroundColor Red
            $script:Drift = 1
        } elseif ($resolved.ProviderPath -eq $ExpectedReal) {
            Write-Host "(c) link $Label`: OK — $Path -> $($item.Target)"
        } else {
            Write-Host "(c) link $Label`: DRIFT wrong-root — resolves to $($resolved.ProviderPath), live root has $ExpectedReal" -ForegroundColor Red
            $script:Drift = 1
        }
    } else {
        Write-Host "(c) link $Label`: DRIFT unexpected-copy — $Path is not the live-root symlink" -ForegroundColor Red
        $script:Drift = 1
    }
}

Write-Host ''
Write-Host '(c) dsh-tools links vs live root:'
Report-Link (Join-Path $PluginRoot 'node_modules\@deepseek-ai\dsh-tools') 'plugin-repo'
$DshHomeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profilesRoot = Join-Path $DshHomeDir 'profiles'
if (Test-Path -LiteralPath $profilesRoot -PathType Container) {
    Get-ChildItem -LiteralPath $profilesRoot -Directory | ForEach-Object {
        $tools = Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh-tools'
        if ((Test-Path -LiteralPath $tools) -or (Get-Item -LiteralPath $tools -Force -ErrorAction SilentlyContinue).LinkType) {
            Report-Link $tools ("profile:" + $_.Name)
        }
    }
}

# (d) repo dsh-subagent copy vs live root — warning only (§6.4.4)
Write-Host ''
$RepoSubagent = Join-Path $PluginRoot 'node_modules\@deepseek-ai\dsh-subagent\package.json'
$LiveSubagent = Join-Path $LiveRoot 'node_modules\@deepseek-ai\dsh-subagent\package.json'
if ((Test-Path -LiteralPath $RepoSubagent) -and (Test-Path -LiteralPath $LiveSubagent)) {
    $repoV = [string](Get-Content -LiteralPath $RepoSubagent -Raw | ConvertFrom-Json).version
    $liveV = [string](Get-Content -LiteralPath $LiveSubagent -Raw | ConvertFrom-Json).version
    if ($repoV -eq $liveV) {
        Write-Host "(d) dsh-subagent copy : OK — both $repoV (warning-only check)"
    } else {
        Write-Host "(d) dsh-subagent copy : WARNING — repo $repoV vs live root $liveV (non-fatal: pure-function imports, §6.4.4)"
    }
} else {
    Write-Host '(d) dsh-subagent copy : skipped — no repo/local copy to compare (warning-only check)'
}

Write-Host ''
if ($script:Drift -ne 0) {
    Write-Host 'verify: FAIL — drift detected. One-line fix: re-run patches\install.ps1' -ForegroundColor Red
    Write-Host '        (stage A repairs the links, stage B re-applies/re-judges the patches; -LinksOnly for links alone).'
    exit 1
}
Write-Host 'verify: OK — live root, both cwd patches, and both dsh-tools links are healthy.'
exit 0
