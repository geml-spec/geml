# File-type icons for .geml / .gemlhistory in Windows Explorer.
#
# Installs per-user (HKCU) -- no administrator rights, nothing machine-wide.
# The icon is copied to %LOCALAPPDATA%\GEML\geml.ico so it keeps working if
# this checkout moves or is deleted.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -OpenWith "C:\...\Code.exe"
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
#
# -OpenWith also registers the double-click handler. Without it, the first
# double-click shows Windows' "open with" prompt -- if you then pick "always
# use this app", Windows records a UserChoice whose icon may override this
# one; passing -OpenWith avoids that path entirely.
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [string]$OpenWith = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

# ext -> ProgID, description. The sidecar gets the same icon: it travels with
# the document and should read as part of the same family.
$classes = @(
  @{ Ext = ".geml";        ProgId = "GEML.Document"; Desc = "GEML document" },
  @{ Ext = ".gemlhistory"; ProgId = "GEML.History";  Desc = "GEML history sidecar" }
)
$iconDir  = Join-Path $env:LOCALAPPDATA "GEML"
$iconDest = Join-Path $iconDir "geml.ico"

function Refresh-IconCache {
  # ie4uinit rebuilds Explorer's icon cache without restarting it. Best
  # effort: on failure the icons still apply after the next sign-in.
  try { Start-Process -FilePath "ie4uinit.exe" -ArgumentList "-show" -NoNewWindow -Wait } catch {}
}

if ($Uninstall) {
  foreach ($c in $classes) {
    foreach ($key in @("HKCU:\Software\Classes\$($c.Ext)", "HKCU:\Software\Classes\$($c.ProgId)")) {
      if (Test-Path $key) {
        # Only remove the extension mapping if it still points at our ProgId --
        # never tear down an association some other tool has since claimed.
        if ($key -like "*\.geml*" ) {
          $cur = (Get-ItemProperty $key -ErrorAction SilentlyContinue).'(default)'
          if ($cur -and $cur -ne $c.ProgId) { Write-Host "skip $key (now owned by $cur)"; continue }
        }
        Remove-Item $key -Recurse -Force
        Write-Host "removed $key"
      }
    }
  }
  if (Test-Path $iconDest) { Remove-Item $iconDest -Force; Write-Host "removed $iconDest" }
  if ((Test-Path $iconDir) -and -not (Get-ChildItem $iconDir)) { Remove-Item $iconDir }
  Refresh-IconCache
  Write-Host "done -- .geml and .gemlhistory are unregistered."
  exit 0
}

$iconSrc = Join-Path $PSScriptRoot "geml.ico"
if (-not (Test-Path $iconSrc)) { Write-Error "geml.ico not found next to this script"; exit 1 }
if ($OpenWith -and -not (Test-Path $OpenWith)) { Write-Error "-OpenWith target not found: $OpenWith"; exit 1 }

New-Item -ItemType Directory -Force $iconDir | Out-Null
Copy-Item $iconSrc $iconDest -Force

foreach ($c in $classes) {
  $extKey = "HKCU:\Software\Classes\$($c.Ext)"

  # Refuse to silently steal an extension another tool already claimed.
  if (Test-Path $extKey) {
    $cur = (Get-ItemProperty $extKey -ErrorAction SilentlyContinue).'(default)'
    if ($cur -and $cur -ne $c.ProgId -and -not $Force) {
      Write-Error "$($c.Ext) is already associated with '$cur' -- re-run with -Force to overwrite"
      exit 1
    }
  }

  New-Item -Path $extKey -Force | Out-Null
  Set-ItemProperty -Path $extKey -Name "(default)" -Value $c.ProgId

  $progKey = "HKCU:\Software\Classes\$($c.ProgId)"
  New-Item -Path "$progKey\DefaultIcon" -Force | Out-Null
  Set-ItemProperty -Path $progKey -Name "(default)" -Value $c.Desc
  Set-ItemProperty -Path "$progKey\DefaultIcon" -Name "(default)" -Value "$iconDest,0"

  if ($OpenWith) {
    New-Item -Path "$progKey\shell\open\command" -Force | Out-Null
    Set-ItemProperty -Path "$progKey\shell\open\command" -Name "(default)" -Value ('"' + $OpenWith + '" "%1"')
  }

  Write-Host "registered $($c.Ext) -> $($c.ProgId)"
}

Refresh-IconCache
Write-Host "done -- Explorer now shows the GEML logo for .geml and .gemlhistory files."
if (-not $OpenWith) {
  Write-Host "tip: pass -OpenWith `"C:\path\to\your\editor.exe`" to also set the double-click handler."
}
