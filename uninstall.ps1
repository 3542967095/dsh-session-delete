<#
.SYNOPSIS
  Uninstall the “delete conversation + recycle bin” plugin.

.DESCRIPTION
  When this folder lives inside a shared plugins root, the script delegates to
  ..\uninstall-plugin.ps1 (which also updates plugins.json). Otherwise it
  removes only this plugin's managed config block and profile junction; the
  plugin folder and the recycle-bin data stay intact.

.PARAMETER ProfileDir
  The desktop profile directory. Defaults to ~/.dsh/profiles/desktop.
#>
param(
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$manager = Join-Path (Split-Path $source) 'uninstall-plugin.ps1'

if (Test-Path $manager) {
  & $manager -Name 'session-delete' -ProfileDir $ProfileDir
  return
}

# ── self-contained uninstall ────────────────────────────────────────────────
$manifestPath = Join-Path $source 'package.json'
if (-not (Test-Path $manifestPath)) {
  throw "Missing package.json: $manifestPath"
}
$package = [string](Get-Content $manifestPath -Raw | ConvertFrom-Json).name

$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
if (Test-Path $patchPath) {
  $patch = [IO.File]::ReadAllText($patchPath)
  $markerStart = '# >>> dsh-plugin:session-delete'
  $markerEnd = '# <<< dsh-plugin:session-delete'
  $markerPattern = '(?ms)^' + [regex]::Escape($markerStart) + '\r?\n.*?^' + [regex]::Escape($markerEnd) + '\r?\n?'
  if ($patch -match $markerPattern) {
    $updated = [regex]::Replace($patch, $markerPattern, '')
    if ($updated.Trim() -eq '') { $updated = "[]`n" } else { $updated = $updated.TrimEnd() + "`n" }
    Copy-Item $patchPath "$patchPath.bak-session-delete" -Force
    [IO.File]::WriteAllText($patchPath, $updated, [Text.UTF8Encoding]::new($false))
    Write-Host "Removed profile block from $patchPath (backup: $patchPath.bak-session-delete)"
  } else {
    Write-Warning "No managed block found in $patchPath; a hand-written row may still exist."
  }
}

$target = Join-Path (Join-Path $ProfileDir 'node_modules') $package
if (Test-Path $target) {
  $item = Get-Item $target -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    if (([string]$item.Target).TrimEnd('\') -eq $source.TrimEnd('\')) {
      [IO.Directory]::Delete($target)
      Write-Host "Removed junction $target"
    } else {
      throw "Junction points to another plugin, refusing to remove: $target -> $([string]$item.Target)"
    }
  } else {
    throw "Refusing to delete a real directory: $target"
  }
}

Write-Host "Uninstalled. The plugin folder and recycle-bin data were left intact."
Write-Host "Restart DeepSeek Harness if the UI does not drop the entries."
