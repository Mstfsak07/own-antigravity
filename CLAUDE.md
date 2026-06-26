# Own Antigravity Agent Brief

Keep token use low. This file is the project briefing; do not read the whole `README.md` unless the task is documentation-related.

## Project

Own Antigravity is a local TypeScript gateway/proxy for Gemini, Anthropic-compatible clients, OpenAI-compatible chat calls, CloudCode accounts, and a desktop dashboard.

## Code Map

- `src/cli.ts`: CLI entrypoint and commands.
- `src/server.ts`: HTTP server wiring.
- `src/providers/*`: provider adapters and streaming.
- `src/cloudCode/*`: CloudCode account discovery, OAuth refresh, quota, mapping, and streaming.
- `src/ls/*`: local language-server bridge, protocols, transports, diagnostics, and token server.
- `src/auth/*`: Google OAuth login and account management.
- `src/desktopGateway.ts` and `src/dashboard.ts`: desktop/dashboard UI surfaces.
- `src/tokenPolicy.ts`, `src/metrics.ts`, `src/runtime.ts`, `src/config.ts`: shared runtime behavior.
- `desktop/main.cjs`: Electron shell.
- `scripts/*`: maintenance and release scripts.

## Commands

- Install: `npm install`
- Test all: `npm test`
- Focused test: `npx vitest run src/path/file.test.ts`
- Typecheck: `npm run typecheck`
- Build: `npm run build`
- Dev server: `npm run dev`

## Token Rules

- First use `rg` to find the exact symbol, route, env var, or error.
- Read only relevant file sections after search results.
- Do not read `node_modules/**`, `dist/**`, `release*/**`, `coverage/**`, `package-lock.json`, logs, tmp files, or `.git/**`.
- Do not read historical debug files such as `tmp-claude-debug.log`, `tmp-claude-tool-debug.log`, `tmp-live-*`, or `.tmp-*` unless the user names one.
- Avoid reading `references/**`; those are external reference projects, not active source.
- Prefer focused tests over full test runs while iterating.

## Dirty Tree

The working tree may contain user changes. Do not revert, overwrite, or normalize unrelated files. Before editing an already modified file, inspect the relevant section and preserve unrelated changes.

