# Own Antigravity

Own Antigravity is a local AI proxy/API gateway for Gemini, Anthropic-compatible clients, and simple OpenAI-compatible chat calls using credentials you control.

This project is intentionally license-clean: it does not vendor or copy implementation code from Antigravity Manager forks. External repositories were treated only as behavioral references.

## Architecture

- `src/server.ts`: Fastify server, local auth gate, route registration, health endpoints, admin status, metrics, dashboard.
- `src/runtime.ts`: shared runtime wiring for config, model aliases, metrics, Gemini/Anthropic key pools, and CloudCode account pool.
- `src/config.ts`: `.env`, environment variable, and optional `~/.own-antigravity/config.json` loading with safe defaults.
- `desktop/*`: Electron desktop shell for the account manager UI. It starts the local gateway on loopback and talks to the REST API.
- `src/providers/*`: Gemini, Anthropic `/v1/messages`, and OpenAI-compatible `/v1/chat/completions` adapters.
- `src/providers/adapter.ts`: provider adapter interface with `listModels()`, `chat()`, `streamChat()`, and `healthCheck()`.
- `src/cloudCode/*`: Google CloudCode account discovery, OAuth token refresh, account health/failover, request mapping, and streaming translation.
- `src/assets/provisioner.ts`: local-first `ls_core` and `cert.pem` discovery plus hash-checked remote sync hooks.
- `src/ls/*`: internal token server and `ls_core` instance lifecycle management with TTL cleanup and LRU reclaim.
- `src/accounts/sqliteRegistry.ts`: SQLite account registry. Tokens are encrypted when a local secret is available or stored redacted.
- `src/transcoder/*`: license-clean protocol normalization helpers for OpenAI, Responses, Anthropic, Gemini, and SSE shapes.
- `src/keyPool.ts`: provider API key health state and deterministic failover selector.
- `src/dashboard.ts`: local HTML dashboard. It never displays API keys, access tokens, or refresh tokens.

Request flow:

1. Client calls the local Fastify server.
2. Optional `OWN_AG_API_KEY` is checked for protected routes.
3. Model aliases are resolved in `runtime.resolveModel`.
4. Provider route selects a healthy API key or CloudCode account.
5. Expired CloudCode access tokens are refreshed when OAuth refresh config is available.
6. Upstream success resets failure counters; auth/rate/network/provider errors quarantine the failed key/account until `nextRetryAt`.
7. LS assets are discovered local-first; `ls_core` instances can be started/reused/stopped by the orchestrator when a valid asset exists.
8. Metrics and health snapshots are updated without exposing secrets.

## Provider Adapter Layer

Provider routes share the adapter error taxonomy and metrics path:

- `auth_error`: upstream 401/403 or credential rejection.
- `rate_limit`: upstream 429.
- `network_error`: local fetch/connectivity failure.
- `provider_error`: upstream non-auth/non-rate provider failure.
- `invalid_config`: missing local/provider configuration.
- `timeout`: aborted or timed-out upstream call.

The OpenAI-compatible `/v1/chat/completions`, Anthropic `/v1/messages`, Gemini `/v1beta/models/:modelAndAction`, and Responses `/v1/responses` routes keep their public response formats while recording provider request/error counters through the common adapter path. Native LS fallback remains conservative and adds `x-own-ag-fallback: provider` only when a native attempt fails and provider fallback is explicitly enabled.

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env`:

```dotenv
OWN_AG_PORT=8046
OWN_AG_HOST=127.0.0.1
OWN_AG_API_KEY=change-me

OWN_AG_GEMINI_API_KEY=
OWN_AG_ANTHROPIC_API_KEY=
```

LS bridge settings:

```dotenv
OWN_AG_DATA_DIR=
OWN_AG_LS_ENABLED=true
OWN_AG_NATIVE_LS_ENABLED=false
OWN_AG_PROVIDER_FALLBACK=true
OWN_AG_LS_BIN_DIR=
OWN_AG_LS_CORE_PATH=
OWN_AG_LS_CERT_PATH=
OWN_AG_CERT_PATH=
OWN_AG_LS_PROVISION_MODE=Auto
OWN_AG_LS_INSTANCE_TTL_SECONDS=1800
OWN_AG_LS_MAX_INSTANCES=3
OWN_AG_LS_REQUEST_TIMEOUT_MS=30000
OWN_AG_LS_TRANSPORT=stdio
OWN_AG_LS_WORKDIR=
OWN_AG_LS_EXTRA_ARGS=
```

Native LS mode starts a local `ls_core` process, injects only the current user's valid account token through an internal loopback auth server, sends requests through the configured transport, and normalizes native output into OpenAI/Anthropic/Gemini response shapes. Set `OWN_AG_NATIVE_LS_ENABLED=true` to try native LS first. If `OWN_AG_PROVIDER_FALLBACK=true`, native failures fall back to the existing provider proxy and responses include `x-own-ag-fallback: provider`.

Native protocol contract settings:

```dotenv
OWN_AG_LS_TRANSPORT=stdio
OWN_AG_LS_INIT_METHOD=initialize
OWN_AG_LS_REQUEST_METHOD=request
OWN_AG_LS_STREAM_METHOD=stream
OWN_AG_LS_ENDPOINT=
OWN_AG_LS_PROTO_PATH=
OWN_AG_LS_SERVICE_NAME=
OWN_AG_LS_METHOD_NAME=
```

JSON-RPC stdio example:

```dotenv
OWN_AG_LS_TRANSPORT=stdio
OWN_AG_LS_INIT_METHOD=initialize
OWN_AG_LS_REQUEST_METHOD=request
OWN_AG_LS_STREAM_METHOD=
```

The stdio adapter sends newline-delimited JSON-RPC messages like:

```json
{"jsonrpc":"2.0","id":"...","method":"request","params":{"model":"gemini-2.5-pro","body":{},"format":"openai"}}
```

HTTP adapter example:

```dotenv
OWN_AG_LS_TRANSPORT=http
OWN_AG_LS_ENDPOINT=http://127.0.0.1:9000/
OWN_AG_LS_REQUEST_METHOD=/request
OWN_AG_LS_INIT_METHOD=/initialize
```

WebSocket adapter example:

```dotenv
OWN_AG_LS_TRANSPORT=websocket
OWN_AG_LS_ENDPOINT=ws://127.0.0.1:9001/native
```

gRPC scaffold example:

```dotenv
OWN_AG_LS_TRANSPORT=grpc
OWN_AG_LS_PROTO_PATH=C:\path\to\service.proto
OWN_AG_LS_SERVICE_NAME=package.Service
OWN_AG_LS_METHOD_NAME=Generate
```

The gRPC adapter validates config and reports unsupported unless runtime gRPC client dependencies are added; it does not infer or reverse-engineer private proto contracts.

Asset provisioning modes:

- `Auto`: prefer local `ls_core` and `cert.pem`; remote sync is used only if configured.
- `LocalOnly`: never download remote assets.
- `ForceRemote`: fetch a manifest and assets only when `OWN_AG_LS_REMOTE_MANIFEST_URL` and expected hashes are configured.

Multiple upstream keys can be comma-separated:

```dotenv
OWN_AG_GEMINI_API_KEYS=key-one,key-two
OWN_AG_ANTHROPIC_API_KEYS=key-one,key-two
```

CloudCode account files are read from `~/.antigravity_tools/accounts` by default:

```dotenv
OWN_AG_CLOUDCODE_ENABLED=true
OWN_AG_CLOUDCODE_ACCOUNTS_DIR=
OWN_AG_CLOUDCODE_REFRESH_SKEW_SECONDS=120
OWN_AG_CLOUDCODE_QUARANTINE_SECONDS=300
```

Token refresh requires your own valid Google OAuth client configuration:

```dotenv
OWN_AG_GOOGLE_OAUTH_ENABLED=false
OWN_AG_GOOGLE_CLIENT_ID=
OWN_AG_GOOGLE_CLIENT_SECRET=
OWN_AG_GOOGLE_REDIRECT_URI=http://127.0.0.1:8046/auth/google/callback
OWN_AG_GOOGLE_SCOPES=openid,email,profile,https://www.googleapis.com/auth/cloud-platform
OWN_AG_TOKEN_ENCRYPTION_KEY=
OWN_AG_GOOGLE_OAUTH_TOKEN_URL=https://oauth2.googleapis.com/token
```

If refresh config is missing, expired CloudCode accounts are marked unhealthy instead of silently reusing stale tokens.

## Google OAuth Login

Own Antigravity can add CloudCode accounts through a local Google OAuth authorization code flow. The flow is explicit: you click `Login with Google`, complete Google consent in your browser, and the callback stores encrypted tokens in `OWN_AG_DATA_DIR/accounts.sqlite`.

1. Create an OAuth client in Google Cloud Console.
2. Choose a desktop or web OAuth client that allows a loopback redirect.
3. Add this authorized redirect URI exactly:

```text
http://127.0.0.1:8046/auth/google/callback
```

Use your configured port if `OWN_AG_PORT` is not `8046`. The redirect host must be `127.0.0.1`; non-loopback callback URLs are rejected.

Configure `.env`:

```dotenv
OWN_AG_GOOGLE_OAUTH_ENABLED=true
OWN_AG_GOOGLE_CLIENT_ID=<your-client-id>
OWN_AG_GOOGLE_CLIENT_SECRET=<your-client-secret>
OWN_AG_GOOGLE_REDIRECT_URI=http://127.0.0.1:8046/auth/google/callback
OWN_AG_GOOGLE_SCOPES=openid,email,profile,https://www.googleapis.com/auth/cloud-platform
OWN_AG_TOKEN_ENCRYPTION_KEY=<long-random-local-secret>
```

Then start the server and open the dashboard:

```powershell
npm run dev
```

```text
http://127.0.0.1:8046/
```

Enter the local API key if configured, then click `Login with Google`. Connected accounts appear with source `oauth_login`. Existing `~/.antigravity_tools/accounts/*.json` accounts continue to load with source `imported_json`.

Management endpoints:

- `GET /auth/google/start`: starts OAuth with state and PKCE, requires the local admin API key.
- `GET /auth/google/callback`: Google callback, validated by OAuth state.
- `GET /auth/accounts`: lists accounts without access or refresh tokens, requires the local admin API key.
- `GET /auth/accounts/summary`: account counts, health counts, active account, best healthy account suggestion, and unknown quota placeholders when quota metadata is unavailable.
- `POST /auth/accounts/import/refresh-token`: imports a user-provided refresh token into encrypted SQLite storage.
- `POST /auth/accounts/import/json`: imports a user-provided account JSON into encrypted SQLite storage.
- `POST /auth/accounts/export`: exports sanitized account data by default, or encrypted registry rows when `includeEncryptedSecrets` is true.
- `POST /auth/accounts/switch/:accountId`: marks the active account for the manager UI.
- `POST /auth/google/logout/:accountId`: removes the account from SQLite and runtime pools, requires the local admin API key.

Troubleshooting:

- `refresh token missing`: Google may not return a refresh token if the app was already approved. Revoke app access from your Google account, then login again; the flow requests `access_type=offline` and `prompt=consent`.
- `invalid client`: check `OWN_AG_GOOGLE_CLIENT_ID` and `OWN_AG_GOOGLE_CLIENT_SECRET`.
- `redirect_uri_mismatch`: the Google Console redirect URI must exactly match `OWN_AG_GOOGLE_REDIRECT_URI`, including port and path.
- `token encryption key missing`: set `OWN_AG_TOKEN_ENCRYPTION_KEY`; OAuth login refuses to store plaintext tokens.

## Run

```powershell
npm run dev
```

After building:

```powershell
npm run build
node dist/cli.js server --port 8046
```

Useful commands:

```powershell
npm run doctor
npm run accounts
npm run diagnose:ls
npm test
```

Multi-agent automation:

```powershell
node dist/cli.js automate --plan .\examples\automation-plan.json
```

This command can start the local gateway if nothing is already listening on `OWN_AG_HOST:OWN_AG_PORT`, then run phase/task plans through installed `claude` and `gemini` CLIs. By default both CLIs are routed through Own Antigravity. Use `--direct` to skip proxy env injection.

If a `claude` or `gemini` run fails, the automation runner tries to recover before giving up:

- retry with proxy/direct mode flipped
- retry with a safer fallback model for the same provider
- retry on the alternate provider and continue the project task there
- if every attempt fails, record unresolved recovery items and keep them available to later tasks

Desktop manager:

```powershell
npm run desktop
```

The desktop app is an Electron shell over the local REST gateway. It provides account cards, OAuth/manual/JSON import, encrypted export, account switching, TR/EN language toggle, dark/light mode, settings, toast notifications, and an error panel. It does not read browser cookies, WebView storage, or other applications' sessions.

Development desktop run:

```powershell
npm run desktop:dev
```

## Account Import and Export

Accounts can be added from the desktop app or REST API using:

- Google OAuth login with your own configured OAuth client.
- Manual refresh token import supplied by the user.
- User-provided JSON import.

Exports are sanitized by default. The encrypted export option returns encrypted registry rows from SQLite for backup/restore workflows; plaintext access tokens, refresh tokens, API keys, and bearer headers are never displayed by the desktop UI.

## Windows Packaging

Packaging uses Electron Builder:

```powershell
npm run desktop:pack
npm run desktop:dist
```

`desktop:pack` creates an unpacked app under `release/`. `desktop:dist` targets Windows portable and NSIS installer outputs. If NSIS is unavailable or signing is not configured, use the portable artifact as the fallback desktop package.

PowerShell helpers:

```powershell
.\scripts\start-own-ag.ps1
. .\scripts\use-gemini-own-ag.ps1
. .\scripts\use-claude-own-ag.ps1
```

## Automation Plans

Automation plans are JSON files that describe phases and tasks. Each task is assigned to either `claude` or `gemini`, with an optional explicit model.

Example:

```json
{
  "goal": "Implement the feature plan from the user",
  "workspaceDir": ".",
  "phases": [
    {
      "id": "discovery",
      "title": "Discovery",
      "objective": "Map the repo and identify the implementation surface",
      "tasks": [
        {
          "id": "claude-architecture",
          "title": "Architecture read",
          "provider": "claude",
          "model": "claude-sonnet-4-6",
          "role": "senior backend engineer",
          "prompt": "Inspect the repository, identify the modules that must change, and update code if the task is straightforward."
        },
        {
          "id": "gemini-risk-pass",
          "title": "Risk review",
          "provider": "gemini",
          "model": "gemini-2.5-pro",
          "role": "test and integration reviewer",
          "prompt": "Review the first task output, identify regressions, and suggest any missing implementation work."
        }
      ]
    }
  ]
}
```

Outputs are written under `.own-ag-runs/<timestamp>/`:

- `plan.json`: resolved input plan
- `SUMMARY.md`: phase-by-phase summary
- `report.json`: machine-readable aggregate report
- `<phase>/<task>.raw.txt`: raw CLI output
- `<phase>/<task>.json`: parsed task result
- `<phase>/<task>.attempts.json`: recovery attempts and failure details

Each task receives summaries and follow-up items from previous tasks so incomplete work can be carried into later phases.

## Client Examples

Gemini CLI:

```powershell
$env:GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:8046"
$env:GEMINI_API_KEY=$env:OWN_AG_API_KEY
gemini -p "selam"
```

Anthropic-compatible request:

```powershell
$body = @{
  model = "claude-sonnet-4-6"
  max_tokens = 128
  messages = @(@{ role = "user"; content = "selam" })
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8046/v1/messages -ContentType "application/json" -Body $body -Headers @{ Authorization = "Bearer <OWN_AG_API_KEY>" }
```

## Dashboard

Open:

```text
http://127.0.0.1:8046/
```

The dashboard shows provider status, account counts, healthy/unhealthy state, request count, error count, last error, uptime, aliases, and sanitized raw status.

It also shows active LS instances, provision status, asset path, version metadata when available, and recent sanitized errors. `GET /v1/events` exposes a lightweight SSE snapshot stream for dashboard-style polling.

## Verify Native LS

Native LS diagnostics verify only the configured local integration path. They do not inspect private databases, sniff traffic, reverse-engineer closed protocols, bypass sandboxes, or log tokens.

Required settings:

```dotenv
OWN_AG_NATIVE_LS_ENABLED=true
OWN_AG_LS_CORE_PATH=C:\path\to\ls_core.exe
OWN_AG_LS_CERT_PATH=C:\path\to\cert.pem
OWN_AG_LS_TRANSPORT=stdio
OWN_AG_LS_INIT_METHOD=initialize
OWN_AG_LS_REQUEST_METHOD=request
OWN_AG_LS_STREAM_METHOD=stream
```

For HTTP, WebSocket, or gRPC transports, also configure the matching endpoint/protocol fields described in the setup section.

Run from CLI:

```powershell
npm run diagnose:ls
```

Run from API:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8046/v1/ls/diagnostics/run `
  -Headers @{ Authorization = "Bearer <OWN_AG_API_KEY>" } `
  -ContentType "application/json" `
  -Body '{"disableFallback":true,"timeoutMs":10000}'
```

`disableFallback=true` is the strict mode: if native LS cannot complete the handshake/request, the diagnostic fails instead of counting provider fallback as success.

Successful response shape:

```json
{
  "nativeEnabled": true,
  "selectedTransport": "stdio",
  "binary": { "path": "C:\\path\\to\\ls_core.exe", "found": true },
  "cert": { "path": "C:\\path\\to\\cert.pem", "found": true },
  "process": { "spawnSuccess": true, "pid": 1234, "startupTimeMs": 2200 },
  "handshake": { "success": true },
  "nativeRequest": { "success": true, "responseReceived": true },
  "streamingSupport": "yes",
  "fallbackUsed": false
}
```

Failure response shape:

```json
{
  "nativeEnabled": true,
  "selectedTransport": "stdio",
  "binary": { "found": false },
  "cert": { "found": false },
  "process": { "spawnSuccess": false },
  "handshake": { "success": false },
  "nativeRequest": { "success": false },
  "streamingSupport": "unknown",
  "fallbackUsed": false,
  "error": { "code": "LsCoreMissing", "message": "ls_core asset was not found" }
}
```

Common results:

- `binary missing`: `OWN_AG_LS_CORE_PATH` or local asset discovery did not find `ls_core`.
- `cert missing`: the configured/local certificate was not found. Some transports may still start, but TLS-backed flows may fail later.
- `LsProtocolError`: the configured transport, init method, or request method does not match the running LS process contract.
- `LsRequestTimeout`: process started but handshake or request did not complete within `timeoutMs`.
- `fallback used`: native request failed and provider fallback was enabled. Re-run with `disableFallback=true` to verify native-only behavior.

## Supported Endpoints

- `GET /health`
- `GET /health/providers`
- `GET /health/accounts`
- `GET /metrics`
- `GET /admin/status`
- `GET /admin/metrics`
- `GET /v1/instances`
- `POST /v1/instances`
- `DELETE /v1/instances/:id`
- `POST /v1/instances/:id/restart`
- `GET /v1/provision/status`
- `POST /v1/provision/sync`
- `GET /v1/protocol/status`
- `POST /v1/protocol/test`
- `GET /v1/events`
- `GET /v1/models`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1beta/models/:model:generateContent`
- `POST /v1beta/models/:model:streamGenerateContent`
- `GET /v1beta/models`

## Antigravity Assets

For native LS bridge experiments, provide `ls_core` and optionally `cert.pem` from your own local Antigravity installation:

- Windows: set `OWN_AG_LS_CORE_PATH` to `ls_core.exe` or place it under `OWN_AG_LS_BIN_DIR`.
- Windows example: `OWN_AG_LS_CORE_PATH=C:\Users\<you>\AppData\Local\Programs\Antigravity\resources\app\bin\ls_core.exe`
- Windows cert example: `OWN_AG_CERT_PATH=C:\Users\<you>\AppData\Local\Programs\Antigravity\resources\app\bin\cert.pem`
- Linux/macOS: set `OWN_AG_LS_CORE_PATH` to the executable `ls_core` or place it under `OWN_AG_LS_BIN_DIR`.
- Docker: mount a local data directory and asset directory; remote containers cannot see your host workspace unless mounted.

Remote asset sync is intentionally conservative. A manifest URL alone is not enough for safe operation; hashes must match before assets are accepted.

## Security Notes

- Do not expose this server to the public internet.
- Keep `OWN_AG_HOST=127.0.0.1` unless you understand the network risk.
- Set `OWN_AG_API_KEY` for local client authentication.
- Secrets are redacted from health/admin output and logs.
- Account/key failover is conservative. It is for fault tolerance with your own valid credentials, not rate-limit bypass, ban avoidance, or aggressive account rotation.
- Quota/rate-limit responses quarantine the failed credential temporarily; the proxy does not try to evade provider limits.
- Process spawning uses configured/local resolved paths only. User-controlled traversal paths are rejected in asset writes.
- Hidden reasoning tags are stripped by the transcoder; chain-of-thought is not returned.
- Renderer code does not receive Node APIs. Electron exposes only a narrow preload bridge for gateway URL discovery and validated external browser opens.
- The UI stores the local admin key only in renderer local storage for convenience and masks it in the settings input. Do not treat that as a secure vault.

## Audit Status

`npm audit` currently reports 5 moderate development-only findings through `vitest -> vite -> esbuild`. The available npm fix upgrades Vitest to `4.1.5`, which is a semver-major change. This patch does not apply the breaking upgrade; production runtime dependencies are not part of the reported chain.

## Troubleshooting

- `missing key`: set `OWN_AG_GEMINI_API_KEY`, `OWN_AG_GEMINI_API_KEYS`, `OWN_AG_ANTHROPIC_API_KEY`, or `OWN_AG_ANTHROPIC_API_KEYS`.
- `no accounts`: verify `OWN_AG_CLOUDCODE_ACCOUNTS_DIR` or run `npm run accounts`.
- expired CloudCode token: set `OWN_AG_GOOGLE_OAUTH_CLIENT_ID` and `OWN_AG_GOOGLE_OAUTH_CLIENT_SECRET`, or re-authenticate the account with the tool that created it.
- repeated auth failures: check `/health/accounts` or `/health/providers`; failed credentials stay quarantined until `nextRetryAt`.
- local auth failure: send `Authorization: Bearer <OWN_AG_API_KEY>` or `x-api-key: <OWN_AG_API_KEY>`.
- `ls_core asset was not found`: set `OWN_AG_LS_CORE_PATH`, place `ls_core` under `OWN_AG_LS_BIN_DIR`, or use `/v1/provision/sync` with a hash-verified remote manifest.
- `cert missing`: set `OWN_AG_CERT_PATH` or `OWN_AG_LS_CERT_PATH`; some native binaries may still start without it, but backend TLS flows may fail.
- `process crash`: check dashboard instance `status`, `exitCode`, `crashCount`, and `lastError`.
- `timeout`: increase `OWN_AG_LS_REQUEST_TIMEOUT_MS` or inspect whether `ls_core` supports the configured `OWN_AG_LS_TRANSPORT`.
- `token refresh failed`: verify `OWN_AG_GOOGLE_OAUTH_CLIENT_ID`, `OWN_AG_GOOGLE_OAUTH_CLIENT_SECRET`, and the account file refresh token.
- `protocol config missing`: check `/v1/protocol/status`, `OWN_AG_LS_INIT_METHOD`, `OWN_AG_LS_REQUEST_METHOD`, and `OWN_AG_LS_ENDPOINT` for non-stdio transports.
- mock LS tests: run `npm test -- src/providers/native.e2e.test.ts src/ls/protocols/stdio-jsonrpc.test.ts`.
- Docker workspace issue: mount both the asset directory and any workspace paths the native process must read.

## Known Limitations

- Quota is shown as `unknown` unless an imported account includes real quota metadata.
- Native LS support depends on a user-supplied local binary and explicit protocol configuration; private protocol inference is intentionally out of scope.
- Windows installers are prepared but not code-signed.
- Provider failover is for resilience only. The gateway does not implement rate-limit bypass, ban avoidance, or aggressive account rotation.

## Config File

Optional config path:

```text
~/.own-antigravity/config.json
```

Use `.env.example` as the source of truth for supported settings and safe defaults.
