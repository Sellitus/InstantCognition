# Changelog

All notable changes to InstantCognition will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Agent conversations can be continued after a run ends — resume a finished conversation instead of starting over (`70d084a`)
- A rebuilt assistant surface: named sessions with a dashboard, conversation rewind and branching, an artifacts pane, a plan panel, and a live context meter (`a6ec7f6`)
- An Update pill on the tab bar that restarts into a downloaded app update, or opens its release page when the update must be installed manually (`fa406ce`)
- Ambient visual effects across the interface — animated transitions, spotlights and starfields that respond to navigation and answers (`3d0b834`)

### Changed

- Full visual overhaul of the tab bar, menus, settings, library window and agent panel (`6e44363`)
- The Remote card's Activate row and the "Use remote" toast now say what happens with a local model loaded: it keeps serving until you stop it, and the remote takes over then (`423eb26`)
- The bundled Electron runtime was updated to 44.9.0 (`3d0b834`, `a6ec7f6`)
- Release notes state the exact Electron version each build shipped with (`d06bcdb`)

### Fixed

- Closing the focused tab works reliably again when the browser view's tab tracking went stale (`bce2d6f`)
- The URL entry is visible again in the new-tab picker (`bce2d6f`)
- A saved remote endpoint is restored on restart only when remote was explicitly chosen, so clearing the remote never silently reactivates a paid API (`a073aca`)
- Final answers from reasoning models stop cutting off mid-answer when thinking used up the token budget — the answer step retries with room to finish (`a073aca`)
- Local-runtime update prompts fire once per version, only for the engine actually in use, and never while a remote endpoint is active; a freshly installed runtime is put into use without re-selecting it (`fa406ce`)

## [4.0.0] - 2026-09-06

First open-source release. Versions 2.x and 3.x were internal; this entry covers
everything between 1.6.2 and 4.0.0.

### Added

**Local inference**

- Local model serving through llama.cpp (`llama-server`) and MLX on Apple silicon
- A prebuilt `llama-server` binary bundled per platform, with a relocatable Python runtime for MLX
- Engine discovery that probes for existing installations and caches resolved paths
- Model Hub: Hugging Face search, GGUF/MLX downloads and on-disk model management
- Any OpenAI-compatible endpoint usable as a remote backend, with streaming and JSON-mode helpers
- Quality modes that trade latency against answer depth

**Assistant**

- A single chat surface over the active model (`Cmd/Ctrl+Shift+A`)
- Page copilot: questions answered against the page currently in view
- Ask All Spaces (`Cmd/Ctrl+Shift+B`) broadcasts one prompt to every open assistant and compares the replies
- Personas with import/export, saved skills, and a user-memory layer that carries context between sessions
- Projects: file and image uploads, `@`-mention autocomplete in the composer, drag-and-drop and paste, always-in-context and on-demand file tools
- Token-budget compaction so long conversations stay inside the model's context window

**Agent**

- A tool-calling runtime that observes, plans and acts on the live page
- Tools for navigation, clicking, typing, page reading, tab management, screenshots, web search, history and MCP servers
- An approval gate on risky actions, with a domain allow/block list and an HTTP allowlist for outbound requests
- Research Report mode: opens its sources as live panes and cites them inline
- Scheduled routines that re-run a saved task on an interval or a daily schedule, in an isolated workspace
- MCP client support over stdio and StreamableHTTP transports

**Browsing**

- History, bookmarks and downloads in one library panel (`Cmd/Ctrl+Shift+Y`)
- Ask-your-browsing: local retrieval over your own history and bookmarks, lexical by default with opt-in embeddings
- Chrome extension support, installable from the Web Store, a `.crx`, a `.zip`, a URL or an unpacked directory
- Permission prompts, private browsing, custom DNS, certificate handling and per-space sessions
- Reader view with local text-to-speech, and voice input via a bundled Moonshine ASR model
- Web search with page reading, usable by both the assistant and the agent

**Updates**

- In-app updates: a background check on startup, a background download, and installation on the next quit, with an immediate-restart action on the toast
- Builds that cannot replace themselves — the Windows portable exe, an unsigned macOS app, a dev run — report the newer version and link its release page instead of failing silently
- Automatic updates are a toggle in Settings → Updates, alongside the existing stable/beta channel and the manual check
- A Windows `Setup.exe` (NSIS) target so Windows installs can self-update; the portable exe still ships
- Inference runtime updates: a daily check for newer llama.cpp and MLX builds, reported on a toast and in Settings → Updates. The download starts only when you press Update; it is checksum-verified, installed under your user data and version-checked before it replaces the bundled runtime, which stays as a fallback

**Interface**

- Command palette (`Cmd/Ctrl+K`) reaching every action by name
- Tab bar with multi-space mode: several spaces visible at once, independent of keyboard focus
- Single, side-by-side, grid, stacked and two-row layouts with resizable splits
- A token-driven design system with working light and dark themes
- First-run welcome overlay covering the core shortcuts and model setup
- Notifications panel, badge counts and a tray menu

### Changed

- Main process split into `main/App.js` (service orchestration), `main/ipc/` (domain-split handlers) and `main/services/` (singletons)
- Renderer split into `renderer/managers/`, `renderer/layouts/` and `renderer/components/`, with `AppState` replacing globals and `ipcBridge` centralizing IPC
- Ten previously hardcoded shortcuts moved into the shortcut registry, so Settings lists and remaps them
- All modal surfaces share one focus trap with visibility filtering and `inert` handling
- Settings rebuilt on a registry-driven tab system with search
- `appId` corrected to reverse-DNS form (`net.sellitus.instantcognition`)
- License changed from GPL-3.0 to MIT
- Release workflow rebuilt on maintained actions, covering macOS arm64/x64, Windows x64/arm64 and Linux x64/arm64 with checksums
- `npm ci` works again — the lockfile had drifted out of sync — and is now what the README, CI and the build script all use
- Build and test entry points standardized on `build_install.sh`, `run.sh`, `verify.sh` and `test.sh`; `setup_env.sh` and `all_pkg_bld_zip.sh` removed
- ESLint is the single style authority; the unused Prettier configuration was removed, and the husky hooks it fronted are now real files
- The self-updating `runUpdater` path and its `pkg`-built binaries were removed; updates now run through electron-updater against the GitHub release feed
- Release builds resolve `electron@latest` and gate it on the Electron launch smoke, so a build ships on the current Electron rather than the lockfile pin (`ELECTRON_PIN=1` opts out)
- Dependabot proposes Electron upgrades weekly, majors included, and groups the rest
- Both macOS architectures build in one electron-builder invocation: two jobs would each write their own `latest-mac.yml` and one would win

### Fixed

- Pasted images were attached to a message twice
- Enter and Tab did not insert the highlighted file in `@`-mention autocomplete
- MCP server connections could outlive teardown through a deferred boot
- Tab bar had `role="tab"` without arrow-key navigation, trapping keyboard users on one tab
- `shared/` was missing from the packaged file list, so every electron-builder artifact died at startup on `Cannot find module '../../shared/configDefaults'`; a packaging-completeness test now guards the whitelist
- Quitting within the first seconds of launch popped a bogus "Failed to load index.html" error dialog, which then blocked the quit — shutdown hung for ~30s and sometimes crashed
- Permission checks logged a warning for every view that had not navigated yet
- Numerous silent failures replaced with visible errors across the renderer

### Security

- `config.json` is no longer packaged into release binaries; it stores API keys in plaintext and a build machine's copy would have shipped inside every public build
- Agent egress constrained by an explicit domain allow/block list
- Extension installs go through a two-phase prepare → permission preview → commit flow

## [1.6.2] - 2025-06-14

### Added

- Comprehensive testing infrastructure with Jest
  - Unit tests for logger and configuration utilities
  - Integration test framework for IPC communication
  - End-to-end test setup with Playwright
  - Performance and memory leak testing capabilities
- TypeScript support with strict type checking
- Developer tooling
  - ESLint v9 configuration for code quality
  - Prettier for code formatting
  - Husky git hooks for automated checks
  - Commitlint for conventional commits
  - EditorConfig for consistent coding styles
- CI/CD workflows with GitHub Actions
  - Automated testing on multiple platforms
  - Dependency update automation
  - Release automation
- New utility modules
  - ConfigManager for centralized configuration handling
  - Enhanced logger with platform-specific paths

### Changed

- Updated Jest to v30.0.0 with latest test runners
- Updated babel-jest to v30.0.0 for consistency
- Updated jest-html-reporter to v4.1.0
- Updated tslib to v2.8.1 for better TypeScript support
- Modified npm test command to run only stable unit tests by default
- Updated build configuration to include main directory structure
- Migrated ESLint configuration to v9 format

### Fixed

- Electron app no longer launches during test execution
- Build process now includes all necessary dependencies
- Test suite runs automatically without manual intervention
- Fixed module resolution issues in test environment

### Security

- Added eslint-plugin-security for security linting
- Configured npm audit in pre-push hooks
- Added security testing workflow in CI/CD

### Developer Experience

- Tests run without opening Electron windows
- Simplified test execution with npm test
- Clear separation between working and experimental tests
- Comprehensive test documentation in tests/README.md
