<#
.SYNOPSIS
  Install the “delete conversation + recycle bin” plugin.

.DESCRIPTION
  When this folder lives inside a shared plugins root, the script delegates to
  ..\install-plugin.ps1 (which also updates plugins.json). Otherwise it runs a
  self-contained install: create the profile junction, write the managed
  cordis.patch.yml block, and leave the plugin payload in this folder. No files
  are copied onto the C: drive.

.PARAMETER ProfileDir
  The desktop profile directory. Defaults to ~/.dsh/profiles/desktop.
#>
param(
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$manager = Join-Path (Split-Path $source) 'install-plugin.ps1'

if (Test-Path $manager) {
  & $manager -Name 'session-delete' -ProfileDir $ProfileDir
  return
}

# ── self-contained install ──────────────────────────────────────────────────
$manifestPath = Join-Path $source 'package.json'
if (-not (Test-Path $manifestPath)) {
  throw "Missing package.json: $manifestPath"
}
$package = [string](Get-Content $manifestPath -Raw | ConvertFrom-Json).name
if ([string]::IsNullOrWhiteSpace($package)) {
  throw "package.json has no name: $manifestPath"
}
foreach ($required in 'lib\index.js', 'lib\client.js') {
  if (-not (Test-Path (Join-Path $source $required))) {
    throw "Plugin payload is incomplete: missing $required under $source"
  }
}
if (-not (Test-Path $ProfileDir)) {
  throw "DSH profile not found: $ProfileDir"
}

$nodeModules = Join-Path $ProfileDir 'node_modules'
New-Item -ItemType Directory -Force $nodeModules | Out-Null
$target = Join-Path $nodeModules $package
if (Test-Path $target) {
  $item = Get-Item $target -Force
  if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Refusing to replace a real directory: $target. Move it away manually, then rerun."
  }
  if (([string]$item.Target).TrimEnd('\') -ne $source.TrimEnd('\')) {
    throw "Junction already points elsewhere: $target -> $([string]$item.Target)"
  }
} else {
  New-Item -ItemType Junction -Path $target -Target $source | Out-Null
}
Write-Host "Junction: $target -> $source"

$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
$patch = if (Test-Path $patchPath) { [IO.File]::ReadAllText($patchPath) } else { "[]`n" }
$markerStart = '# >>> dsh-plugin:session-delete'
$markerEnd = '# <<< dsh-plugin:session-delete'
$markerPattern = '(?ms)^' + [regex]::Escape($markerStart) + '\r?\n.*?^' + [regex]::Escape($markerEnd) + '\r?\n?'
$block = $markerStart + "`n- insert:`n    - id: session-delete`n      name: `"$package`"`n      config: {}`n" + $markerEnd + "`n"

$trimmed = $patch.Trim()
if ($trimmed -eq '' -or $trimmed -eq '[]') {
  $patch = $block
} elseif ($patch -match $markerPattern) {
  $patch = [regex]::Replace($patch, $markerPattern, $block)
} else {
  $idRe = '(?m)^\s*-?\s*id:\s*[''"]?session-delete[''"]?\s*$'
  $nameRe = '(?m)^\s*name:\s*[''"]?' + [regex]::Escape($package) + '[''"]?\s*$'
  if ($patch -match $idRe) {
    throw "Profile already has a row with id 'session-delete' outside the managed block."
  }
  if ($patch -match $nameRe) {
    throw "Profile already has a row with package '$package' outside the managed block."
  }
  $patch = $patch.TrimEnd() + "`n`n" + $block
}
[IO.File]::WriteAllText($patchPath, $patch, [Text.UTF8Encoding]::new($false))
Write-Host "Profile block: $markerStart ... $markerEnd in $patchPath"
Write-Host "Installed. Refresh the Harness page (Ctrl+R) or restart it if the entry does not appear."
