# Own Antigravity

> A local-first AI gateway and desktop account manager for Gemini, Anthropic-compatible clients, and OpenAI-compatible APIs.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-Runtime-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Fastify](https://img.shields.io/badge/Fastify-API-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![Electron](https://img.shields.io/badge/Electron-Desktop-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-Storage-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Own Antigravity is a **local AI gateway and infrastructure layer** that provides a unified interface for multiple AI providers while handling authentication, account management, provider failover, streaming, metrics, diagnostics, and optional native local runtime integration.

The project also includes an **Electron desktop application** for managing accounts, OAuth authentication, gateway configuration, and runtime status.

---

## ✨ Highlights

- 🔌 **Multi-provider AI gateway**
  - OpenAI-compatible Chat Completions
  - OpenAI Responses API
  - Anthropic-compatible Messages API
  - Gemini API

- 🧩 **Provider adapter architecture**
  - Shared provider interface
  - Streaming and non-streaming requests
  - Unified error classification
  - Common metrics and health reporting

- 🔐 **Authentication & credential management**
  - Local API authentication
  - Google OAuth with PKCE
  - Encrypted SQLite token storage
  - Account import/export
  - Sanitized account information

- 🔄 **Health-aware failover**
  - Provider/API-key health tracking
  - Failure counters
  - Temporary credential quarantine
  - Deterministic failover selection

- 🖥️ **Electron desktop manager**
  - Google OAuth login
  - Account management
  - Account switching
  - Import/export workflows
  - Runtime diagnostics
  - Dark/light mode
  - Turkish/English interface

- ⚙️ **Native local runtime integration**
  - Local `ls_core` process management
  - Configurable transports
  - Process lifecycle management
  - TTL cleanup
  - LRU instance reclamation
  - Runtime diagnostics

- 📊 **Observability**
  - Health endpoints
  - Provider/account status
  - Request and error metrics
  - Runtime diagnostics
  - Server-Sent Events

- 🤖 **Multi-agent automation**
  - Claude CLI integration
  - Gemini CLI integration
  - Structured automation plans
  - Retry and recovery strategies
  - Machine-readable execution reports

---

## 🏗️ Architecture

```text
                         AI Clients
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
       Gemini CLI       Claude CLI      OpenAI Clients
          │                 │                 │
          └─────────────────┼─────────────────┘
                            │
                            ▼
                ┌───────────────────────────┐
                │     Own Antigravity       │
                │       Fastify API         │
                ├───────────────────────────┤
                │                           │
                │   Provider Adapter Layer  │
                │                           │
                │   ┌──────┬───────┬─────┐ │
                │   │Gemini│Anthropic│OpenAI│
                │   └──────┴───────┴─────┘ │
                │                           │
                │   Account / Key Pool      │
                │   Health + Failover       │
                │                           │
                │   Metrics / Health        │
                │   Runtime Orchestration   │
                └─────────────┬─────────────┘
                              │
             ┌────────────────┼────────────────┐
             │                │                │
             ▼                ▼                ▼
          SQLite          CloudCode       Local Runtime
       Account Registry    Accounts          ls_core
```

The architecture keeps provider-specific behavior behind adapters while authentication, health tracking, metrics, routing, and runtime management remain shared.

---

## 🧩 Core Components

| Component | Responsibility |
|---|---|
| `src/server.ts` | Fastify server, authentication, routes, dashboard and metrics |
| `src/runtime.ts` | Shared runtime wiring, model aliases and provider configuration |
| `src/config.ts` | Environment and local configuration loading |
| `src/providers/*` | Gemini, Anthropic and OpenAI-compatible provider adapters |
| `src/providers/adapter.ts` | Common provider abstraction |
| `src/cloudCode/*` | Account discovery, OAuth refresh and account failover |
| `src/accounts/sqliteRegistry.ts` | Local encrypted account registry |
| `src/keyPool.ts` | API-key health tracking and failover |
| `src/transcoder/*` | Cross-provider protocol normalization |
| `src/ls/*` | Local runtime process lifecycle management |
| `src/dashboard.ts` | Local monitoring dashboard |
| `desktop/*` | Electron desktop manager |

---

## 🔌 Provider Adapter Layer

Providers implement a shared adapter contract:

```text
listModels()
chat()
streamChat()
healthCheck()
```

This allows provider-specific implementation details to remain isolated from the gateway core.

Supported provider interfaces include:

- OpenAI-compatible Chat Completions
- OpenAI Responses
- Anthropic Messages
- Gemini Generate Content
- Gemini streaming

Common provider failures are normalized into a shared error taxonomy:

| Error | Meaning |
|---|---|
| `auth_error` | Authentication or credential failure |
| `rate_limit` | Upstream rate limit |
| `network_error` | Local connectivity failure |
| `provider_error` | Other upstream provider failure |
| `invalid_config` | Missing or invalid configuration |
| `timeout` | Request timeout or cancellation |

---

## 🔐 Security

Own Antigravity is designed primarily for **local-first operation**.

Security-related design decisions include:

- The gateway binds to `127.0.0.1` by default.
- Protected routes can require `OWN_AG_API_KEY`.
- Access and refresh tokens are not displayed in the dashboard.
- OAuth tokens can be encrypted before being stored in SQLite.
- OAuth authorization uses state validation and PKCE.
- Account exports are sanitized by default.
- Secrets are redacted from health and administrative output.
- User-controlled traversal paths are rejected during asset writes.
- Electron renderer code does not receive unrestricted Node.js APIs.
- External browser navigation is handled through a restricted preload bridge.
- Provider failover is designed for resilience, not rate-limit bypass or ban avoidance.

> **Security note:** Do not expose the local gateway to the public internet without implementing an appropriate network and authentication boundary.

---

## 🔑 Google OAuth

Own Antigravity supports adding CloudCode accounts through a local Google OAuth authorization-code flow.

```text
Desktop / Browser
       │
       ▼
Google Authorization
       │
       ▼
OAuth Callback
       │
       ▼
State + PKCE Validation
       │
       ▼
Encrypted SQLite Registry
       │
       ▼
Runtime Account Pool
```

The OAuth flow supports:

- Google authorization
- PKCE
- State validation
- Token refresh
- Encrypted token storage
- Account health tracking

Configure your own OAuth client before enabling this functionality.

Example:

```env
OWN_AG_GOOGLE_OAUTH_ENABLED=true
OWN_AG_GOOGLE_CLIENT_ID=<your-client-id>
OWN_AG_GOOGLE_CLIENT_SECRET=<your-client-secret>
OWN_AG_GOOGLE_REDIRECT_URI=http://127.0.0.1:8046/auth/google/callback
OWN_AG_GOOGLE_SCOPES=openid,email,profile,https://www.googleapis.com/auth/cloud-platform
OWN_AG_TOKEN_ENCRYPTION_KEY=<long-random-local-secret>
```

---

## 🖥️ Desktop Application

The Electron desktop application provides a graphical interface over the local REST gateway.

### Features

- Google OAuth login
- Manual refresh-token import
- JSON account import
- Account switching
- Encrypted account export
- Provider/account health
- Gateway diagnostics
- Dark/light mode
- Turkish/English interface
- Error and status panels

The desktop application does **not** read browser cookies, WebView storage, or sessions belonging to other applications.

Run the desktop manager with:

```bash
npm run desktop
```

Development mode:

```bash
npm run desktop:dev
```

---

## ⚙️ Native Local Runtime

Own Antigravity can optionally integrate with a locally available `ls_core` runtime.

Supported transport abstractions include:

- `stdio`
- HTTP
- WebSocket
- gRPC scaffold

The runtime manager provides:

- Local binary discovery
- Process spawning
- Process reuse
- TTL cleanup
- LRU reclamation
- Handshake validation
- Request diagnostics
- Streaming support detection
- Protocol normalization

Native runtime support is deliberately conservative and requires user-provided local runtime assets and explicit configuration.

The project does not attempt to reverse-engineer private protocols.

---

## 📊 Monitoring & Diagnostics

The local dashboard provides sanitized runtime information including:

- Provider status
- Account counts
- Healthy/unhealthy credentials
- Active account
- Request count
- Error count
- Last error
- Uptime
- Model aliases
- Native runtime instances
- Provisioning status
- Recent sanitized errors

### Useful endpoints

```text
GET  /health
GET  /health/providers
GET  /health/accounts
GET  /metrics
GET  /admin/status
GET  /admin/metrics
GET  /v1/models
GET  /v1/events

POST /v1/messages
POST /v1/chat/completions
POST /v1/responses
POST /v1beta/models/:model:generateContent
POST /v1beta/models/:model:streamGenerateContent
```

---

## 🤖 Multi-Agent Automation

Own Antigravity includes a structured automation runner that can execute task plans through installed Claude and Gemini CLIs.

A plan can define:

```text
Goal
 └── Phase
      ├── Task → Claude
      ├── Task → Gemini
      └── Follow-up / Recovery
```

The automation runner can:

1. Start the local gateway when required.
2. Execute tasks through configured AI CLI providers.
3. Retry failed tasks.
4. Switch between proxy and direct modes.
5. Retry using a fallback model.
6. Switch to an alternate provider.
7. Persist unresolved recovery items.
8. Generate machine-readable execution reports.

Execution artifacts are stored under:

```text
.own-ag-runs/<timestamp>/
```

---

## 🚀 Getting Started

### Requirements

- Node.js
- npm

Optional:

- Google OAuth client
- Gemini API key
- Anthropic API key
- Local `ls_core` runtime
- Claude CLI
- Gemini CLI

### Installation

```bash
npm install
```

Create the environment file:

```powershell
Copy-Item .env.example .env
```

Configure the gateway:

```env
OWN_AG_PORT=8046
OWN_AG_HOST=127.0.0.1
OWN_AG_API_KEY=change-me

OWN_AG_GEMINI_API_KEY=
OWN_AG_ANTHROPIC_API_KEY=
```

Start the development server:

```bash
npm run dev
```

Open the dashboard:

```text
http://127.0.0.1:8046/
```

---

## 🧪 Development

Run tests:

```bash
npm test
```

Build the project:

```bash
npm run build
```

Run diagnostics:

```bash
npm run doctor
npm run accounts
npm run diagnose:ls
```

---

## 📦 Windows Packaging

Electron Builder is used for Windows packaging.

```bash
npm run desktop:pack
npm run desktop:dist
```

The project supports:

- Portable Windows builds
- NSIS installer builds

Windows packages are currently unsigned unless code signing is configured.

---

## 📁 Project Structure

```text
own-antigravity/
├── src/
│   ├── accounts/
│   ├── cloudCode/
│   ├── ls/
│   ├── providers/
│   ├── transcoder/
│   ├── assets/
│   ├── server.ts
│   ├── runtime.ts
│   ├── config.ts
│   ├── dashboard.ts
│   └── keyPool.ts
│
├── desktop/
├── scripts/
├── examples/
├── tests/
├── .env.example
├── package.json
├── tsconfig.json
└── LICENSE
```

---

## 🧪 Example: OpenAI-Compatible Client

Once the gateway is running, an OpenAI-compatible client can target the local endpoint.

```text
Base URL:
http://127.0.0.1:8046/v1
```

For example, a client can send requests to:

```text
POST /v1/chat/completions
```

while Own Antigravity handles provider selection, authentication, health tracking and protocol normalization behind the gateway.

---

## 📈 Design Goals

The project focuses on several practical infrastructure problems:

- **Provider abstraction** — integrate multiple AI providers behind a common interface.
- **Fault tolerance** — detect unhealthy credentials and recover through controlled failover.
- **Protocol interoperability** — normalize different request/response formats.
- **Credential lifecycle management** — securely manage local AI accounts and tokens.
- **Local-first architecture** — keep the gateway and sensitive account state on the user's machine.
- **Observability** — expose useful health and runtime information without leaking secrets.
- **Extensibility** — make new providers, protocols and runtime integrations easier to add.
- **Automation** — coordinate multiple AI CLI tools through structured execution plans.

---

## 🗺️ Roadmap

- [ ] Expand provider adapter system
- [ ] Increase automated integration-test coverage
- [ ] Improve provider health strategies
- [ ] Improve runtime diagnostics
- [ ] Add richer dashboard visualizations
- [ ] Improve desktop account-management UX
- [ ] Expand automation strategies
- [ ] Improve release automation
- [ ] Add signed desktop releases

---

## ⚠️ Known Limitations

- Account quota may be shown as `unknown` when metadata is unavailable.
- Native local runtime support depends on user-provided local assets.
- Native protocol inference/reverse engineering is intentionally out of scope.
- Windows installers are currently unsigned.
- Provider failover is designed for resilience rather than rate-limit bypass.
- The desktop UI stores the local admin key in renderer local storage for convenience and should not be considered a secure credential vault.
- Native `ls_core` functionality depends on the local runtime and its configured protocol.

---

## 📜 License & Original Implementation

This project is licensed under the MIT License.

**Own Antigravity is an independent implementation.**

It does not vendor or copy implementation code from Antigravity Manager forks. External repositories were treated only as behavioral references where appropriate.

Native local runtime integration is based on user-provided local assets and explicitly configured protocol contracts.

---

## 👨‍💻 Author

Built by **Mstfsak07**.

If you find the project interesting, feel free to explore the source code and architecture.
