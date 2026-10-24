# Contributing to InstantCognition

Thanks for taking the time. This document covers what you need to know to get a
change merged.

## Getting set up

Node.js 22.22.2 or newer.

```bash
git clone https://github.com/daemon-summoner/InstantCognition.git
cd InstantCognition
npm ci
npm start
```

`npm ci` installs exactly what `package-lock.json` pins, which is what CI runs.
Use `npm install` only when you are deliberately changing a dependency — it
rewrites the lockfile.

## Before you open a pull request

```bash
npm run verify   # typecheck + lint + the full Jest suite
```

All three must be clean. `npm run fix` applies the auto-fixable lint changes.
ESLint is the only style authority — there is no separate formatter pass, so
match the surrounding code rather than reformatting a file you touch.

Larger changes also want:

```bash
npm run test:coverage    # per-directory coverage floors must hold
npm run test:e2e:app     # Playwright smoke against a real Electron launch
```

## What the project expects from a change

**Tests.** New behaviour comes with tests that would fail without the change.
Mock only real external boundaries — Electron, the filesystem, the network, a
model server. Mocking the code under test produces a test that cannot fail.

**Types.** The codebase is JavaScript type-checked by TypeScript through JSDoc
(`checkJs` with `strict`). `npm run typecheck` must report zero errors. Add
annotations rather than `// @ts-ignore`.

**Errors stay visible.** No empty catch blocks, no `catch { return null }`
hiding a failure. If an operation can fail in a way the user should know about,
surface it — a toast, a hint line, a rejected promise.

**Match the surrounding code.** Naming, imports, error handling and module
layout follow whatever the file already does.

**Architecture boundaries.** `tests/integration/architecture-integrity.test.js`
caps file sizes per layer (services 300 lines, IPC handlers 100, renderer
managers 700, layouts 100). A file that outgrows its cap gets split, not
compressed.

**Where code goes.**
- Main-process state and side effects → `main/services/`
- Anything the renderer invokes → a `main/ipc/` module registered in `main/ipc/index.js`
- Renderer state → `renderer/core/AppState.js`, never a global
- Renderer → main calls → `renderer/ipc/ipcBridge.js`
- Styling → design tokens in `renderer/styles/`, not hardcoded colors (both themes must work)

## Commits and pull requests

Write the commit subject as a short, plain summary of what changed. No prefix is required.

A pull request should say what changed and why, link the issue it closes, and
note the platforms you tested on. The template will prompt for the rest.

## Reporting bugs

Open an issue with your OS and app version, what you expected, what happened,
and the steps to reproduce it. Logs live in the `logs/` folder under your user
data directory — Recovery Mode's *View Logs* button opens it directly.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
