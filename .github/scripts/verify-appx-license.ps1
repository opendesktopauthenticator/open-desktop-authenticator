param(
    [string]$AppxPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem

if ([string]::IsNullOrWhiteSpace($AppxPath)) {
    $packages = @(Get-ChildItem -LiteralPath release -File -Filter '*.appx')
    if ($packages.Count -ne 1) {
        throw "Expected exactly one AppX package, found $($packages.Count)."
    }
    $AppxPath = $packages[0].FullName
}

$appx = (Resolve-Path -LiteralPath $AppxPath).Path
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("oda-appx-license-{0}.asar" -f [guid]::NewGuid())

try {
    $archive = $null
    try {
        $archive = [IO.Compression.ZipFile]::OpenRead($appx)
        $asarEntries = @($archive.Entries | Where-Object {
            $_.FullName.Replace('\', '/') -match '(^|/)app/resources/app\.asar$'
        })
        if ($asarEntries.Count -ne 1) {
            throw "Expected exactly one app/resources/app.asar in the AppX, found $($asarEntries.Count)."
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
    if ($LASTEXITCODE -ne 0) { throw "First-party licence verification exited $LASTEXITCODE." }
}
finally {
    Remove-Item -LiteralPath $scratch -Force -ErrorAction SilentlyContinue
}
