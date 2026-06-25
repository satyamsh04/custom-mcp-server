# Bundles PLAN.md + all project source files and sends to Ollama.
# Usage:
#   .\scripts\ask-ollama.ps1
#   .\scripts\ask-ollama.ps1 "Fix whatever npm test is failing on"
#   .\scripts\ask-ollama.ps1 "Do the next incomplete task only"

param(
    [string]$ExtraInstruction = "Do the NEXT incomplete task from PLAN.md only. Output every new/changed file using ===FILE:relative/path=== delimiters. No markdown fences. No explanation after the files."
)

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$extensions = @(".ts", ".js", ".json", ".md", ".example")
$excludeDirs = @("node_modules", "dist", "coverage", ".git")

function Get-ProjectFiles {
    Get-ChildItem -Path $Root -Recurse -File | Where-Object {
        $rel = $_.FullName.Substring($Root.Length + 1)
        $skip = $false
        foreach ($d in $excludeDirs) {
            if ($rel -like "$d*") { $skip = $true; break }
        }
        -not $skip -and ($extensions -contains $_.Extension)
    } | Sort-Object FullName
}

$context = New-Object System.Text.StringBuilder
[void]$context.AppendLine("=== PROJECT ROOT: custom-mcp-server ===")
[void]$context.AppendLine("=== TASK: $ExtraInstruction ===")
[void]$context.AppendLine("")

foreach ($file in Get-ProjectFiles) {
    $rel = $file.FullName.Substring($Root.Length + 1) -replace "\\", "/"
    [void]$context.AppendLine("===FILE:$rel===")
    [void]$context.AppendLine([System.IO.File]::ReadAllText($file.FullName))
    [void]$context.AppendLine("")
}

$systemPrompt = @"
You are the EXECUTOR for custom-mcp-server. You receive the full PLAN.md and every file already saved in the repo below.

RULES:
1. Read PLAN.md and ALL ===FILE:...=== blocks to understand current progress.
2. Task 1.1 (package.json) is DONE. Find the first incomplete task and implement ONLY that task.
3. Match existing code style. Strict TypeScript. ESM with .js import extensions.
4. Output ONLY new or changed files using ===FILE:relative/path=== then raw contents. No markdown fences.
5. If two files needed (e.g. src + test), output both in one response.
6. Do not repeat files that are already complete unless you must change them.
7. If stuck, output: PLAN AMBIGUITY: [task] — [reason]

After I save your output and run npm test, I will run this script again for the next task.
"@

Write-Host "Sending context to Ollama (qwen2.5-coder:7b)..." -ForegroundColor Cyan
Write-Host "Files included: $((Get-ProjectFiles).Count)" -ForegroundColor Gray

$context.ToString() | ollama run qwen2.5-coder:7b $systemPrompt
