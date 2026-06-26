# Project Brief

Own Antigravity is a local TypeScript gateway/proxy for Gemini, Anthropic-compatible clients, OpenAI-compatible chat calls, CloudCode accounts, and a desktop dashboard.

Use this brief instead of reading the full README for routine coding tasks.

Main areas:

- `src/providers/*`: provider adapters.
- `src/cloudCode/*`: CloudCode accounts, OAuth refresh, quota, request mapping, and streaming.
- `src/ls/*`: local language-server bridge, protocols, transports, diagnostics, and token server.
- `src/server.ts` and `src/cli.ts`: server and CLI entrypoints.
- `src/dashboard.ts`, `src/desktopGateway.ts`, and `desktop/main.cjs`: dashboard and Electron surfaces.

Validation:

- Focused test: `npx vitest run src/path/file.test.ts`
- Full test: `npm test`
- Typecheck: `npm run typecheck`
- Build: `npm run build`

Context rule: search with `rg` first, read only matching source sections, and avoid generated output, logs, dependencies, reference repos, and history files.

