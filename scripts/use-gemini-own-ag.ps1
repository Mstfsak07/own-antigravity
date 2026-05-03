param(
    [int]$Port = 8046,
    [string]$LocalApiKey = $env:OWN_AG_API_KEY
)

$env:GOOGLE_GEMINI_BASE_URL = "http://127.0.0.1:$Port"

if ($LocalApiKey) {
    $env:GEMINI_API_KEY = $LocalApiKey
}

Write-Host "GOOGLE_GEMINI_BASE_URL=$env:GOOGLE_GEMINI_BASE_URL"
Write-Host "GEMINI_API_KEY=$([bool]$env:GEMINI_API_KEY)"
Write-Host "Run: gemini -p `"selam`""
