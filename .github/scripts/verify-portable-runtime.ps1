[CmdletBinding(DefaultParameterSetName = 'Portable')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Portable')]
    [string]$PortablePath,

    # A narrow, executable seam for the permanent detector tests. The release
    # workflow never uses this parameter set; it exists so every canonical
    # account-data name below can be proved to fail rather than merely read from
    # this file as source text.
    [Parameter(Mandatory = $true, ParameterSetName = 'DetectorFixture')]
    [string]$DetectorFixtureJson
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$dataDirectoryName = 'open-desktop-authenticator'
$uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
$dataDirectoryComponents = @(
    $dataDirectoryName,
    'pending-operations',
    'pending-steam-workflows',
    'recovery'
)
$browserDataComponents = @(
    'blob_storage',
    'Cache',
    'Code Cache',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
    'GPUCache',
    'IndexedDB',
    'Local Storage',
    'Network',
    'Partitions',
    'Session Storage',
    'Shared Dictionary'
)
$browserDataFiles = @('Cookies', 'DIPS', 'DIPS-wal', 'Local State', 'lockfile')

function Test-ApplicationDataPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $parts = @($Path -split '[\\/]' | Where-Object { $_.Length -ne 0 })
    if ($parts.Count -eq 0) { return $false }

    foreach ($part in $parts) {
        if ($dataDirectoryComponents -contains $part -or $browserDataComponents -contains $part) {
            return $true
        }
        if ($part -match '^browser-(?:chrome|[0-9]{1,32})$' -or
            $part -match '^steam-(?:direct-)?[0-9]{1,32}(?:-[1-9][0-9]*)?$' -or
            $part -match '^steam-steam-clock-sync(?:-[1-9][0-9]*)?$' -or
            $part -eq 'steam-login-system') {
            return $true
        }
    }

    $leaf = $parts[-1]
    if ($browserDataFiles -contains $leaf) { return $true }
    if ($leaf -match "^vault\.json(?:\.bak(?:\.tmp|\.previous-$uuid)?|\.tmp|\.rotating(?:\.tmp)?|\.superseded-$uuid)?$") {
        return $true
    }
    if ($leaf -match '\.oda-recovery(?:\.[0-9a-f-]{36}\.tmp)?$') { return $true }
    if ($leaf -match '\.maFile(?:\.[0-9a-f-]{36}\.tmp)?$') { return $true }
    return $false
}

function Assert-NoApplicationData {
    param(
        [Parameter(Mandatory = $true)][string[]]$Paths,
        [Parameter(Mandatory = $true)][string]$Context
    )

    $leaks = @($Paths | Where-Object { Test-ApplicationDataPath -Path $_ })
    if ($leaks.Count -ne 0) {
        foreach ($leak in $leaks) { Write-Host "APPLICATION-DATA: $leak" }
        throw "$Context contained $($leaks.Count) application-data path(s)."
    }
}

if ($PSCmdlet.ParameterSetName -eq 'DetectorFixture') {
    $detectorPaths = @(ConvertFrom-Json -InputObject $DetectorFixtureJson)
    if ($detectorPaths.Count -eq 0 -or @($detectorPaths | Where-Object { $_ -isnot [string] }).Count -ne 0) {
        throw 'Detector fixture JSON must be a non-empty array of path strings.'
    }
    Assert-NoApplicationData -Paths $detectorPaths -Context 'Detector fixture'
    Write-Host "Detector accepted $($detectorPaths.Count) non-application path(s)."
    return
}

function Assert-DisposableRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Prefix
    )

    $full = [IO.Path]::GetFullPath($Path)
    $systemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    )
    $insideTemp = "$systemTemp$([IO.Path]::DirectorySeparatorChar)"
    $leaf = Split-Path -Leaf $full
    if (-not $full.StartsWith($insideTemp, [StringComparison]::OrdinalIgnoreCase) -or
        -not $leaf.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing unexpected portable probe path: $full"
    }
    return $full
}

function New-DisposableRoot {
    param([Parameter(Mandatory = $true)][string]$Prefix)

    $path = Join-Path ([IO.Path]::GetTempPath()) ("{0}{1}" -f $Prefix, [guid]::NewGuid())
    $path = Assert-DisposableRoot -Path $path -Prefix $Prefix
    New-Item -ItemType Directory -Path $path | Out-Null
    return $path
}

function Remove-DisposableRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Prefix
    )

    $exact = Assert-DisposableRoot -Path $Path -Prefix $Prefix
    if (Test-Path -LiteralPath $exact) {
        Remove-Item -LiteralPath $exact -Recurse -Force
    }
    if (Test-Path -LiteralPath $exact) {
        throw "Portable probe cleanup left its exact disposable directory: $exact"
    }
}

function Add-ObservedEntries {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)]$Observed
    )

    Get-ChildItem -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
        [void]$Observed.Add([IO.Path]::GetRelativePath($Root, $_.FullName))
    }
}

function Test-PathUnderRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    )
    return $fullPath.StartsWith(
        "$fullRoot$([IO.Path]::DirectorySeparatorChar)",
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Get-ProbeProcesses {
    param([Parameter(Mandatory = $true)][string[]]$Roots)

    $owned = @{}
    foreach ($candidate in Get-Process -ErrorAction SilentlyContinue) {
        try {
            $path = $candidate.Path
            if ($null -eq $path) { continue }
            if ($Roots | Where-Object { Test-PathUnderRoot -Path $path -Root $_ }) {
                $owned[$candidate.Id] = $candidate
            }
        }
        catch {
            # Processes outside the two private roots are not ours and need not
            # be inspectable. Never broaden ownership because inspection failed.
        }
    }
    return @($owned.Values)
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class OdaPortableWindowCloser {
    private delegate bool EnumWindowsProc(IntPtr window, IntPtr state);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    public static int RequestClose(int[] processIds) {
        var ids = new HashSet<uint>();
        foreach (var processId in processIds) ids.Add((uint)processId);
        var sent = 0;
        EnumWindows(delegate(IntPtr window, IntPtr state) {
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (ids.Contains(processId) && PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero)) sent++;
            return true;
        }, IntPtr.Zero);
        return sent;
    }
}
'@

function Stop-ExactProbeProcesses {
    param([Parameter(Mandatory = $true)][string[]]$Roots)

    $owned = @(Get-ProbeProcesses -Roots $Roots)
    if ($owned.Count -eq 0) { return }

    [void][OdaPortableWindowCloser]::RequestClose([int[]]@($owned.Id))
    $closeDeadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $left = @(Get-ProbeProcesses -Roots $Roots)
        if ($left.Count -eq 0) { return }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $closeDeadline)

    # Re-check the executable path immediately before every forced stop. A PID
    # can be reused; a process outside these unique roots is never ours to kill.
    foreach ($candidate in $left) {
        try {
            $path = $candidate.Path
            if ($null -ne $path -and ($Roots | Where-Object { Test-PathUnderRoot -Path $path -Root $_ })) {
                Stop-Process -Id $candidate.Id -Force
            }
        }
        catch {
            if (Get-Process -Id $candidate.Id -ErrorAction SilentlyContinue) { throw }
        }
    }

    $stopDeadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $left = @(Get-ProbeProcesses -Roots $Roots)
        if ($left.Count -eq 0) { return }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $stopDeadline)
    throw "Portable app probe left an exact child process running: $($left.Id -join ', ')"
}

function Restore-EnvironmentValue {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [AllowNull()][string]$Value
    )

    if ($null -eq $Value) {
        Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue
    }
    else {
        Set-Item -LiteralPath "Env:$Name" -Value $Value
    }
}

$portable = (Resolve-Path -LiteralPath $PortablePath).Path
if ([IO.Path]::GetExtension($portable) -ne '.exe') {
    throw "The portable runtime fixture must be an executable: $portable"
}

$previousTemp = $env:TEMP
$previousTmp = $env:TMP
$previousRunAsNode = $env:ELECTRON_RUN_AS_NODE

$runtimePrefix = 'oda-portable-runtime-'
$runtimeProbe = New-DisposableRoot -Prefix $runtimePrefix
$runtimeObserved = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$runtimeProcess = $null

try {
    # This first half intentionally runs Electron as Node. It proves the single-
    # file launcher really extracts its packaged runtime and removes that stage
    # after a normal exit. It does not claim to execute the application's main.
    $env:TEMP = $runtimeProbe
    $env:TMP = $runtimeProbe
    $env:ELECTRON_RUN_AS_NODE = '1'

    $runtimeProcess = Start-Process -FilePath $portable `
        -ArgumentList '-e', 'setTimeout(()=>process.exit(0),3000)' `
        -PassThru -WindowStyle Hidden

    $runtimeDeadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Add-ObservedEntries -Root $runtimeProbe -Observed $runtimeObserved
        if ($runtimeProcess.HasExited -and $runtimeObserved.Count -gt 0) { break }
        Start-Sleep -Milliseconds 25
    } while ([DateTime]::UtcNow -lt $runtimeDeadline)

    if (-not $runtimeProcess.HasExited -and -not $runtimeProcess.WaitForExit(30000)) {
        throw 'Portable runtime probe did not exit within its bounded test window.'
    }
    if ($runtimeProcess.ExitCode -ne 0) {
        throw "Portable runtime probe exited $($runtimeProcess.ExitCode)."
    }
    if ($runtimeObserved.Count -eq 0) {
        throw 'Portable launcher produced no observed runtime extraction; the fixture did not exercise the packaged executable.'
    }
    Assert-NoApplicationData -Paths @($runtimeObserved) -Context 'Portable runtime extraction'

    $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        $left = @(Get-ChildItem -LiteralPath $runtimeProbe -Recurse -Force -ErrorAction SilentlyContinue)
        if ($left.Count -eq 0) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $cleanupDeadline)

    if ($left.Count -ne 0) {
        $relative = $left | ForEach-Object { [IO.Path]::GetRelativePath($runtimeProbe, $_.FullName) }
        throw "Portable launcher left its runtime stage after normal exit: $($relative -join ', ')"
    }

    Write-Host "Observed $($runtimeObserved.Count) temporary runtime entries; normal exit removed all of them and none was application data."
}
finally {
    if ($null -ne $runtimeProcess -and -not $runtimeProcess.HasExited) {
        Stop-Process -Id $runtimeProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Stop-ExactProbeProcesses -Roots @($runtimeProbe)
    Restore-EnvironmentValue -Name 'TEMP' -Value $previousTemp
    Restore-EnvironmentValue -Name 'TMP' -Value $previousTmp
    Restore-EnvironmentValue -Name 'ELECTRON_RUN_AS_NODE' -Value $previousRunAsNode
    Remove-DisposableRoot -Path $runtimeProbe -Prefix $runtimePrefix
}

$appPrefix = 'oda-portable-app-'
$appTempPrefix = 'oda-portable-app-temp-'
$appFixture = $null
$appTemp = $null
$appObserved = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$appProcess = $null

try {
    # Both roots are inside the cleanup boundary. In particular, a failure while
    # allocating the second root must not strand the already-created first one.
    $appFixture = New-DisposableRoot -Prefix $appPrefix
    $appTemp = New-DisposableRoot -Prefix $appTempPrefix
    $fixturePortable = Join-Path $appFixture 'probe-portable.exe'
    $expectedDataRoot = Join-Path $appFixture $dataDirectoryName
    $startupMarker = Join-Path $expectedDataRoot 'lockfile'

    # Run a private copy so the ordinary app is free to create its user-data
    # directory beside the executable without modifying the release artifact.
    Copy-Item -LiteralPath $portable -Destination $fixturePortable
    if ((Get-FileHash -LiteralPath $portable -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $fixturePortable -Algorithm SHA256).Hash) {
        throw 'The private portable fixture does not match the packaged executable.'
    }

    $env:TEMP = $appTemp
    $env:TMP = $appTemp
    Remove-Item -LiteralPath 'Env:ELECTRON_RUN_AS_NODE' -ErrorAction SilentlyContinue

    # No command-line secret, environment credential, UI automation or vault is
    # supplied. Reaching the app-owned lockfile requires the normal Electron main
    # process, which the Node-mode half above cannot create.
    $appProcess = Start-Process -FilePath $fixturePortable -PassThru -WindowStyle Hidden
    $startupDeadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Add-ObservedEntries -Root $appTemp -Observed $appObserved
        if (Test-Path -LiteralPath $startupMarker -PathType Leaf) { break }
        if ($appProcess.HasExited) {
            throw "Normal portable app exited $($appProcess.ExitCode) before creating its startup marker."
        }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $startupDeadline)

    if (-not (Test-Path -LiteralPath $startupMarker -PathType Leaf)) {
        throw 'Normal portable app did not create its beside-executable startup marker within 30 seconds.'
    }

    Add-ObservedEntries -Root $appTemp -Observed $appObserved
    $misplacedMarker = @($appObserved | Where-Object {
        ($_ -replace '/', '\') -ieq "$dataDirectoryName\lockfile"
    })
    if ($misplacedMarker.Count -ne 0) {
        throw "Normal portable app created its startup marker in redirected Temp: $($misplacedMarker -join ', ')"
    }
    Assert-NoApplicationData -Paths @($appObserved) -Context 'Normal portable app redirected Temp'

    Stop-ExactProbeProcesses -Roots @($appFixture, $appTemp)
    Add-ObservedEntries -Root $appTemp -Observed $appObserved
    Assert-NoApplicationData -Paths @($appObserved) -Context 'Normal portable app redirected Temp'
    Write-Host "Normal portable app created $dataDirectoryName\lockfile beside its executable and no application data in redirected Temp."
}
finally {
    $appRoots = @()
    if ($null -ne $appFixture) { $appRoots += $appFixture }
    if ($null -ne $appTemp) { $appRoots += $appTemp }
    if ($appRoots.Count -ne 0) { Stop-ExactProbeProcesses -Roots $appRoots }
    Restore-EnvironmentValue -Name 'TEMP' -Value $previousTemp
    Restore-EnvironmentValue -Name 'TMP' -Value $previousTmp
    Restore-EnvironmentValue -Name 'ELECTRON_RUN_AS_NODE' -Value $previousRunAsNode
    if ($null -ne $appTemp) { Remove-DisposableRoot -Path $appTemp -Prefix $appTempPrefix }
    if ($null -ne $appFixture) { Remove-DisposableRoot -Path $appFixture -Prefix $appPrefix }
}
