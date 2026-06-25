# Saves Ollama output (with ===FILE:path=== markers) into the repo.
# Usage:
#   Get-Content ollama-out.txt -Raw | .\scripts\save-ollama-output.ps1
# Or paste into ollama-out.txt then run:
#   .\scripts\save-ollama-output.ps1 ollama-out.txt

param(
    [string]$InputFile = "ollama-out.txt"
)

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

if (-not (Test-Path $InputFile)) {
    Write-Error "File not found: $InputFile. Save Ollama output to ollama-out.txt first."
    exit 1
}

$text = Get-Content $InputFile -Raw
$pattern = '===FILE:([^=]+)==='
$matches = [regex]::Matches($text, $pattern)

if ($matches.Count -eq 0) {
    Write-Error "No ===FILE:path=== markers found in $InputFile"
    exit 1
}

for ($i = 0; $i -lt $matches.Count; $i++) {
    $relPath = $matches[$i].Groups[1].Value.Trim() -replace "/", "\"
    $start = $matches[$i].Index + $matches[$i].Length
    $end = if ($i + 1 -lt $matches.Count) { $matches[$i + 1].Index } else { $text.Length }
    $content = $text.Substring($start, $end - $start).Trim()

    # Strip accidental markdown fences
    $content = $content -replace '^```[\w]*\r?\n', '' -replace '\r?\n```\s*$', ''

    $fullPath = Join-Path $Root $relPath
    $dir = Split-Path -Parent $fullPath
    if ($dir -and -not (Test-Path $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }

    [System.IO.File]::WriteAllText($fullPath, $content + "`n")
    Write-Host "Wrote: $relPath" -ForegroundColor Green
}

Write-Host "`nDone. Run: npm test" -ForegroundColor Cyan
