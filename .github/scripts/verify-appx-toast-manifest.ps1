param(
	[string]$PackageDirectory = 'release',
	[string]$ExpectedClsid = 'FB72EFDC-FEA0-44CD-9DD5-FFCFBEDBF734'
)

$ErrorActionPreference = 'Stop'
$packages = @(Get-ChildItem -LiteralPath $PackageDirectory -Filter '*.appx' -File)
if ($packages.Count -eq 0) {
	throw "No AppX package was found in $PackageDirectory"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem

foreach ($package in $packages) {
	$extractDirectory = Join-Path ([IO.Path]::GetTempPath()) (
		'oda-appx-manifest-' + [Guid]::NewGuid().ToString('N')
	)
	[IO.Directory]::CreateDirectory($extractDirectory) | Out-Null
	[IO.Compression.ZipFile]::ExtractToDirectory($package.FullName, $extractDirectory)

	$manifestPath = Join-Path $extractDirectory 'AppxManifest.xml'
	if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
		throw "$($package.Name) does not contain AppxManifest.xml"
	}

	[xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
	$namespaces = [Xml.XmlNamespaceManager]::new($manifest.NameTable)
	$namespaces.AddNamespace('f', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10')
	$namespaces.AddNamespace('desktop', 'http://schemas.microsoft.com/appx/manifest/desktop/windows10')
	$namespaces.AddNamespace('com', 'http://schemas.microsoft.com/appx/manifest/com/windows10')

	$application = $manifest.SelectSingleNode(
		'/f:Package/f:Applications/f:Application',
		$namespaces
	)
	if ($null -eq $application) {
		throw "$($package.Name) has no packaged desktop application"
	}

	$comServers = @($application.SelectNodes(
		'f:Extensions/com:Extension[@Category="windows.comServer"]/com:ComServer/com:ExeServer',
		$namespaces
	))
	$toastActivators = @($application.SelectNodes(
		'f:Extensions/desktop:Extension[@Category="windows.toastNotificationActivation"]/desktop:ToastNotificationActivation',
		$namespaces
	))
	if ($comServers.Count -ne 1 -or $toastActivators.Count -ne 1) {
		throw "$($package.Name) must contain exactly one COM server and one toast activator"
	}

	$classes = @($comServers[0].SelectNodes('com:Class', $namespaces))
	if ($classes.Count -ne 1) {
		throw "$($package.Name) must contain exactly one toast-activator COM class"
	}

	$classId = $classes[0].GetAttribute('Id')
	$toastId = $toastActivators[0].GetAttribute('ToastActivatorCLSID')
	if ($classId -ne $ExpectedClsid -or $toastId -ne $ExpectedClsid) {
		throw "$($package.Name) does not bind both activation declarations to $ExpectedClsid"
	}

	$applicationExecutable = $application.GetAttribute('Executable')
	$serverExecutable = $comServers[0].GetAttribute('Executable')
	if ($serverExecutable -ne $applicationExecutable) {
		throw "$($package.Name) registers $serverExecutable but packages $applicationExecutable"
	}

	Write-Host "$($package.Name): toast activation manifest verified"
}
