param(
    [string]$AppxPath,
    [string]$PackageDirectory = 'release'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem

if ([string]::IsNullOrWhiteSpace($AppxPath)) {
    $packages = @(Get-ChildItem -LiteralPath $PackageDirectory -File -Filter '*.appx')
    if ($packages.Count -eq 0) {
        throw "Expected at least one AppX package, found none in $PackageDirectory."
    }
}
else {
    $packages = @(Get-Item -LiteralPath $AppxPath)
}

foreach ($package in $packages) {
    $appx = (Resolve-Path -LiteralPath $package.FullName).Path
    $scratch = Join-Path ([IO.Path]::GetTempPath()) ("oda-appx-license-{0}.asar" -f [guid]::NewGuid())

    try {
        $archive = $null
        try {
            $archive = [IO.Compression.ZipFile]::OpenRead($appx)
            $asarEntries = @($archive.Entries | Where-Object {
                $_.FullName.Replace('\', '/') -match '(^|/)app/resources/app\.asar$'
            })
            if ($asarEntries.Count -ne 1) {
                throw "$($package.Name): expected exactly one app/resources/app.asar, found $($asarEntries.Count)."
            }
            $input = $asarEntries[0].Open()
            try {
                $output = [IO.File]::Create($scratch)
                try { $input.CopyTo($output) } finally { $output.Dispose() }
            }
            finally {
                $input.Dispose()
            }
        }
        finally {
            if ($null -ne $archive) { $archive.Dispose() }
        }

        & node ./.github/scripts/verify-packaged-license.mjs $scratch
        if ($LASTEXITCODE -ne 0) {
            throw "$($package.Name): first-party licence verification exited $LASTEXITCODE."
        }
        Write-Host "$($package.Name): first-party licence verified"
    }
    finally {
        Remove-Item -LiteralPath $scratch -Force -ErrorAction SilentlyContinue
    }
}
