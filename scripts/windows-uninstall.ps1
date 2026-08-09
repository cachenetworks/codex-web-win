param(
  [switch]$Yes,
  [switch]$KeepData,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:OS -ne "Windows_NT") {
  throw "This uninstaller supports Windows only"
}
Add-Type -AssemblyName System.Windows.Forms

$ProductName = "Codex ChatGPT Web"
$UninstallRegistryPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexChatGPTWeb"
$InstallConfigurationName = "codex-chatgpt-web.install"
$OwnershipMarkerName = ".codex-chatgpt-web-owned"
$OwnershipMarkerContent = "codex-chatgpt-web private state v1`n"
$DocumentNames = @(
  "LICENSE",
  "NOTICE.md",
  "OpenCodex-MIT.txt",
  "Bun-1.3.11.md",
  "THIRD_PARTY_NOTICES.txt",
  "WINDOWS_SETUP.md"
)

function Show-Message {
  param(
    [string]$Text,
    [string]$Title,
    [System.Windows.Forms.MessageBoxIcon]$Icon = [System.Windows.Forms.MessageBoxIcon]::Information
  )
  if (-not $Quiet) {
    [System.Windows.Forms.MessageBox]::Show(
      $Text,
      $Title,
      [System.Windows.Forms.MessageBoxButtons]::OK,
      $Icon
    ) | Out-Null
  }
}

function ConvertFrom-Base64 {
  param([string]$Value)
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

function Quote-PowerShellLiteral {
  param([string]$Value)
  return "'$($Value.Replace("'", "''"))'"
}

function Get-NormalizedPath {
  param([string]$Path)
  return [IO.Path]::GetFullPath($Path).TrimEnd("\")
}

function Get-KnownFolderPath {
  param(
    [Environment+SpecialFolder]$Folder,
    [string]$Label
  )
  $path = [Environment]::GetFolderPath($Folder)
  if ([string]::IsNullOrWhiteSpace($path)) {
    throw "Windows did not provide the current $Label path"
  }
  return Get-NormalizedPath $path
}

function Assert-SafeOwnedPath {
  param([string]$Path, [string]$Label)
  $fullPath = Get-NormalizedPath $Path
  $forbidden = @(
    [IO.Path]::GetPathRoot($fullPath),
    (Get-KnownFolderPath -Folder ([Environment+SpecialFolder]::UserProfile) -Label "user profile"),
    $env:SystemRoot,
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)},
    $env:ProgramData,
    (Get-KnownFolderPath -Folder ([Environment+SpecialFolder]::LocalApplicationData) -Label "local application data"),
    (Get-KnownFolderPath -Folder ([Environment+SpecialFolder]::ApplicationData) -Label "roaming application data")
  ) | Where-Object { $_ } | ForEach-Object { Get-NormalizedPath $_ }
  if ($forbidden | Where-Object { $fullPath -ieq $_ }) {
    throw "Refusing to remove a broad $Label path: $fullPath"
  }
  return $fullPath
}

function Remove-ShortcutIfOwned {
  param([string]$Path, [string]$ExpectedTarget)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }
  $shell = $null
  $shortcut = $null
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    if ((Get-NormalizedPath $shortcut.TargetPath) -ieq (Get-NormalizedPath $ExpectedTarget)) {
      Remove-Item -LiteralPath $Path -Force
    }
  } catch {
    return
  } finally {
    if ($shortcut) {
      [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null
    }
    if ($shell) {
      [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
    }
  }
}

function Stop-InstalledGui {
  param([string]$GuiPath)
  foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
    $candidate = $null
    try {
      $candidate = $process.MainModule.FileName
    } catch {
      continue
    }
    if ((Get-NormalizedPath $candidate) -ine (Get-NormalizedPath $GuiPath)) {
      continue
    }
    try {
      if ($process.CloseMainWindow()) {
        $process.WaitForExit(5000) | Out-Null
      }
      if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
        $process.WaitForExit(5000) | Out-Null
      }
    } finally {
      $process.Dispose()
    }
  }
}

function Wait-FileUnlocked {
  param([string]$Path, [int]$TimeoutSeconds = 15)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while (Test-Path -LiteralPath $Path -PathType Leaf) {
    $stream = $null
    try {
      $stream = [IO.File]::Open(
        $Path,
        [IO.FileMode]::Open,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None
      )
      return
    } catch {
      if ([DateTime]::UtcNow -ge $deadline) {
        throw "A running Codex ChatGPT Web process did not stop in time: $Path"
      }
      Start-Sleep -Milliseconds 100
    } finally {
      if ($stream) {
        $stream.Dispose()
      }
    }
  }
}

function Remove-VerifiedRuntimeVersions {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    return
  }
  foreach ($directory in @(Get-ChildItem -LiteralPath $Path -Directory -Force)) {
    $manifestPath = Join-Path $directory.FullName "manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
      continue
    }
    try {
      $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    } catch {
      continue
    }
    if ($manifest.schemaVersion -eq 1 -and
        $manifest.platform -eq "win32" -and
        $manifest.appVersion -eq $directory.Name -and
        $manifest.launcher -eq "bin/codex-chatgpt-web.exe") {
      Remove-Item -LiteralPath $directory.FullName -Recurse -Force
    }
  }
}

function Remove-UserPathEntry {
  param([string]$Path)
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $userPath) {
    return
  }
  $entries = @($userPath.Split(";") | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_) -and
    $_.TrimEnd("\") -ine $Path.TrimEnd("\")
  })
  [Environment]::SetEnvironmentVariable("Path", ($entries -join ";"), "User")
}

function Start-FinalCleanup {
  param(
    [string]$UninstallerPath,
    [string[]]$EmptyDirectories,
    [string]$DefaultInstallRoot,
    [bool]$RemoveUninstallRegistration
  )
  $directoryCommands = @()
  foreach ($directory in @($EmptyDirectories | Select-Object -Unique)) {
    $literal = Quote-PowerShellLiteral $directory
    $directoryCommands += @"
if (Test-Path -LiteralPath $literal -PathType Container) {
  if (@(Get-ChildItem -LiteralPath $literal -Force).Count -eq 0) {
    Remove-Item -LiteralPath $literal -Force
  }
}
"@
  }
  $defaultRootLiteral = Quote-PowerShellLiteral $DefaultInstallRoot
  $uninstallerLiteral = Quote-PowerShellLiteral $UninstallerPath
  $registryCommand = if ($RemoveUninstallRegistration) {
    $registryLiteral = Quote-PowerShellLiteral $UninstallRegistryPath
    "Remove-Item -LiteralPath $registryLiteral -Recurse -Force"
  } else {
    ""
  }
  $cleanup = @"
`$ErrorActionPreference = "SilentlyContinue"
Wait-Process -Id $PID
Start-Sleep -Milliseconds 100
Remove-Item -LiteralPath $uninstallerLiteral -Force
$($directoryCommands -join "`n")
if (Test-Path -LiteralPath $defaultRootLiteral -PathType Container) {
  if (@(Get-ChildItem -LiteralPath $defaultRootLiteral -Force).Count -eq 0) {
    Remove-Item -LiteralPath $defaultRootLiteral -Force
  }
}
$registryCommand
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cleanup))
  $powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  Start-Process -FilePath $powerShell -WindowStyle Hidden -ArgumentList @(
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle", "Hidden",
    "-EncodedCommand", $encoded
  ) | Out-Null
}

try {
  if ($Quiet) {
    $Yes = $true
  }
  if (-not $Yes) {
    $confirmation = [System.Windows.Forms.MessageBox]::Show(
      "Remove Codex ChatGPT Web from this Windows account? Any active foreground session and GUI will be stopped.",
      "Uninstall $ProductName",
      [System.Windows.Forms.MessageBoxButtons]::YesNo,
      [System.Windows.Forms.MessageBoxIcon]::Question
    )
    if ($confirmation -ne [System.Windows.Forms.DialogResult]::Yes) {
      exit 0
    }
    $dataChoice = [System.Windows.Forms.MessageBox]::Show(
      "Keep private ChatGPT browser and configuration data?`n`nYes: keep private data for a later reinstall.`nNo: remove private data too.`nCancel: do not uninstall.",
      "Private data",
      [System.Windows.Forms.MessageBoxButtons]::YesNoCancel,
      [System.Windows.Forms.MessageBoxIcon]::Question
    )
    if ($dataChoice -eq [System.Windows.Forms.DialogResult]::Cancel) {
      exit 0
    }
    $KeepData = $dataChoice -eq [System.Windows.Forms.DialogResult]::Yes
  }

  $configurationPath = Join-Path $PSScriptRoot $InstallConfigurationName
  if (-not (Test-Path -LiteralPath $configurationPath -PathType Leaf)) {
    throw "Installed path manifest is missing: $configurationPath"
  }
  $lines = [IO.File]::ReadAllLines($configurationPath, [Text.Encoding]::UTF8)
  if ($lines.Length -ne 11 -or $lines[0] -ne "v1") {
    throw "Installed path manifest is invalid"
  }
  $binDir = Assert-SafeOwnedPath (ConvertFrom-Base64 $lines[1]) "binary directory"
  $libDir = Assert-SafeOwnedPath (ConvertFrom-Base64 $lines[2]) "runtime directory"
  $docDir = Assert-SafeOwnedPath (ConvertFrom-Base64 $lines[3]) "document directory"
  $appHome = Assert-SafeOwnedPath (ConvertFrom-Base64 $lines[4]) "private-state directory"
  $guiPath = Get-NormalizedPath (ConvertFrom-Base64 $lines[5])
  $startMenuShortcut = Get-NormalizedPath (ConvertFrom-Base64 $lines[6])
  $desktopShortcut = Get-NormalizedPath (ConvertFrom-Base64 $lines[7])
  $installedVersion = ConvertFrom-Base64 $lines[8]
  $defaultInstallRoot = Assert-SafeOwnedPath (ConvertFrom-Base64 $lines[9]) "install root"
  $uninstallRegistrationText = ConvertFrom-Base64 $lines[10]
  if ($uninstallRegistrationText -notin @("True", "False")) {
    throw "Installed uninstall-registration state is invalid"
  }
  $removeUninstallRegistration = $uninstallRegistrationText -eq "True"
  if ((Get-NormalizedPath $PSScriptRoot) -ine $binDir) {
    throw "Uninstaller location does not match its installed path manifest"
  }
  if ($guiPath -ine (Join-Path $binDir "codex-chatgpt-web-gui.exe")) {
    throw "Installed GUI path is invalid"
  }
  if ($installedVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$') {
    throw "Installed version is invalid"
  }
  if (-not $KeepData -and (Test-Path -LiteralPath $appHome -PathType Container)) {
    $markerPath = Join-Path $appHome $OwnershipMarkerName
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
        [IO.File]::ReadAllText($markerPath) -ne $OwnershipMarkerContent) {
      throw "Private data has no valid ownership marker. Rerun uninstall and choose to keep private data."
    }
  }

  Stop-InstalledGui -GuiPath $guiPath
  $launcher = Join-Path $binDir "codex-chatgpt-web.exe"
  if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "Installed command launcher is missing: $launcher"
  }
  $stopOutput = & $launcher gui stop-session 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Could not stop the foreground session: $($stopOutput -join ' ')"
  }
  $uninstallArguments = @("uninstall", "--yes")
  if ($KeepData) {
    $uninstallArguments += "--keep-data"
  }
  $uninstallOutput = & $launcher @uninstallArguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Could not restore the Codex route: $($uninstallOutput -join ' ')"
  }
  Wait-FileUnlocked -Path $launcher
  Wait-FileUnlocked -Path $guiPath

  Remove-ShortcutIfOwned -Path $startMenuShortcut -ExpectedTarget $guiPath
  Remove-ShortcutIfOwned -Path $desktopShortcut -ExpectedTarget $guiPath
  Remove-UserPathEntry -Path $binDir
  Remove-VerifiedRuntimeVersions -Path $libDir
  foreach ($name in $DocumentNames) {
    Remove-Item -LiteralPath (Join-Path $docDir $name) -Force -ErrorAction SilentlyContinue
  }
  foreach ($name in @(
    "codex-chatgpt-web.exe",
    "codex-chatgpt-web-gui.exe",
    "codex-chatgpt-web.launcher",
    "codex-chatgpt-web.install",
    "codex-chatgpt-web.cmd"
  )) {
    Remove-Item -LiteralPath (Join-Path $binDir $name) -Force -ErrorAction SilentlyContinue
  }

  $message = if ($KeepData) {
    "$ProductName was removed. Private data was kept at:`n$appHome"
  } else {
    "$ProductName and its private data were removed."
  }
  Start-FinalCleanup `
    -UninstallerPath $PSCommandPath `
    -EmptyDirectories @($binDir, $docDir, $libDir) `
    -DefaultInstallRoot $defaultInstallRoot `
    -RemoveUninstallRegistration $removeUninstallRegistration
  Show-Message -Text $message -Title "Uninstall complete"
  exit 0
} catch {
  Show-Message `
    -Text "Uninstall could not finish safely.`n`n$($_.Exception.Message)" `
    -Title "Uninstall failed" `
    -Icon ([System.Windows.Forms.MessageBoxIcon]::Error)
  exit 1
}
