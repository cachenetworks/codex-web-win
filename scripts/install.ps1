[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$Repository,
  [string]$Version,
  [string]$BinDir,
  [string]$LibDir,
  [string]$DocDir,
  [string]$AppHome,
  [Alias("Source")]
  [string]$LocalBundle,
  [switch]$NoPath,
  [switch]$NoDesktopShortcut,
  [switch]$NoShortcuts,
  [switch]$NoUninstallRegistration,
  [string[]]$SetupArgs
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$DefaultVersion = "0.2.7"
$DocumentNames = @(
  "LICENSE",
  "NOTICE.md",
  "OpenCodex-MIT.txt",
  "Bun-1.3.11.md",
  "THIRD_PARTY_NOTICES.txt",
  "WINDOWS_SETUP.md"
)

function Get-Setting {
  param(
    [AllowEmptyString()]
    [string]$Value,
    [string]$EnvironmentName,
    [string]$Default
  )
  if (-not [string]::IsNullOrWhiteSpace($Value)) {
    return $Value
  }
  $fromEnvironment = [Environment]::GetEnvironmentVariable($EnvironmentName)
  if (-not [string]::IsNullOrWhiteSpace($fromEnvironment)) {
    return $fromEnvironment
  }
  return $Default
}

function Get-FullPath {
  param([string]$Path)
  return [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path))
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
  return [IO.Path]::GetFullPath($path)
}

function Invoke-Download {
  param([string]$Uri, [string]$Destination)
  Write-Host "Downloading $Uri"
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
}

function Get-ExpectedHash {
  param([string]$ChecksumsPath, [string]$Name)
  foreach ($line in Get-Content -LiteralPath $ChecksumsPath) {
    if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $Name) {
      return $Matches[1].ToLowerInvariant()
    }
  }
  throw "checksums.txt has no SHA-256 entry for $Name"
}

function Assert-Hash {
  param([string]$Path, [string]$Name, [string]$ChecksumsPath)
  $expected = Get-ExpectedHash -ChecksumsPath $ChecksumsPath -Name $Name
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    throw "SHA-256 verification failed for $Name"
  }
}

function Copy-DirectoryContents {
  param([string]$Source, [string]$Destination)
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($Source)) {
    Copy-Item -LiteralPath $entry -Destination $Destination -Recurse -Force
  }
}

function ConvertTo-Base64 {
  param([string]$Value)
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value))
}

function ConvertFrom-Base64 {
  param([string]$Value)
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

function Get-AttestedPriorRuntimePath {
  param(
    [string]$InstallConfigurationPath,
    [string]$LauncherConfigurationPath,
    [string]$ExpectedBinDir,
    [string]$ExpectedLibDir,
    [string]$ExpectedAppHome,
    [string]$SafeVersionPattern
  )
  if (-not (Test-Path -LiteralPath $InstallConfigurationPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $LauncherConfigurationPath -PathType Leaf)) {
    return $null
  }
  try {
    foreach ($sidecarPath in @($InstallConfigurationPath, $LauncherConfigurationPath)) {
      $sidecar = Get-Item -Force -LiteralPath $sidecarPath
      if ($sidecar.PSIsContainer -or
          ($sidecar.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
          $sidecar.Length -le 0 -or $sidecar.Length -gt 65536) {
        return $null
      }
    }
    $installLines = [IO.File]::ReadAllLines($InstallConfigurationPath, [Text.Encoding]::UTF8)
    $launcherLines = [IO.File]::ReadAllLines($LauncherConfigurationPath, [Text.Encoding]::UTF8)
    if ($installLines.Length -ne 11 -or $installLines[0] -ne "v1" -or
        ($launcherLines.Length -ne 4 -and $launcherLines.Length -ne 5) -or
        $launcherLines[0] -ne "v1" -or
        ($launcherLines.Length -eq 5 -and $launcherLines[4].Length -ne 0)) {
      return $null
    }
    $priorBinDir = [IO.Path]::GetFullPath((ConvertFrom-Base64 $installLines[1])).TrimEnd("\")
    $priorLibDir = [IO.Path]::GetFullPath((ConvertFrom-Base64 $installLines[2])).TrimEnd("\")
    $priorAppHome = [IO.Path]::GetFullPath((ConvertFrom-Base64 $installLines[4])).TrimEnd("\")
    $priorGui = [IO.Path]::GetFullPath((ConvertFrom-Base64 $installLines[5])).TrimEnd("\")
    $priorVersion = ConvertFrom-Base64 $installLines[8]
    $launcherRuntime = [IO.Path]::GetFullPath((ConvertFrom-Base64 $launcherLines[1])).TrimEnd("\")
    $launcherEntrypoint = [IO.Path]::GetFullPath((ConvertFrom-Base64 $launcherLines[2])).TrimEnd("\")
    $launcherAppHome = [IO.Path]::GetFullPath((ConvertFrom-Base64 $launcherLines[3])).TrimEnd("\")
    $binDir = [IO.Path]::GetFullPath($ExpectedBinDir).TrimEnd("\")
    $libDir = [IO.Path]::GetFullPath($ExpectedLibDir).TrimEnd("\")
    $appHome = [IO.Path]::GetFullPath($ExpectedAppHome).TrimEnd("\")
    if ($priorVersion.Length -gt 128 -or $priorVersion -notmatch $SafeVersionPattern -or
        $priorBinDir -ine $binDir -or $priorLibDir -ine $libDir -or
        $priorAppHome -ine $appHome -or $launcherAppHome -ine $appHome -or
        $priorGui -ine ([IO.Path]::GetFullPath((Join-Path $binDir "codex-chatgpt-web-gui.exe")))) {
      return $null
    }
    $candidate = [IO.Path]::GetFullPath((Join-Path $libDir $priorVersion)).TrimEnd("\")
    if ([IO.Path]::GetFullPath((Split-Path -Parent $candidate)).TrimEnd("\") -ine $libDir -or
        $launcherRuntime -ine ([IO.Path]::GetFullPath((Join-Path $candidate "runtime\node.exe"))) -or
        $launcherEntrypoint -ine ([IO.Path]::GetFullPath((Join-Path $candidate "app\cli.js")))) {
      return $null
    }
    return $candidate
  } catch {
    return $null
  }
}

function Assert-LauncherReplaceable {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Launcher path is not a file: $Path"
  }
  $stream = $null
  try {
    $stream = [IO.File]::Open(
      $Path,
      [IO.FileMode]::Open,
      [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::None
    )
  } catch {
    throw "Cannot update the Windows launcher while it is in use. Stop every foreground codex-chatgpt-web session and retry. Launcher: $Path"
  } finally {
    if ($stream) {
      $stream.Dispose()
    }
  }
}

function Move-FileAtomicallyWithBackup {
  param([string]$Source, [string]$Destination, [string]$Backup)
  if (Test-Path -LiteralPath $Destination) {
    if (-not (Test-Path -LiteralPath $Destination -PathType Leaf)) {
      throw "Install destination is not a file: $Destination"
    }
    [IO.File]::Replace($Source, $Destination, $Backup, $true)
    return $true
  }
  [IO.File]::Move($Source, $Destination)
  return $false
}

function Restore-FilePromotion {
  param([string]$Destination, [string]$Backup, [bool]$HadPreviousFile)
  if (-not $HadPreviousFile) {
    Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
    return
  }
  if (-not (Test-Path -LiteralPath $Backup -PathType Leaf)) {
    throw "Atomic install backup is missing: $Backup"
  }
  if (Test-Path -LiteralPath $Destination -PathType Leaf) {
    [IO.File]::Replace($Backup, $Destination, $null, $true)
  } else {
    [IO.File]::Move($Backup, $Destination)
  }
}

function Test-RuntimeTreeContainsReparsePoint {
  param([string]$Path)
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push([IO.Path]::GetFullPath($Path))
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
      $attributes = [IO.File]::GetAttributes($entry)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        return $true
      }
      if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
        $pending.Push($entry)
      }
    }
  }
  return $false
}

function Test-RegularRuntimeFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $false
  }
  $item = Get-Item -Force -LiteralPath $Path
  return -not $item.PSIsContainer -and
    ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0
}

function Remove-VerifiedOldRuntimeVersion {
  param(
    [string]$Path,
    [string]$CandidatePath,
    [string]$CurrentPath,
    [string]$ExpectedArchitecture,
    [string]$SafeVersionPattern
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    return
  }
  $rootPath = [IO.Path]::GetFullPath($Path).TrimEnd("\")
  $currentRuntimePath = [IO.Path]::GetFullPath($CurrentPath).TrimEnd("\")
  $forbiddenRoots = @(
    [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Path)),
    $userProfileRoot,
    $env:SystemRoot,
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)},
    $env:ProgramData,
    $localAppDataRoot,
    $roamingAppDataRoot
  ) | Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd("\") }
  if ($forbiddenRoots | Where-Object { $rootPath -ieq $_ }) {
    throw "Refusing old-runtime cleanup in a broad system or user directory: $rootPath"
  }
  $rootItem = Get-Item -Force -LiteralPath $rootPath
  if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      [IO.Path]::GetFullPath((Split-Path -Parent $currentRuntimePath)).TrimEnd("\") -ine $rootPath) {
    throw "Refusing old-runtime cleanup outside a direct, non-reparse runtime library: $rootPath"
  }
  if ([string]::IsNullOrWhiteSpace($CandidatePath)) {
    return
  }
  $directoryPath = [IO.Path]::GetFullPath($CandidatePath).TrimEnd("\")
  $directoryName = [IO.Path]::GetFileName($directoryPath)
  if ($directoryPath -ieq $currentRuntimePath -or
      $directoryName.Length -gt 128 -or $directoryName -notmatch $SafeVersionPattern -or
      [IO.Path]::GetFullPath((Split-Path -Parent $directoryPath)).TrimEnd("\") -ine $rootPath -or
      -not (Test-Path -LiteralPath $directoryPath -PathType Container)) {
    return
  }
  try {
    $directoryItem = Get-Item -Force -LiteralPath $directoryPath
    if (($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        (Test-RuntimeTreeContainsReparsePoint -Path $directoryPath)) {
      return
    }
    $manifestPath = Join-Path $directoryPath "manifest.json"
    if (-not (Test-RegularRuntimeFile -Path $manifestPath)) {
      return
    }
    $manifestItem = Get-Item -Force -LiteralPath $manifestPath
    if ($manifestItem.Length -le 0 -or $manifestItem.Length -gt 65536) {
      return
    }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or
        $manifest.platform -ne "win32" -or
        $manifest.arch -ne $ExpectedArchitecture -or
        $manifest.appVersion -ne $directoryName -or
        $manifest.launcher -ne "bin/codex-chatgpt-web.exe" -or
        $manifest.supervisor -ne "bin/codex-chatgpt-web.exe" -or
        $manifest.gui -ne "bin/codex-chatgpt-web-gui.exe" -or
        $manifest.uninstaller -ne "bin/codex-chatgpt-web-uninstall.ps1" -or
        $manifest.entrypoint -ne "app/cli.js") {
      return
    }
    $expectedFiles = @(
      (Join-Path $directoryPath "bin\codex-chatgpt-web.exe"),
      (Join-Path $directoryPath "bin\codex-chatgpt-web-gui.exe"),
      (Join-Path $directoryPath "bin\codex-chatgpt-web-uninstall.ps1"),
      (Join-Path $directoryPath "app\cli.js"),
      (Join-Path $directoryPath "runtime\node.exe")
    )
    if (@($expectedFiles | Where-Object { -not (Test-RegularRuntimeFile -Path $_) }).Count -ne 0) {
      return
    }
    foreach ($file in $expectedFiles) {
      $stream = $null
      try {
        $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      } finally {
        if ($stream) {
          $stream.Dispose()
        }
      }
    }
    $quarantinePath = Join-Path $rootPath ".cleanup-$directoryName-$PID-$([Guid]::NewGuid().ToString('N'))"
    Move-Item -LiteralPath $directoryPath -Destination $quarantinePath
    try {
      Remove-Item -LiteralPath $quarantinePath -Recurse -Force
    } catch {
      Write-Warning "The prior runtime was quarantined but could not be fully removed: $quarantinePath. $($_.Exception.Message)"
    }
  } catch {
    Write-Warning "Preserving the attested prior runtime ${directoryPath}: $($_.Exception.Message)"
  }
}

function Set-UserShortcut {
  param(
    [string]$Path,
    [string]$TargetPath,
    [string]$WorkingDirectory,
    [string]$Description
  )
  $shortcutDirectory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $shortcutDirectory -Force | Out-Null
  $baseName = [IO.Path]::GetFileNameWithoutExtension($Path)
  $nextShortcut = Join-Path $shortcutDirectory ".$baseName.next-$PID.lnk"
  $backupShortcut = Join-Path $shortcutDirectory ".$baseName.rollback-$PID.lnk"
  $shell = $null
  $shortcut = $null
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($nextShortcut)
    $shortcut.TargetPath = $TargetPath
    $shortcut.Arguments = ""
    $shortcut.WorkingDirectory = $WorkingDirectory
    $shortcut.Description = $Description
    $shortcut.IconLocation = "$TargetPath,0"
    $shortcut.Save()
    Move-FileAtomicallyWithBackup `
      -Source $nextShortcut -Destination $Path -Backup $backupShortcut | Out-Null
  } finally {
    if ($shortcut) {
      [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null
    }
    if ($shell) {
      [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
    }
    Remove-Item -LiteralPath $nextShortcut -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backupShortcut -Force -ErrorAction SilentlyContinue
  }
}

function Remove-UserShortcutIfOwned {
  param([string]$Path, [string]$ExpectedTarget)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }
  $shell = $null
  $shortcut = $null
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    if ([IO.Path]::GetFullPath($shortcut.TargetPath) -ieq [IO.Path]::GetFullPath($ExpectedTarget)) {
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

function Register-UserUninstall {
  param(
    [string]$Version,
    [string]$InstallLocation,
    [string]$GuiPath,
    [string]$UninstallerPath
  )
  $registryPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexChatGPTWeb"
  $powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $uninstallCommand = "`"$powerShell`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$UninstallerPath`""
  $quietUninstallCommand = "$uninstallCommand -Yes -KeepData -Quiet"
  New-Item -Path $registryPath -Force | Out-Null
  New-ItemProperty -Path $registryPath -Name "DisplayName" -Value "Codex ChatGPT Web" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $registryPath -Name "DisplayVersion" -Value $Version -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $registryPath -Name "Publisher" -Value "codex-chatgpt-web contributors" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $registryPath -Name "InstallLocation" -Value $InstallLocation -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $registryPath -Name "DisplayIcon" -Value "$GuiPath,0" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $registryPath -Name "UninstallString" -Value $uninstallCommand -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $registryPath -Name "QuietUninstallString" -Value $quietUninstallCommand -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $registryPath -Name "NoModify" -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $registryPath -Name "NoRepair" -Value 1 -PropertyType DWord -Force | Out-Null
}

function Protect-PrivateDirectory {
  param([string]$Path, [string]$KnownDefaultPath)
  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd("\")
  $forbidden = @(
    [IO.Path]::GetPathRoot($fullPath),
    $userProfileRoot,
    $env:SystemRoot,
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)},
    $env:ProgramData,
    $localAppDataRoot,
    $roamingAppDataRoot
  ) | Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd("\") }
  if ($forbidden | Where-Object { $fullPath -ieq $_ }) {
    throw "Refusing to change ACLs on a broad system or user directory: $fullPath"
  }
  $knownDefault = [IO.Path]::GetFullPath($KnownDefaultPath).TrimEnd("\")
  $markerPath = Join-Path $fullPath ".codex-chatgpt-web-owned"
  $markerContent = "codex-chatgpt-web private state v1`n"
  $directoryExists = Test-Path -LiteralPath $fullPath -PathType Container
  if ((Test-Path -LiteralPath $fullPath) -and -not $directoryExists) {
    throw "Private application home is not a directory: $fullPath"
  }
  if ($directoryExists) {
    $attributes = (Get-Item -Force -LiteralPath $fullPath).Attributes
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing a reparse point as the private application home: $fullPath"
    }
    $markerExists = Test-Path -LiteralPath $markerPath -PathType Leaf
    if ($markerExists -and [IO.File]::ReadAllText($markerPath) -ne $markerContent) {
      throw "Private application home has an invalid ownership marker: $markerPath"
    }
    if (-not $markerExists -and $fullPath -ine $knownDefault) {
      throw "Refusing to rewrite ACLs on an existing unowned directory: $fullPath. Choose a new dedicated -AppHome."
    }
  } else {
    New-Item -ItemType Directory -Path $fullPath | Out-Null
  }
  [IO.File]::WriteAllText($markerPath, $markerContent, [Text.UTF8Encoding]::new($false))
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $identity.User) {
    throw "Could not determine the current Windows user SID"
  }
  $resetOutput = & "$env:SystemRoot\System32\icacls.exe" $Path "/reset" "/t" "/c" "/q" 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Could not reset the private application directory ACL: $($resetOutput -join ' ')"
  }
  $grant = "*$($identity.User.Value):(OI)(CI)F"
  $icaclsOutput = & "$env:SystemRoot\System32\icacls.exe" $Path "/inheritance:r" "/grant:r" $grant 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Could not restrict the private application directory ACL: $($icaclsOutput -join ' ')"
  }
}

function Add-UserPath {
  param([string]$Path)
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = @()
  if ($userPath) {
    $entries = @($userPath.Split(";") | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  }
  if (-not ($entries | Where-Object { $_.TrimEnd("\") -ieq $Path.TrimEnd("\") })) {
    $nextPath = (@($entries) + $Path) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $nextPath, "User")
  }
  if (-not (($env:Path.Split(";")) | Where-Object { $_.TrimEnd("\") -ieq $Path.TrimEnd("\") })) {
    $env:Path = "$Path;$env:Path"
  }
}

if ($env:OS -ne "Windows_NT") {
  throw "install.ps1 supports Windows only; use scripts/install.sh on macOS"
}
if ($PSVersionTable.PSVersion.Major -lt 5) {
  throw "Windows PowerShell 5.1 or PowerShell 7 is required"
}

$Repository = Get-Setting -Value $Repository -EnvironmentName "CODEX_CHATGPT_WEB_REPOSITORY" -Default "miuuyy/codex-chatgpt-web"
$Version = Get-Setting -Value $Version -EnvironmentName "CODEX_CHATGPT_WEB_VERSION" -Default $DefaultVersion
$safeSemVer = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
if ($Version.Length -gt 128 -or $Version -notmatch $safeSemVer) {
  throw "Version must be a safe Semantic Version such as 1.2.3 or 1.2.3-rc.1"
}
$userProfileRoot = Get-KnownFolderPath -Folder ([Environment+SpecialFolder]::UserProfile) -Label "user profile"
$localAppDataRoot = Get-KnownFolderPath -Folder ([Environment+SpecialFolder]::LocalApplicationData) -Label "local application data"
$roamingAppDataRoot = Get-KnownFolderPath -Folder ([Environment+SpecialFolder]::ApplicationData) -Label "roaming application data"
$installRoot = Join-Path $localAppDataRoot "Programs\codex-chatgpt-web"
$BinDir = Get-FullPath (Get-Setting -Value $BinDir -EnvironmentName "CODEX_CHATGPT_WEB_BIN_DIR" -Default (Join-Path $installRoot "bin"))
$LibDir = Get-FullPath (Get-Setting -Value $LibDir -EnvironmentName "CODEX_CHATGPT_WEB_LIB_DIR" -Default (Join-Path $installRoot "lib"))
$DocDir = Get-FullPath (Get-Setting -Value $DocDir -EnvironmentName "CODEX_CHATGPT_WEB_DOC_DIR" -Default (Join-Path $installRoot "doc"))
$defaultAppHome = Join-Path $userProfileRoot ".codex-chatgpt-web"
$AppHome = Get-FullPath (Get-Setting -Value $AppHome -EnvironmentName "CODEX_CHATGPT_WEB_HOME" -Default $defaultAppHome)

$osArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$assetArchitecture = switch ($osArchitecture) {
  "x64" { "x64" }
  "arm64" { "arm64" }
  default { throw "Unsupported Windows architecture: $osArchitecture" }
}
$asset = "codex-chatgpt-web-windows-$assetArchitecture.zip"
$targetDir = Join-Path $LibDir $Version
$stageDir = Join-Path $LibDir ".stage-$Version-$PID"
$backupDir = Join-Path $LibDir ".previous-$Version-$PID"
$tempDir = Join-Path ([IO.Path]::GetTempPath()) "codex-chatgpt-web-$([Guid]::NewGuid().ToString('N'))"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$backupCreated = $false
$targetPromoted = $false
$installed = $false

try {
  New-Item -ItemType Directory -Path $tempDir, $LibDir, $BinDir, $DocDir -Force | Out-Null
  if (Test-Path -LiteralPath $stageDir) {
    throw "Staging directory already exists: $stageDir"
  }
  New-Item -ItemType Directory -Path $stageDir | Out-Null

  if ($LocalBundle) {
    $resolvedBundle = (Resolve-Path -LiteralPath $LocalBundle).Path
    Write-Host "Installing locally built runtime from $resolvedBundle"
    Copy-DirectoryContents -Source $resolvedBundle -Destination $stageDir

    $localDocuments = @{
      "LICENSE" = Join-Path $repositoryRoot "LICENSE"
      "NOTICE.md" = Join-Path $repositoryRoot "LICENSES\NOTICE.md"
      "OpenCodex-MIT.txt" = Join-Path $repositoryRoot "LICENSES\OpenCodex-MIT.txt"
      "Bun-1.3.11.md" = Join-Path $repositoryRoot "LICENSES\Bun-1.3.11.md"
      "THIRD_PARTY_NOTICES.txt" = Join-Path $repositoryRoot "dist\THIRD_PARTY_NOTICES.txt"
      "WINDOWS_SETUP.md" = Join-Path $repositoryRoot "docs\windows.md"
    }
    foreach ($name in $DocumentNames) {
      $source = $localDocuments[$name]
      if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Local installation requires $source. Run ``bun run licenses`` before installing."
      }
      Copy-Item -LiteralPath $source -Destination (Join-Path $tempDir $name)
    }
  } else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $baseUrl = "https://github.com/$Repository/releases/download/v$Version"
    $archivePath = Join-Path $tempDir $asset
    $checksumsPath = Join-Path $tempDir "checksums.txt"
    Invoke-Download -Uri "$baseUrl/$asset" -Destination $archivePath
    Invoke-Download -Uri "$baseUrl/checksums.txt" -Destination $checksumsPath
    Assert-Hash -Path $archivePath -Name $asset -ChecksumsPath $checksumsPath
    foreach ($name in $DocumentNames) {
      $destination = Join-Path $tempDir $name
      Invoke-Download -Uri "$baseUrl/$name" -Destination $destination
      Assert-Hash -Path $destination -Name $name -ChecksumsPath $checksumsPath
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $stageDir
  }

  $manifestPath = Join-Path $stageDir "manifest.json"
  $launcherPath = Join-Path $stageDir "bin\codex-chatgpt-web.exe"
  $guiPath = Join-Path $stageDir "bin\codex-chatgpt-web-gui.exe"
  $uninstallerSourcePath = Join-Path $stageDir "bin\codex-chatgpt-web-uninstall.ps1"
  $nodePath = Join-Path $stageDir "runtime\node.exe"
  $nodeLicensePath = Join-Path $stageDir "runtime\Node-24.14.0-LICENSE.txt"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $launcherPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $guiPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $uninstallerSourcePath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $nodeLicensePath -PathType Leaf)) {
    throw "Windows runtime archive is incomplete"
  }
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1 -or $manifest.appVersion -ne $Version -or
      $manifest.platform -ne "win32" -or $manifest.arch -ne $assetArchitecture -or
      $manifest.nodeVersion -ne "24.14.0" -or
      $manifest.launcher -ne "bin/codex-chatgpt-web.exe" -or
      $manifest.supervisor -ne "bin/codex-chatgpt-web.exe" -or
      $manifest.gui -ne "bin/codex-chatgpt-web-gui.exe" -or
      $manifest.uninstaller -ne "bin/codex-chatgpt-web-uninstall.ps1") {
    throw "Runtime manifest does not match Windows $assetArchitecture version $Version"
  }
  $actualVersion = (& $launcherPath --version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $actualVersion -ne $Version) {
    throw "Runtime launcher version does not match $Version"
  }
  $guiMetadataText = (& $guiPath --about-json | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($guiMetadataText)) {
    throw "Windows GUI metadata probe failed"
  }
  try {
    $guiMetadata = $guiMetadataText | ConvertFrom-Json
  } catch {
    throw "Windows GUI metadata is invalid"
  }
  if ($guiMetadata.schemaVersion -ne 1 -or
      $guiMetadata.app -ne "codex-chatgpt-web-gui" -or
      $guiMetadata.version -ne $Version -or
      $guiMetadata.platform -ne "win32") {
    throw "Windows GUI metadata does not match version $Version"
  }

  $shimPath = Join-Path $BinDir "codex-chatgpt-web.exe"
  $guiShimPath = Join-Path $BinDir "codex-chatgpt-web-gui.exe"
  $launcherConfigurationPath = Join-Path $BinDir "codex-chatgpt-web.launcher"
  $installConfigurationPath = Join-Path $BinDir "codex-chatgpt-web.install"
  $uninstallerPath = Join-Path $BinDir "codex-chatgpt-web-uninstall.ps1"
  $priorRuntimeCleanupPath = Get-AttestedPriorRuntimePath `
    -InstallConfigurationPath $installConfigurationPath `
    -LauncherConfigurationPath $launcherConfigurationPath `
    -ExpectedBinDir $BinDir -ExpectedLibDir $LibDir -ExpectedAppHome $AppHome `
    -SafeVersionPattern $safeSemVer
  Assert-LauncherReplaceable -Path $shimPath
  Assert-LauncherReplaceable -Path $guiShimPath
  Protect-PrivateDirectory -Path $AppHome -KnownDefaultPath $defaultAppHome

  if (Test-Path -LiteralPath $targetDir) {
    if (Test-Path -LiteralPath $backupDir) {
      throw "Backup directory already exists: $backupDir"
    }
    Move-Item -LiteralPath $targetDir -Destination $backupDir
    $backupCreated = $true
  }
  try {
    Move-Item -LiteralPath $stageDir -Destination $targetDir
    $targetPromoted = $true
  } catch {
    if ($backupCreated -and -not (Test-Path -LiteralPath $targetDir)) {
      Move-Item -LiteralPath $backupDir -Destination $targetDir
      $backupCreated = $false
    }
    throw
  }

  $targetLauncher = Join-Path $targetDir "bin\codex-chatgpt-web.exe"
  $targetGui = Join-Path $targetDir "bin\codex-chatgpt-web-gui.exe"
  $targetUninstaller = Join-Path $targetDir "bin\codex-chatgpt-web-uninstall.ps1"
  $targetRuntime = Join-Path $targetDir "runtime\node.exe"
  $targetEntrypoint = Join-Path $targetDir "app\cli.js"
  $startMenuDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
  $desktopDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
  if ([string]::IsNullOrWhiteSpace($startMenuDirectory) -or
      [string]::IsNullOrWhiteSpace($desktopDirectory)) {
    throw "Could not resolve the current user's Start Menu or Desktop directory"
  }
  $shortcutName = "Codex ChatGPT Web.lnk"
  $startMenuShortcut = Join-Path $startMenuDirectory $shortcutName
  $desktopShortcut = Join-Path $desktopDirectory $shortcutName
  $nextShim = Join-Path $BinDir ".codex-chatgpt-web.next-$PID.exe"
  $nextGui = Join-Path $BinDir ".codex-chatgpt-web-gui.next-$PID.exe"
  $nextUninstaller = Join-Path $BinDir ".codex-chatgpt-web-uninstall.next-$PID.ps1"
  $nextLauncherConfiguration = Join-Path $BinDir ".codex-chatgpt-web.launcher.next-$PID"
  $nextInstallConfiguration = Join-Path $BinDir ".codex-chatgpt-web.install.next-$PID"
  $rollbackShim = Join-Path $BinDir ".codex-chatgpt-web.rollback-$PID.exe"
  $rollbackGui = Join-Path $BinDir ".codex-chatgpt-web-gui.rollback-$PID.exe"
  $rollbackUninstaller = Join-Path $BinDir ".codex-chatgpt-web-uninstall.rollback-$PID.ps1"
  $rollbackLauncherConfiguration = Join-Path $BinDir ".codex-chatgpt-web.launcher.rollback-$PID"
  $rollbackInstallConfiguration = Join-Path $BinDir ".codex-chatgpt-web.install.rollback-$PID"
  $launcherConfiguration = @(
    "v1",
    (ConvertTo-Base64 $targetRuntime),
    (ConvertTo-Base64 $targetEntrypoint),
    (ConvertTo-Base64 $AppHome),
    ""
  ) -join "`r`n"
  $installationConfiguration = @(
    "v1",
    (ConvertTo-Base64 $BinDir),
    (ConvertTo-Base64 $LibDir),
    (ConvertTo-Base64 $DocDir),
    (ConvertTo-Base64 $AppHome),
    (ConvertTo-Base64 $guiShimPath),
    (ConvertTo-Base64 $startMenuShortcut),
    (ConvertTo-Base64 $desktopShortcut),
    (ConvertTo-Base64 $Version),
    (ConvertTo-Base64 $installRoot),
    (ConvertTo-Base64 ((-not $NoUninstallRegistration).ToString()))
  ) -join "`r`n"

  foreach ($name in $DocumentNames) {
    Copy-Item -LiteralPath (Join-Path $tempDir $name) -Destination (Join-Path $DocDir $name) -Force
  }
  Copy-Item -LiteralPath $targetLauncher -Destination $nextShim -Force
  Copy-Item -LiteralPath $targetGui -Destination $nextGui -Force
  Copy-Item -LiteralPath $targetUninstaller -Destination $nextUninstaller -Force
  [IO.File]::WriteAllText($nextLauncherConfiguration, $launcherConfiguration, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($nextInstallConfiguration, $installationConfiguration, [Text.UTF8Encoding]::new($false))
  $shimPromoted = $false
  $guiPromoted = $false
  $uninstallerPromoted = $false
  $launcherConfigurationPromoted = $false
  $installConfigurationPromoted = $false
  $shimHadPreviousFile = $false
  $guiHadPreviousFile = $false
  $uninstallerHadPreviousFile = $false
  $launcherConfigurationHadPreviousFile = $false
  $installConfigurationHadPreviousFile = $false
  try {
    # Both executable versions understand the existing sidecar, so replace
    # executables first. This keeps the installed command usable if a later
    # path-manifest promotion fails.
    $shimHadPreviousFile = Move-FileAtomicallyWithBackup `
      -Source $nextShim -Destination $shimPath -Backup $rollbackShim
    $shimPromoted = $true
    $guiHadPreviousFile = Move-FileAtomicallyWithBackup `
      -Source $nextGui -Destination $guiShimPath -Backup $rollbackGui
    $guiPromoted = $true
    $uninstallerHadPreviousFile = Move-FileAtomicallyWithBackup `
      -Source $nextUninstaller -Destination $uninstallerPath -Backup $rollbackUninstaller
    $uninstallerPromoted = $true
    $launcherConfigurationHadPreviousFile = Move-FileAtomicallyWithBackup `
      -Source $nextLauncherConfiguration -Destination $launcherConfigurationPath `
      -Backup $rollbackLauncherConfiguration
    $launcherConfigurationPromoted = $true
    $installConfigurationHadPreviousFile = Move-FileAtomicallyWithBackup `
      -Source $nextInstallConfiguration -Destination $installConfigurationPath `
      -Backup $rollbackInstallConfiguration
    $installConfigurationPromoted = $true
    if ([IO.File]::ReadAllText($launcherConfigurationPath, [Text.Encoding]::UTF8) -cne $launcherConfiguration) {
      throw "Installed Windows launcher configuration does not match the current runtime"
    }
    if ([IO.File]::ReadAllText($installConfigurationPath, [Text.Encoding]::UTF8) -cne $installationConfiguration) {
      throw "Installed Windows path manifest does not match the current installation"
    }
    $installedLauncherVersion = (& $shimPath --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $installedLauncherVersion -ne $Version) {
      throw "Installed Windows launcher does not resolve to version $Version"
    }
  } catch {
    $launcherUpdateError = $_
    $rollbackErrors = [Collections.Generic.List[string]]::new()
    if ($installConfigurationPromoted) {
      try {
        Restore-FilePromotion -Destination $installConfigurationPath `
          -Backup $rollbackInstallConfiguration -HadPreviousFile $installConfigurationHadPreviousFile
      } catch {
        $rollbackErrors.Add($_.Exception.Message)
      }
    }
    if ($launcherConfigurationPromoted) {
      try {
        Restore-FilePromotion -Destination $launcherConfigurationPath `
          -Backup $rollbackLauncherConfiguration -HadPreviousFile $launcherConfigurationHadPreviousFile
      } catch {
        $rollbackErrors.Add($_.Exception.Message)
      }
    }
    if ($uninstallerPromoted) {
      try {
        Restore-FilePromotion -Destination $uninstallerPath `
          -Backup $rollbackUninstaller -HadPreviousFile $uninstallerHadPreviousFile
      } catch {
        $rollbackErrors.Add($_.Exception.Message)
      }
    }
    if ($guiPromoted) {
      try {
        Restore-FilePromotion -Destination $guiShimPath -Backup $rollbackGui `
          -HadPreviousFile $guiHadPreviousFile
      } catch {
        $rollbackErrors.Add($_.Exception.Message)
      }
    }
    if ($shimPromoted) {
      try {
        Restore-FilePromotion -Destination $shimPath -Backup $rollbackShim `
          -HadPreviousFile $shimHadPreviousFile
      } catch {
        $rollbackErrors.Add($_.Exception.Message)
      }
    }
    if ($rollbackErrors.Count -gt 0) {
      throw "Launcher update failed and rollback was incomplete: $($rollbackErrors -join '; '). Original error: $($launcherUpdateError.Exception.Message)"
    }
    throw $launcherUpdateError
  } finally {
    Remove-Item -LiteralPath $nextShim -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $nextGui -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $nextUninstaller -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $nextLauncherConfiguration -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $nextInstallConfiguration -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $rollbackShim -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $rollbackGui -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $rollbackUninstaller -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $rollbackLauncherConfiguration -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $rollbackInstallConfiguration -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath (Join-Path $BinDir "codex-chatgpt-web.cmd") -Force -ErrorAction SilentlyContinue
  if ($backupCreated -and (Test-Path -LiteralPath $backupDir)) {
    Remove-Item -LiteralPath $backupDir -Recurse -Force
    $backupCreated = $false
  }
  $installed = $true
  try {
    Remove-VerifiedOldRuntimeVersion `
      -Path $LibDir -CandidatePath $priorRuntimeCleanupPath `
      -CurrentPath $targetDir -ExpectedArchitecture $assetArchitecture `
      -SafeVersionPattern $safeSemVer
  } catch {
    Write-Warning "The current runtime is installed, but an older verified runtime could not be removed: $($_.Exception.Message)"
  }

  $pathConfigured = $false
  if (-not $NoPath) {
    try {
      Add-UserPath -Path $BinDir
      $pathConfigured = $true
    } catch {
      Write-Warning "The runtime is installed, but the user PATH could not be updated: $($_.Exception.Message)"
    }
  }
  if ($NoShortcuts) {
    Remove-UserShortcutIfOwned -Path $startMenuShortcut -ExpectedTarget $guiShimPath
    Remove-UserShortcutIfOwned -Path $desktopShortcut -ExpectedTarget $guiShimPath
  } else {
    try {
      Set-UserShortcut `
          -Path $startMenuShortcut `
          -TargetPath $guiShimPath `
          -WorkingDirectory $BinDir `
          -Description "Set up and run Codex ChatGPT Web"
      if (-not $NoDesktopShortcut) {
        Set-UserShortcut `
            -Path $desktopShortcut `
            -TargetPath $guiShimPath `
            -WorkingDirectory $BinDir `
            -Description "Set up and run Codex ChatGPT Web"
      } else {
        Remove-UserShortcutIfOwned -Path $desktopShortcut -ExpectedTarget $guiShimPath
      }
    } catch {
      Write-Warning "The runtime is installed, but Windows shortcuts could not be updated: $($_.Exception.Message)"
    }
  }
  if (-not $NoUninstallRegistration) {
    try {
      Register-UserUninstall `
        -Version $Version `
        -InstallLocation (Split-Path -Parent $BinDir) `
        -GuiPath $guiShimPath `
        -UninstallerPath $uninstallerPath
    } catch {
      Write-Warning "The runtime is installed, but Apps & Features registration failed: $($_.Exception.Message)"
    }
  }

  Write-Host "Installed codex-chatgpt-web $Version at $targetDir"
  Write-Host "Private state is ACL-restricted to the current user at $AppHome"
  Write-Host "Windows GUI: $guiShimPath"
  if ($NoPath) {
    Write-Host "PATH was not changed. Run the launcher at: $shimPath"
  } elseif ($pathConfigured) {
    Write-Host "Added $BinDir to your user PATH."
    Write-Host "Open a new PowerShell to load it, or run the launcher at: $shimPath"
  } else {
    Write-Host "PATH could not be changed. Run the launcher at: $shimPath"
  }
  Write-Host "No startup folder entry, Run key, Scheduled Task, or Windows service was registered."

  if ($SetupArgs -and $SetupArgs.Count -gt 0) {
    & $shimPath setup @SetupArgs
    if ($LASTEXITCODE -ne 0) {
      throw "codex-chatgpt-web setup failed with exit code $LASTEXITCODE"
    }
  } else {
    Write-Host "Next: open Codex ChatGPT Web from the Start Menu to complete setup."
  }
} finally {
  if (Test-Path -LiteralPath $stageDir) {
    Remove-Item -LiteralPath $stageDir -Recurse -Force
  }
  if (Test-Path -LiteralPath $tempDir) {
    Remove-Item -LiteralPath $tempDir -Recurse -Force
  }
  if (-not $installed -and $targetPromoted -and (Test-Path -LiteralPath $targetDir)) {
    Remove-Item -LiteralPath $targetDir -Recurse -Force
  }
  if (-not $installed -and $backupCreated -and (Test-Path -LiteralPath $backupDir)) {
    Move-Item -LiteralPath $backupDir -Destination $targetDir
  }
}
