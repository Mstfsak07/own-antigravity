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
