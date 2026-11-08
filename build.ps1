# ClipForge - build script
# Usage: run in PowerShell, or right-click and run with PowerShell.
# Output: .\dist\ClipForge.exe (and copies third-party tools to dist\lib)

$ErrorActionPreference = "Stop"
$srcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc    = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$outDir = Join-Path $srcDir "dist"
$out    = Join-Path $outDir "ClipForge.exe"
$libSrc = Join-Path $srcDir "lib"
$libDst = Join-Path $outDir "lib"

if (-not (Test-Path -LiteralPath $csc)) { Write-Host "csc.exe (.NET Framework 4.x compiler) not found"; exit 1 }
if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
if (-not (Test-Path -LiteralPath $libDst)) { New-Item -ItemType Directory -Path $libDst | Out-Null }

$sources = @(
    (Join-Path $srcDir "src\ClipForge.cs"),
    (Join-Path $srcDir "src\Snapshot.cs")
)

& $csc /nologo /target:winexe /optimize+ /out:"$out" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.dll `
    @sources

if ($LASTEXITCODE -ne 0) { Write-Host "Build failed, exit code $LASTEXITCODE"; exit $LASTEXITCODE }

# Copy third-party tools into dist\lib for distribution
if (Test-Path -LiteralPath $libSrc) {
    Get-ChildItem -LiteralPath $libSrc -File | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $libDst $_.Name) -Force
    }
}

Write-Host "Build complete: $out"
