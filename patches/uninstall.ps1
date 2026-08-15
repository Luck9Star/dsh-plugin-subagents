# uninstall.ps1 — Windows twin of uninstall.sh (T16).
# Restores the two cwd-patched targets from their .bak_cwd backups and removes
# patches\.applied. DELIBERATELY does NOT roll back the Stage A dsh-tools links
# (deployment health, not plugin state — DESIGN §6.4.2 uninstall note).
# Usage:  powershell -File uninstall.ps1     Exit code is always 0 (best-effort, loud).

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($env:DSH_PLUGIN_ROOT) { $PluginRoot = (Resolve-Path -LiteralPath $env:DSH_PLUGIN_ROOT).ProviderPath }
else { $PluginRoot = (Resolve-Path -LiteralPath (Join-Path $ScriptDir '..')).ProviderPath }
$StampPath = Join-Path $PluginRoot 'patches\.applied'

function Resolve-LiveRoot {
    if ($env:DSH_HARNESS_ROOT) {
        try { return (Resolve-Path -LiteralPath $env:DSH_HARNESS_ROOT).ProviderPath } catch { return $null }
    }
    $cmd = Get-Command dsh -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    $binPath = $cmd.Source
    $real = $binPath
    if ($binPath -match '\.(cmd|bat|ps1)$') {
        $text = Get-Content -LiteralPath $binPath -Raw
        if ($text -match '([^\s''"]*[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js)') {
            $target = $Matches[1]
            if (-not [System.IO.Path]::IsPathRooted($target)) { $target = Join-Path (Split-Path -Parent $binPath) $target }
            $real = (Resolve-Path -LiteralPath $target -ErrorAction Stop).ProviderPath
        } else { return $null }
    } else {
        for ($i = 0; $i -lt 10; $i++) {
            $item = Get-Item -LiteralPath $real -ErrorAction Stop
            if ($item.LinkType -eq 'SymbolicLink' -and $item.Target) { $real = $item.Target } else { break }
        }
    }
    $dir = Split-Path -Parent $real
    while ($dir -and $dir -ne [System.IO.Path]::GetPathRoot($dir)) {
        if ((Split-Path -Leaf $dir) -eq 'node_modules') {
            $root = Split-Path -Parent $dir
            if (Test-Path -LiteralPath (Join-Path $root 'node_modules\@deepseek-ai\dsh-subagent') -PathType Container) { return $root }
            return $null
        }
        $dir = Split-Path -Parent $dir
    }
    return $null
}

$MarkerDriver = "`t`t`t...childSessionMeta(parent, childDepth, activationBoundary),"
$MarkerBundle = "`t`t`t`t`t`t`t...childSessionMeta(parent, childDepth, lineageSeedLength),"

$LiveRoot = Resolve-LiveRoot
if (-not $LiveRoot -and (Test-Path -LiteralPath $StampPath -PathType Leaf)) {
    try {
        $stamp = Get-Content -LiteralPath $StampPath -Raw | ConvertFrom-Json
        if ($stamp.liveRoot -and (Test-Path -LiteralPath $stamp.liveRoot)) {
            $LiveRoot = $stamp.liveRoot
            Write-Host "[info] live root unresolvable; using the stamp-recorded root: $LiveRoot"
        }
    } catch { }
}

function Restore-Target ([string]$PkgDir, [string]$Slot, [string]$Marker) {
    if (-not $LiveRoot) { Write-Host "[skip] ${Slot}: live root unresolvable"; return }
    $target = Join-Path $LiveRoot (Join-Path 'node_modules' (Join-Path $PkgDir 'lib\index.js'))
    $bak = "$target.bak_cwd"
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { Write-Host "[skip] ${Slot}: target not found ($target)"; return }
    if (Test-Path -LiteralPath $bak -PathType Leaf) {
        Copy-Item -LiteralPath $bak -Destination $target -Force
        Remove-Item -LiteralPath $bak -Force
        Write-Host "[ok]   ${Slot}: restored $target from $(Split-Path -Leaf $bak)"
    } elseif ([System.IO]::ReadAllText($target).Contains($Marker)) {
        Write-Host "[warn] ${Slot}: patch marker present but NO backup — cannot restore automatically: $target"
        Write-Host '       reinstall the @deepseek-ai package or re-run install.ps1 to regenerate a backup.'
    } else {
        Write-Host "[skip] ${Slot}: not patched, nothing to restore ($target)"
    }
}

Restore-Target '@deepseek-ai\dsh-subagent-in-process-driver' 'driver' $MarkerDriver
Restore-Target '@deepseek-ai\dsh-subagent' 'bundle' $MarkerBundle

if (Test-Path -LiteralPath $StampPath -PathType Leaf) {
    Remove-Item -LiteralPath $StampPath -Force
    Write-Host "[ok]   stamp removed: $StampPath"
}

Write-Host ''
Write-Host '[note] Stage A dsh-tools links were intentionally LEFT IN PLACE (deployment health, not plugin state).'
Write-Host 'Done. Restart dsh for the restored files to take effect.'
exit 0
