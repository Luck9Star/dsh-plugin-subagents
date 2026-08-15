# install.ps1 — Windows twin of install.sh (two-stage installer, DESIGN §6.4.2; T16).
# Usage:  powershell -File install.ps1 [-LinksOnly]
# Keep the anchors, markers, whitelist and stage order in sync with install.sh.
# Exit codes: 0 success/idempotent; 1 resolution or Stage A failure; 3 Stage B drift.

[CmdletBinding()]
param([switch]$LinksOnly)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($env:DSH_PLUGIN_ROOT) { $PluginRoot = (Resolve-Path -LiteralPath $env:DSH_PLUGIN_ROOT).ProviderPath }
else { $PluginRoot = (Resolve-Path -LiteralPath (Join-Path $ScriptDir '..')).ProviderPath }
$StampPath = Join-Path $PluginRoot 'patches\.applied'

# Gate 1 constant (§6.4.2-c): manually verified natively-forwarding dsh versions.
# INTENTIONALLY EMPTY for 0.1.0-rc.6 (red line 12).
$script:NATIVE_CWD_VERSIONS = @()

function Write-Loud ([string]$Message) { Write-Host "install.ps1: $Message" -ForegroundColor Red }

# ---- live root resolution (§6.4.1: no hardcoded hash paths, no heuristics) ----
function Resolve-LiveRoot {
    if ($env:DSH_HARNESS_ROOT) {
        try { return (Resolve-Path -LiteralPath $env:DSH_HARNESS_ROOT).ProviderPath }
        catch { throw "DSH_HARNESS_ROOT is set to '$($env:DSH_HARNESS_ROOT)' but cannot be resolved." }
    }
    $cmd = Get-Command dsh -ErrorAction SilentlyContinue
    if (-not $cmd) { throw '`Get-Command dsh` found no dsh on PATH.' }
    $binPath = $cmd.Source
    $real = $binPath
    # npm .cmd/.bat/.ps1 shims embed the real bin.js target; extract then resolve.
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

function Get-DshVersion ([string]$Root) {
    $pkg = Get-Content -LiteralPath (Join-Path $Root 'node_modules\@deepseek-ai\dsh\package.json') -Raw | ConvertFrom-Json
    return [string]$pkg.version
}

function Test-VersionWhitelisted ([string]$Version) {
    $extra = @($env:DSH_NATIVE_CWD_VERSIONS -split '[,\s]+' | Where-Object { $_ })
    return (@($script:NATIVE_CWD_VERSIONS) + $extra) -contains $Version
}

# ---- cwd patch descriptors (byte-identical to the .patch hunks; see resolve-root.sh) ----
$AnchorDriver = "`t`tmeta: childSessionMeta(parent, childDepth, activationBoundary),"
$MarkerDriver = "`t`t`t...childSessionMeta(parent, childDepth, activationBoundary),"
$ReplaceDriver = "`t`tmeta: {`n`t`t`t...childSessionMeta(parent, childDepth, activationBoundary),`n`t`t`t...request.cwd !== void 0 ? { cwd: request.cwd } : {}`n`t`t},"
$AnchorBundle = "`t`t`t`t`t`tmeta: childSessionMeta(parent, childDepth, lineageSeedLength),"
$MarkerBundle = "`t`t`t`t`t`t`t...childSessionMeta(parent, childDepth, lineageSeedLength),"
$ReplaceBundle = "`t`t`t`t`t`tmeta: {`n`t`t`t`t`t`t`t...childSessionMeta(parent, childDepth, lineageSeedLength),`n`t`t`t`t`t`t`t...request.cwd !== void 0 ? { cwd: request.cwd } : {}`n`t`t`t`t`t`t},"

function Get-PatchState ([string]$Target, [string]$Anchor, [string]$Marker) {
    $content = [System.IO]::ReadAllText($Target)
    if ($content.Contains($Marker)) { return 'applied' }
    if ($content.Contains($Anchor)) { return 'unpatched' }
    return 'drifted'
}

# ---- 0. root -----------------------------------------------------------------
try { $LiveRoot = Resolve-LiveRoot }
catch {
    Write-Loud "FATAL: $_ Supported forms: npx cache install / global install (Get-Command dsh resolves the root) / export DSH_HARNESS_ROOT."
    exit 1
}
$DshVersion = Get-DshVersion $LiveRoot
Write-Host "[ok] live root  : $LiveRoot"
Write-Host "[ok] dsh version: $DshVersion"
Write-Host "[ok] plugin root: $PluginRoot"

# ---- Stage A: dsh-tools links (mandatory, first) ------------------------------
$ExpectedTools = Join-Path $LiveRoot 'node_modules\@deepseek-ai\dsh-tools'
if (-not (Test-Path -LiteralPath $ExpectedTools -PathType Container)) {
    Write-Loud "FATAL: the live root's dsh-tools package is missing ('$ExpectedTools')."
    exit 1
}
$ExpectedReal = (Resolve-Path -LiteralPath $ExpectedTools).ProviderPath
$Links = [ordered]@{}

function Repair-Link ([string]$Path, [string]$Key) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    $ok = $false
    if ($item -and $item.LinkType -eq 'SymbolicLink' -and $item.Target) {
        $resolved = Resolve-Path -LiteralPath $item.Target -ErrorAction SilentlyContinue
        if ($resolved -and $resolved.ProviderPath -eq $ExpectedReal) { $ok = $true }
    }
    if ($ok) {
        Write-Host "[link] ok (already correct): $Path"
        $script:Links[$Key] = 'ok'
        return
    }
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    try { New-Item -ItemType SymbolicLink -Path $Path -Target $ExpectedTools -ErrorAction Stop | Out-Null }
    catch {
        Write-Loud "FATAL: cannot create symlink $Path -> $ExpectedTools (enable Windows Developer Mode or run elevated)."
        exit 1
    }
    Write-Host "[link] fixed: $Path -> $ExpectedTools"
    $script:Links[$Key] = 'fixed'
}

Write-Host ''
Write-Host '== Stage A: dsh-tools single-instance links (mandatory) =='
Repair-Link (Join-Path $PluginRoot 'node_modules\@deepseek-ai\dsh-tools') 'plugin-repo'
$DshHomeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profilesRoot = Join-Path $DshHomeDir 'profiles'
if (Test-Path -LiteralPath $profilesRoot -PathType Container) {
    Get-ChildItem -LiteralPath $profilesRoot -Directory | ForEach-Object {
        $tools = Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh-tools'
        if ((Test-Path -LiteralPath $tools -PathType Container) -or (Get-Item -LiteralPath $tools -Force -ErrorAction SilentlyContinue).LinkType) {
            Repair-Link $tools ("profile:" + $_.Name)
        }
    }
}
Write-Host '[ok] stage A complete: both dsh-tools references point at the live root.'

if ($LinksOnly) {
    Write-Host ''
    Write-Host 'Done (-LinksOnly): cwd patches were NOT evaluated; patches\.applied was not written.'
    exit 0
}

# ---- Stage B: cwd patches (per-patch four-state machine) ----------------------
Write-Host ''
Write-Host '== Stage B: cwd patches (per-patch four-state machine) =='
$TargetDriver = Join-Path $LiveRoot 'node_modules\@deepseek-ai\dsh-subagent-in-process-driver\lib\index.js'
$TargetBundle = Join-Path $LiveRoot 'node_modules\@deepseek-ai\dsh-subagent\lib\index.js'
$script:StateDriver = 'missing'
$script:StateBundle = 'missing'
$script:Errors = 0
$script:ProbeRan = $false
$script:ProbeRc = 1

function Invoke-CwdProbe {
    if (-not $script:ProbeRan) {
        $script:ProbeRan = $true
        & node (Join-Path $ScriptDir 'probe-cwd.mjs') $LiveRoot
        $script:ProbeRc = $LASTEXITCODE
        Write-Host "[probe] behavioral probe exit code: $($script:ProbeRc)"
    }
}

function Invoke-PatchApply ([string]$Target, [string]$Anchor, [string]$Replacement) {
    $bak = "$Target.bak_cwd"
    if (-not (Test-Path -LiteralPath $bak -PathType Leaf)) {
        Copy-Item -LiteralPath $Target -Destination $bak
        Write-Host "[bak]   $bak"
    }
    $content = [System.IO]::ReadAllText($Target)
    $at = $content.IndexOf($Anchor)
    if ($at -lt 0) { Write-Loud "anchored replacement failed on $Target (anchor disappeared)."; return $false }
    [System.IO]::WriteAllText($Target, $content.Remove($at, $Anchor.Length).Insert($at, $Replacement))
    & node --check $Target
    if ($LASTEXITCODE -ne 0) {
        Copy-Item -LiteralPath $bak -Destination $Target -Force
        Write-Loud "node --check rejected the patched $Target — backup restored."
        return $false
    }
    Write-Host "[patch] applied: $Target"
    return $true
}

function Invoke-PatchEvaluate ([string]$Slot, [string]$Target, [string]$Anchor, [string]$Marker, [string]$Replacement) {
    if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) {
        Write-Loud "${Slot}: target file not found in the live root: $Target"
        $script:Errors++
        return
    }
    switch (Get-PatchState $Target $Anchor $Marker) {
        'applied' {
            Write-Host "[patch] already applied (idempotent): $Target"
            Set-Variable -Name "State$Slot" -Value 'applied' -Scope Script
        }
        'unpatched' {
            if (Invoke-PatchApply $Target $Anchor $Replacement) { Set-Variable -Name "State$Slot" -Value 'applied' -Scope Script }
            else { Set-Variable -Name "State$Slot" -Value 'missing' -Scope Script; $script:Errors++ }
        }
        'drifted' {
            # Native support requires BOTH gates (fail closed); request.cwd
            # text-grepping is forbidden as evidence (§6.4.2-c).
            if (Test-VersionWhitelisted $DshVersion) {
                Invoke-CwdProbe
                if ($script:ProbeRc -eq 0) {
                    Write-Host "[patch] native-verified: dsh $DshVersion forwards request.cwd natively — no patch applied: $Target"
                    Set-Variable -Name "State$Slot" -Value 'native-verified' -Scope Script
                } else {
                    Write-Loud "${Slot}: unverified-native — dsh $DshVersion is whitelisted but the behavioral probe did not confirm it (suspected whitelist mis-entry or probe environment problem). Re-check with: patches\verify.ps1 -Probe"
                    Set-Variable -Name "State$Slot" -Value 'unverified-native' -Scope Script
                    $script:Errors++
                }
            } else {
                Write-Loud "${Slot}: drift-anchor — the cwd patch anchor no longer matches dsh $DshVersion. Remediation: a NEWER PLUGIN RELEASE must re-export the patches; check the releases/issues."
                Set-Variable -Name "State$Slot" -Value 'drift-anchor' -Scope Script
                $script:Errors++
            }
        }
    }
}

Invoke-PatchEvaluate 'Driver' $TargetDriver $AnchorDriver $MarkerDriver $ReplaceDriver
Invoke-PatchEvaluate 'Bundle' $TargetBundle $AnchorBundle $MarkerBundle $ReplaceBundle

# ---- Stage C: stamp -----------------------------------------------------------
$doc = [ordered]@{
    dshVersion  = $DshVersion
    liveRoot    = $LiveRoot
    appliedAt   = (Get-Date).ToUniversalTime().ToString('o')
    patches     = [ordered]@{ inProcessDriver = $script:StateDriver; subagentBundle = $script:StateBundle }
    mtimes      = [ordered]@{
        inProcessDriver = if (Test-Path -LiteralPath $TargetDriver) { (Get-Item -LiteralPath $TargetDriver).LastWriteTimeUtc.ToString('o') } else { $null }
        subagentBundle = if (Test-Path -LiteralPath $TargetBundle) { (Get-Item -LiteralPath $TargetBundle).LastWriteTimeUtc.ToString('o') } else { $null }
    }
    links       = $Links
}
$doc | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StampPath -Encoding UTF8
Write-Host "[ok] stamp written: $StampPath"

Write-Host ''
Write-Host "Summary: inProcessDriver=$($script:StateDriver)  subagentBundle=$($script:StateBundle)"
if ($script:Errors -gt 0) {
    Write-Host ''
    Write-Loud 'Stage A (dsh-tools links) already completed — only the cwd patch stage failed. Per-call cwd stays disabled until the patch states are applied | native-verified.'
    exit 3
}
Write-Host 'Done. Restart dsh for the patched files to take effect.'
exit 0
