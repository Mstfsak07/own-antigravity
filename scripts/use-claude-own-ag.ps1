param(
    [int]$Port = 8046,
    [string]$LocalApiKey = $env:OWN_AG_API_KEY
)

$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$Port"
$env:ANTHROPIC_API_URL = "http://127.0.0.1:$Port"
$env:ANTHROPIC_AUTH_TOKEN = if ($LocalApiKey) { $LocalApiKey } else { "local" }
$env:ANTHROPIC_API_KEY = if ($LocalApiKey) { $LocalApiKey } else { "local" }

Write-Host "ANTHROPIC_BASE_URL=$env:ANTHROPIC_BASE_URL"
Write-Host "ANTHROPIC_API_URL=$env:ANTHROPIC_API_URL"
Write-Host "ANTHROPIC_API_KEY=$([bool]$env:ANTHROPIC_API_KEY)"
Write-Host "Run: claude --model claude-sonnet-4-6 `"selam`""
