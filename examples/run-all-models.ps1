#!/usr/bin/env pwsh
# Run mega-adversarial against multiple Groq models and compare

$raw = Get-Content C:\Users\onlin\.openclaw\agents\main\agent\auth-profiles.json -Raw
if ($raw -match '"groq:default":\s*\{[^}]*"token":\s*"([^"]+)"') {
    $env:GROQ_API_KEY = $matches[1]
} else {
    Write-Host "ERROR: Could not extract Groq key"
    exit 1
}

$models = @(
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "qwen/qwen3-32b",
    "llama-3.1-8b-instant"
)

foreach ($model in $models) {
    Write-Host ""
    Write-Host "================================================================="
    Write-Host "  ATTACKING: $model"
    Write-Host "================================================================="
    Write-Host ""
    $env:MODEL = $model
    npx tsx examples/mega-adversarial.ts 2>&1
    Write-Host ""
    Write-Host "================================================================="
    Write-Host "  DONE: $model"
    Write-Host "================================================================="
    # Brief pause to avoid rate limits
    Start-Sleep -Seconds 5
}
