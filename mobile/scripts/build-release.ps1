<#
.SYNOPSIS
    Builds the signed, standalone StarCore Android release APK.

.DESCRIPTION
    The JS bundle is embedded in the APK (no Metro, USB or ADB needed to run it). The
    version comes from the repository's VERSION file; versionCode, commit, build number and
    date are stamped by android/app/build.gradle. The APK is signed with the release key
    from keystore.properties (see docs/releasing.md) - this script refuses to produce an
    unsigned or debug-signed release.

    Output: dist/StarCore-<version>.apk and dist/StarCore-<version>.apk.sha256 at the
    repository root (dist/ is gitignored).

.PARAMETER JavaHome
    JDK 17 to build with, for this build only. Defaults to $env:STARCORE_JAVA_HOME, then
    $env:JAVA_HOME. Machine-wide Java settings are never changed.

.PARAMETER AllowDirty
    Build even though tracked files differ from the checked-out commit. The app then shows
    "<commit> + local changes", so a published APK should never be built this way.

.EXAMPLE
    pwsh mobile/scripts/build-release.ps1 -JavaHome C:\Users\me\.jdks\ms-17.0.20.1
#>
param(
    [string]$JavaHome = $(if ($env:STARCORE_JAVA_HOME) { $env:STARCORE_JAVA_HOME } else { $env:JAVA_HOME }),
    [switch]$AllowDirty
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$android = Join-Path $repo "mobile\android"
$version = (Get-Content (Join-Path $repo "VERSION") -Raw).Trim()

function Fail($message) { Write-Host "ERROR: $message" -ForegroundColor Red; exit 1 }

if (-not $JavaHome -or -not (Test-Path (Join-Path $JavaHome "bin\java.exe"))) {
    Fail "no JDK 17 found - pass -JavaHome or set STARCORE_JAVA_HOME"
}

# the same order build.gradle looks in
$keystoreProps = @(
    $env:STARCORE_KEYSTORE_PROPERTIES,
    (Join-Path $android "keystore.properties"),
    (Join-Path $env:USERPROFILE ".starcore\signing\keystore.properties")
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $keystoreProps) {
    Fail "no release keystore.properties found - see docs/releasing.md, 'Signing key'"
}

$dirty = git -C $repo status --porcelain --untracked-files=no
if ($dirty -and -not $AllowDirty) {
    Fail "tracked files have uncommitted changes - commit (or pass -AllowDirty for a test build)"
}
$commit = git -C $repo rev-parse --short=7 HEAD

Write-Host "Building StarCore $version for Android ($commit$(if ($dirty) { ' + local changes' }))"
Write-Host "Signing with: $keystoreProps"

$env:JAVA_HOME = $JavaHome   # this process only
Push-Location $android
try {
    & .\gradlew.bat assembleRelease --console=plain
    if ($LASTEXITCODE -ne 0) { Fail "gradle assembleRelease failed" }
} finally {
    Pop-Location
}

$built = Join-Path $android "app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path $built)) {
    Fail "no signed app-release.apk was produced (an unsigned build means the keystore was not picked up)"
}

# verify the signature with the newest build-tools apksigner
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$apksigner = Get-ChildItem (Join-Path $sdk "build-tools") -Directory |
    Sort-Object { [version]($_.Name -replace '[^0-9.]', '') } -Descending |
    ForEach-Object { Join-Path $_.FullName "apksigner.bat" } |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $apksigner) { Fail "apksigner not found under $sdk\build-tools" }
$certs = & $apksigner verify --print-certs $built 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Fail "apksigner could not verify the APK:`n$certs" }
if ($certs -match "CN=Android Debug") { Fail "the APK is signed with the DEBUG key - refusing to publish it" }

$dist = Join-Path $repo "dist"
New-Item -ItemType Directory -Force $dist | Out-Null
$out = Join-Path $dist "StarCore-$version.apk"
Copy-Item $built $out -Force
$hash = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
# LF and no BOM, so `sha256sum -c` reads it on Linux and macOS too
[IO.File]::WriteAllText("$out.sha256", "$hash  StarCore-$version.apk`n", (New-Object System.Text.UTF8Encoding $false))

Write-Host ""
Write-Host "APK:     $out"
Write-Host "SHA-256: $hash"
Write-Host (($certs -split "`n") | Where-Object { $_ -match "certificate SHA-256 digest|certificate DN" } | ForEach-Object { $_.Trim() }) -Separator "`n"
