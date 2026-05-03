param(
    [int]$Port = 8046,
    [string]$HostName = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Push-Location $projectRoot
try {
    npm run build
    node dist/cli.js server --host $HostName --port $Port
}
finally {
    Pop-Location
}
