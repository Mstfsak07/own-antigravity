# Own Antigravity

> A local AI gateway and desktop account manager for Gemini, Anthropic-compatible clients, and OpenAI-compatible APIs.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-Runtime-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Fastify](https://img.shields.io/badge/Fastify-API-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![Electron](https://img.shields.io/badge/Electron-Desktop-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-Storage-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Own Antigravity is a **local-first AI gateway** designed to provide a unified interface for multiple AI providers while handling authentication, account management, provider failover, streaming, metrics, and optional native local integrations.

The project also includes an **Electron desktop manager** for managing local accounts, OAuth authentication, configuration, and gateway status.

---

## ✨ Highlights

- 🔌 **Unified AI API Gateway**
  - OpenAI-compatible `/v1/chat/completions`
  - OpenAI Responses `/v1/responses`
  - Anthropic-compatible `/v1/messages`
  - Gemini-compatible endpoints

- 🧩 **Provider Adapter Architecture**
  - Common interface for different AI providers
  - Streaming and non-streaming requests
  - Shared error classification and metrics

- 🔐 **Local Authentication & Credential Management**
  - Local API authentication
  - Google OAuth with PKCE
  - Encrypted token storage
  - Sanitized account exports
  - Secrets excluded from dashboards and health responses

- 🔄 **Provider & Account Failover**
  - Credential health tracking
  - Failure counters
  - Temporary quarantine of unhealthy credentials
  - Deterministic failover selection

- 🖥️ **Electron Desktop Manager**
  - Account management
  - OAuth login
  - Manual and JSON account import
  - Account switching
  - Dark/light mode
  - TR/EN interface
  - Gateway diagnostics

- ⚙️ **Native Local Runtime Integration**
  - Local `ls_core` process lifecycle management
  - Configurable stdio / HTTP / WebSocket / gRPC transports
  - Handshake and diagnostic support
  - TTL and LRU instance management

- 📊 **Observability**
  - Health endpoints
  - Provider/account status
  - Request and error metrics
  - Runtime diagnostics
  - Server-sent event snapshots

- 🤖 **Multi-Agent Automation**
  - Task plans executed through Claude and Gemini CLIs
  - Retry and recovery strategies
  - Provider fallback
  - Machine-readable execution reports

---

# 🏗️ Architecture

```text
                         ┌─────────────────────────┐
                         │       AI Clients        │
                         │                         │
                         │ Gemini CLI              │
                         │ Claude CLI              │
                         │ OpenAI-compatible apps  │
                         └────────────┬────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────┐
                    │        Own Antigravity          │
                    │                                 │
                    │        Fastify Gateway          │
                    │                                 │
                    │  ┌───────────────────────────┐  │
                    │  │   Provider Adapter Layer  │  │
                    │  └─────────────┬─────────────┘  │
                    │                │                │
                    │       ┌────────┼────────┐       │
                    │       ▼        ▼        ▼       │
                    │    Gemini  Anthropic  OpenAI    │
                    │                                 │
                    │  ┌───────────────────────────┐  │
                    │  │ Account / Key Pool        │  │
                    │  │ Health + Failover          │  │
                    │  └───────────────────────────┘  │
                    │                                 │
                    │  ┌───────────────────────────┐  │
                    │  │ Metrics / Health / Admin  │  │
                    │  └───────────────────────────┘  │
                    └───────────────┬─────────────────┘
                                    │
                    ┌───────────────┼─────────────────┐
                    ▼               ▼                 ▼
               SQLite          CloudCode          Local Runtime
             Account DB        Accounts             ls_core

The architecture is intentionally modular. Provider-specific behavior is isolated behind adapters while authentication, health tracking, metrics, routing, and runtime management remain shared.

🧩 Core Components
Component	Responsibility
src/server.ts	Fastify server, routes, authentication, dashboard and metrics
src/runtime.ts	Shared runtime wiring and model/provider configuration
src/config.ts	Environment and local configuration loading
src/providers/*	Gemini, Anthropic and OpenAI-compatible providers
src/providers/adapter.ts	Common provider abstraction
src/cloudCode/*	Account discovery, OAuth refresh and failover
src/accounts/sqliteRegistry.ts	Local encrypted account registry
src/keyPool.ts	API key health tracking and failover
src/transcoder/*	Cross-provider protocol normalization
src/ls/*	Local runtime process lifecycle management
src/dashboard.ts	Local monitoring dashboard
desktop/*	Electron desktop manager
🔌 Provider Adapter Layer

All providers follow a shared adapter contract:

listModels()
chat()
streamChat()
healthCheck()

This keeps provider-specific implementation details isolated from the gateway.

The gateway also normalizes common provider failures into a shared error taxonomy:

Error	Meaning
auth_error	Authentication or credential failure
rate_limit	Upstream rate limit
network_error	Connection/fetch failure
provider_error	Other upstream provider failure
invalid_config	Missing or invalid configuration
timeout	Request timeout or cancellation
🔐 Security

Own Antigravity is designed for local-first operation.

Security-related design decisions include:

Gateway binds to 127.0.0.1 by default.
Protected routes can require OWN_AG_API_KEY.
Access and refresh tokens are never displayed in the dashboard.
OAuth tokens can be encrypted in SQLite.
OAuth authorization uses state validation and PKCE.
Sanitized account exports are provided by default.
User-controlled traversal paths are rejected during asset writes.
Electron renderer code does not receive Node.js APIs directly.
External browser navigation is restricted through a validated preload bridge.
Provider failover is intended for resilience, not rate-limit bypass or ban avoidance.

Important: This application is intended for local use. Do not expose the gateway to the public internet without understanding and securing the network boundary.

🔑 Google OAuth

Own Antigravity supports adding CloudCode accounts through a local Google OAuth authorization flow.

The flow:

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

Refresh tokens are only persisted when encryption configuration is available.

🖥️ Desktop Application

The Electron application provides a graphical interface over the local REST gateway.

Features include:

Google OAuth login
Manual refresh-token import
JSON account import
Account switching
Encrypted account export
Provider/account health
Gateway diagnostics
Dark/light mode
Turkish/English interface
Error and status panels

The desktop application does not read browser cookies, WebView storage, or sessions belonging to other applications.

⚙️ Native Local Runtime

Own Antigravity can optionally integrate with a locally available ls_core runtime.

Supported transport abstractions include:

stdio
HTTP
WebSocket
gRPC scaffold

The runtime manager provides:

Local binary discovery
Process spawning
Instance reuse
TTL cleanup
LRU reclamation
Handshake validation
Request diagnostics
Streaming support detection
Protocol normalization

Native runtime integration is deliberately conservative and requires the user to provide the local runtime assets/configuration.

The project does not attempt to reverse-engineer private protocols.

📊 Monitoring & Diagnostics

The local dashboard exposes sanitized runtime information such as:

Provider status
Account counts
Healthy/unhealthy credentials
Active account
Request count
Error count
Last error
Uptime
Model aliases
Native runtime instances
Provisioning status
Recent sanitized errors

Useful endpoints include:

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
🤖 Multi-Agent Automation

Own Antigravity includes an automation runner capable of executing structured task plans through installed Claude and Gemini CLIs.

A plan can define:

Goal
 └── Phase
      ├── Task → Claude
      ├── Task → Gemini
      └── Follow-up / Recovery

The automation runner can:

Start the local gateway when required.
Execute tasks through configured AI CLI providers.
Retry failed tasks.
Switch between proxy and direct modes.
Retry with a fallback model.
Switch to an alternate provider.
Persist unresolved recovery items.
Generate machine-readable execution reports.

Execution artifacts are stored under:

.own-ag-runs/<timestamp>/
🚀 Getting Started
Requirements
Node.js
npm
Optional:
Google OAuth client
Gemini API key
Anthropic API key
Local ls_core runtime
Claude CLI
Gemini CLI
Installation
npm install

Create your environment file:

Copy-Item .env.example .env

Configure the required values:

OWN_AG_PORT=8046
OWN_AG_HOST=127.0.0.1
OWN_AG_API_KEY=change-me


OWN_AG_GEMINI_API_KEY=
OWN_AG_ANTHROPIC_API_KEY=

Start the development server:

npm run dev

Open:

http://127.0.0.1:8046/
🧪 Development

Run tests:

npm test

Build the project:

npm run build

Run diagnostics:

npm run doctor
npm run accounts
npm run diagnose:ls

Run the desktop manager:

npm run desktop

Development desktop mode:

npm run desktop:dev
📦 Windows Packaging

Electron Builder is used for Windows packaging:

npm run desktop:pack
npm run desktop:dist

The project can produce:

Portable Windows builds
NSIS installer builds

Unsigned builds can be used when code signing is not configured.

📁 Project Structure
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
└── package.json
🛡️ License & Original Implementation

This project is released under the MIT License.

Own Antigravity is an independent implementation.

It does not vendor or copy implementation code from Antigravity Manager forks. External repositories were used only as behavioral references where necessary.

Native local runtime integration is designed around user-provided local assets and explicitly configured protocol contracts.

⚠️ Known Limitations
Account quota may be shown as unknown when metadata is unavailable.
Native local runtime support depends on user-provided local assets.
Native protocol inference/reverse engineering is intentionally out of scope.
Windows installers are currently unsigned.
Provider failover is designed for resilience rather than rate-limit bypass.
The UI stores the local admin key in renderer local storage for convenience; it should not be considered a secure credential vault.
🗺️ Roadmap
 Improve provider plugin system
 Expand automated integration tests
 Improve runtime diagnostics
 Add richer dashboard visualizations
 Improve desktop account-management UX
 Expand provider health strategies
 Add more configurable automation strategies
 Improve packaging and release automation
 Add signed desktop releases
📌 Why This Project?

Own Antigravity was built to explore the engineering challenges involved in creating a local AI infrastructure layer rather than a single-purpose AI application.

The project focuses on:

API abstraction
Provider interoperability
Authentication
Credential lifecycle management
Fault tolerance
Streaming protocols
Local process orchestration
Desktop application architecture
Observability
Multi-agent automation

The goal is to keep the system modular enough that new providers, protocols, and local runtimes can be integrated without rewriting the gateway core.
