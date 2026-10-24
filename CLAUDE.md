# CLAUDE.md - InstantCognition Development Guide

**For Claude Code, Gemini CLI, and Other AI Coding Assistants**

---

## 📦 PROJECT: InstantCognition

**InstantCognition** is a cross-platform Electron desktop application that provides instant access to AI LLMs and web searches via a global hotkey (Ctrl/Cmd+Space).

### Tech Stack
- **Framework**: Electron 44 (see `package.json`)
- **Language**: JavaScript (with TypeScript type checking)
- **Build**: electron-builder, electron-packager
- **Testing**: Jest
- **Linting**: ESLint (flat config; no separate formatter pass)
- **Key Libraries**: @ghostery/adblocker-electron, winston (logging), marked + dompurify + highlight.js (markdown), mermaid (artifact diagrams), picomatch (permission/path globs), yaml (SKILL.md frontmatter), diff (approval diffs)

### Project Architecture

```
InstantCognition/
├── main.js                    # Entry point - platform detection & app launch
├── index.html                 # Main application window
├── launcher.html              # Quick-launcher window (renderer/launcher/)
├── preload.js                 # Preload script (re-exports main/preload.js)
│
├── main/                      # Main process (Electron backend)
│   ├── index.js              # Bootstrap, window creation, lifecycle
│   ├── App.js                # Service orchestrator — initializes services + IPC
│   ├── preload.js            # Webview preload script (gestures, keyboard)
│   ├── preload/annotate.js   # Webview element picker for annotation mode
│   ├── ipc/                  # Domain-split IPC handler modules
│   │   ├── index.js          # registerAll(mainWindow, services)
│   │   └── assistantHandlers.js # Assistant IPC group (sessions, runs, permissions,
│   │                         #   checkpoints, artifacts, skills, inbox, recorder,
│   │                         #   launcher, workspace search) + session-layer attach
│   ├── services/             # Singleton services, grouped roughly by area:
│   │   #  Core: ConfigService, MenuService, TrayService, ShortcutService,
│   │   #        MemoryService, CertificateService, SessionService
│   │   #  Web:  AdblockerService, ExtensionService, BookmarkService,
│   │   #        HistoryService, DownloadService, NotificationService,
│   │   #        BadgeService, PermissionService, PermissionPromptService
│   │   #  LLM:  LLMService, LLMClientService, EngineDiscoveryService,
│   │   #        ModelManagerService, ModelHubService, modelRegistry
│   │   #  Agent: AgentService, AgentRuntime (../agent/), AgentHistoryService,
│   │   #         AgentApprovalService, AgentTabOpsService, QualityModeService,
│   │   #         SkillsService, ScreenshotService, CdpSessionManager,
│   │   #         HttpAllowlistService, tabRegistry, InboxService, RoutineService
│   ├── agent/                # Agent runtime + tools (browser, fs, shell, plan,
│   │   │                     #   subagent, skill, artifact)
│   │   ├── sessions/         # sessionStore (jsonl message tree), sessionManager,
│   │   │                     #   runTurn, SessionRun, llmGate, contextProjection
│   │   ├── permissions/      # toolCatalog, ruleMatch, permissionEngine
│   │   ├── workspace/        # pathGuard, agentSettings, instructions (AGENTS.md)
│   │   ├── checkpoints/      # per-turn file snapshots + rewind
│   │   ├── artifacts/        # versioned per-session artifacts
│   │   ├── skills/           # SKILL.md format, matcher, install, draft
│   │   ├── recorder/         # CDP record & replay -> skill
│   │   └── harness/          # per-model tool-format/streaming profiles
│   ├── launcher/             # Quick-launcher window + global hotkey
│   └── utils/                # logger, errorHandler, recovery
│
├── renderer/                  # Renderer process (UI)
│   ├── renderer.js           # Bootstrap, config load, manager wiring
│   ├── core/AppState.js      # Observable state container (EventEmitter)
│   ├── core/ShellStore.js    # Assistant/browser shell state (mode, sidebar, dock)
│   ├── ipc/ipcBridge.js      # Centralized renderer IPC delegation
│   ├── managers/             # SpaceManager, NavigationManager, LayoutManager,
│   │                         #   FindBarManager, BrowserViewManager,
│   │                         #   AgentWorkspaceManager, ViewShellManager
│   ├── layouts/              # LayoutStrategy + Single/SideBySide/Grid/Stacked/TwoRow
│   ├── components/           # ChromeBar, TabBar, TabBarActions, TabChromeStrip, AgentPanel,
│   │   │                     #   CommandPalette, NewTabPicker, LibraryWindow, ReaderView,
│   │   │                     #   PermissionPrompt, PromptDialog, SiteBlockedPrompt,
│   │   │                     #   ConfirmDialog, Toast, Tooltip, Icon, VoiceInputButton,
│   │   │                     #   VoiceCaptureOverlay, WelcomeOverlay
│   │   ├── agent/            # AnswerView, ToolStream, HistoryRail, ReattachPrompt
│   │   ├── assistant/        # AgentPanel internals: AssistantShell, AssistantController,
│   │   │                     #   lanes/, ChatThread, MessageView, Composer, InlinePalette,
│   │   │                     #   ApprovalCard, PlanPanel, ArtifactsPane, SessionList,
│   │   │                     #   SessionsDashboard, InboxPane, BrowserDock, RecordBar, …
│   │   └── settings/         # SettingsView, LLMTab, PermissionsTab, modules/ (appearance, mcpServers, …)
│   ├── launcher/             # LauncherView for launcher.html
│   ├── utils/                # rendererErrorHandler, shortcuts, markdown, focusTrap, etc.
│   └── styles/               # components/* + themes/{light,dark}
│
├── shared/                    # Shared modules (main + renderer)
│   ├── configDefaults.js, configPaths.js
│   └── llmDefaults.js        # LLM defaults, mergeStartOpts, persistEngineSelection
│
├── scripts/                   # build-css.js, build-renderer.js, fetch-* asset downloaders, smoke-llm-engines.js
├── tests/                     # unit/{main,renderer,shared}, integration, e2e
├── assets/                    # app icons (icon.icns/.ico/.png) + ai-logos/
└── Build Config: package.json (inline electron-builder), tsconfig.json,
                  jest.config.js (multi-project), eslint.config.js (flat config)
```

Note: file/line counts intentionally omitted — they rot. When in doubt, run `find … | wc -l` or read the directory.

### Key Files to Understand

**Entry Point Flow:**
1. `main.js` - Detects platform, sets up single-instance lock, launches main process
2. `main/index.js` - Bootstrap: creates window, initializes App orchestrator
3. `main/App.js` - Initializes all services, registers IPC handlers via `main/ipc/`
4. `index.html` - Loads renderer process
5. `renderer/renderer.js` - Loads config, creates AppState + managers, wires IPC bridge

**Core Concepts:**
- **Spaces**: Predefined ("cognitizer") and ad-hoc web pages, navigated via the tab bar. The legacy term "Cognitizer" still appears in some labels.
- **Tabs (multi-mode)**: In multi-mode, multiple spaces are *shown* simultaneously (a set, not one selection). `openTabs` is the ordered list; `hiddenTabs` is the subset hidden in multi-mode; `currentSpaceId` is the keyboard-focused tab; clicking a tab toggles show/hide in multi-mode and switches in single-mode.
- **Browser View**: Separate view for CTRL+Click links.
- **Global Hotkey**: CTRL/CMD+Space to show/hide app window (Alt+Space on macOS).
- **AppState**: Observable state container — managers subscribe to state changes instead of globals.
- **Services**: Main process singletons (config, adblock, sessions, LLM/engine, agent runtime, downloads/history/bookmarks, notifications, permissions, etc).
- **Managers**: Renderer process controllers (Space, Navigation, Layout, FindBar, BrowserView).
- **Local LLM**: `LLMService` orchestrates spawning a local inference server: `llama-server` (all platforms), `mlx-openai-server` or oMLX (Apple silicon), or vLLM (NVIDIA on Linux, or Windows via the app's WSL2 distro); `EngineDiscoveryService` probes for installations + caches resolved paths in config. Per-backend launch/health/stop differences live in `main/services/llm/backendRuntime.js`; updater adapters in `main/services/llm/engines/`; guided vLLM setup in `main/services/llm/vllmSetup.js`.
- **Agent runtime**: `main/agent/AgentRuntime` runs a tool-calling loop over the active webview using primitives in `main/agent/tools/`; UI in `renderer/components/AgentPanel.js` (a facade over `renderer/components/assistant/`), opened via Cmd+Shift+A.
- **Assistant vs browser mode**: `ViewShellManager` flips the whole window between assistant mode (history rail | chat thread | browser dock) and browser mode (layouts + docked assistant sidebar) on Cmd/Ctrl+E. The dock is the existing `#tab-bar-wrap` restyled in place: never reparent a `<webview>` or artifact iframe (the guest reloads), and a collapsed dock is moved off-screen with `inert`, never `display:none`.
- **Sessions**: every chat/agent conversation is a branching message tree persisted under `{userData}/sessions/<id>/` (`main/agent/sessions/sessionStore.js`). `sessionManager` runs background sessions concurrently behind `llmGate`; background runs report through `session:event` and the inbox, never the foreground `agent:*` channels.
- **Permissions**: `main/agent/permissions/permissionEngine.js` decides every tool call. Deny rules beat Bypass; unknown and `mcp.*` tools ask. Modes are Ask / Auto-edit / Plan / Bypass per session. File and shell tools are confined to user-added workspace roots by `workspace/pathGuard.js`; `shell.run` takes an argv array (no shell) and is not a sandbox.
- **Shell isolation**: the main and launcher windows run with `contextIsolation`, `sandbox` and no Node behind a strict CSP (`script-src 'self'`). Renderer code reaches main only through `main/preload/shell.js` (`window.icShell`); `require('electron')` in renderer code resolves to `renderer/ipc/electronShim.js` at bundle time, and any Node builtin import fails `scripts/build-renderer.js`. Clipboard and OS-shell calls go through `main/ipc/shellHandlers.js`.
- **IPC sender policy**: `main/utils/ipcSenderPolicy.js` wraps `ipcMain` before any handler registers. Only a window passed to `trustShell` (main, launcher, recovery), from its top frame on a `file:` page, may use any channel. Every other sender (a tab, a pop-up, an artifact frame) gets only `GUEST_CHANNELS`. A new channel that a guest preload sends must be added there, or main refuses it and logs `[ipc] refused`.
- **Private tabs**: agents never touch them. `tabRegistry` tags them `private` and every `forSession` view hides them. `ScreenshotService` refuses to capture them, and a run started or reattached on one fails with "The agent doesn't run in private tabs". A new private tab loads only after `session:private-ready` confirms the last private session is wiped.
- **Checkpoints / artifacts / skills**: fs mutations are snapshotted per turn for rewind (shell side-effects are not); artifacts render in a `sandbox="allow-scripts"` iframe loading a document staged in main and served over `ic-artifact://frame/<token>` with a CSP header and a CSP meta first (never `allow-same-origin`, never srcdoc: it would inherit the shell CSP); skills are `SKILL.md` directories under `{userData}/skills/`, and `allowed-tools` only narrows the tool list, never grants permission.

### Development Commands

```bash
# Run app in development
npm start

# Run tests
npm test                  # Full suite: 7523 tests across 363 suites (measured 2026-10-23)
npx jest                 # Same as npm test
npm run test:coverage    # With coverage

# Code quality
npm run lint             # Check for issues
npm run lint:fix         # Auto-fix issues
npm run typecheck        # TypeScript checking
npm run fix              # eslint --fix

# Build
npm run build:install             # Auto-detect OS and build
npm run package-win-x64            # Windows x64
npm run package-mac-arm            # macOS ARM
npm run build-win                  # Windows installer (electron-builder)

# Verify everything
npm run verify           # typecheck + lint + full test suite
```

### Important Notes for AI Assistants

1. **Main Process**: Modularized — `main/index.js` handles bootstrap, `main/App.js` orchestrates services, `main/ipc/` contains domain-split IPC handlers, `main/services/` contains service singletons. Architecture-integrity tests cap line counts per layer (services 300, ipc 100, managers 700, layouts 100), enforced in `tests/integration/architecture-integrity*.test.js`.

2. **Renderer Process**: Modularized — `renderer/renderer.js` handles bootstrap/config, delegates to managers in `renderer/managers/`, layout strategies in `renderer/layouts/`, and centralized IPC in `renderer/ipc/ipcBridge.js`.

3. **Testing**: `npm test` and `npx jest` run the same full suite (7523 tests, 363 suites — measured 2026-10-23). Jest uses multi-project config: `node` env for main/shared/integration/e2e, `jsdom` for renderer. The Electron launch smoke (`npm run test:e2e:app`) and the LLM engine jest smoke (`npm run test:e2e:llm`) set `RUN_APP_SMOKE=1` / `RUN_LLM_SMOKE=1` themselves and skip without them; `npm run test:smoke` runs `scripts/smoke-llm-engines.js` directly and skips engines absent on the host.

4. **Configuration**: User settings in `config.json` (gitignored). Defaults + migrations in `shared/configDefaults.js`. Platform-specific paths in `shared/configPaths.js`. LLM-specific defaults + `mergeStartOpts` / `persistEngineSelection` in `shared/llmDefaults.js`.

5. **Platform-Specific Code**: Windows requires GPU disabled. macOS/Linux don't. See `main.js` for platform detection.

6. **IPC Architecture**: IPC handlers are domain-split in `main/ipc/`. Each exports a `register(mainWindow, services)` function. All registered via `main/ipc/index.js:registerAll()`. The renderer communicates via `renderer/ipc/ipcBridge.js`.

7. **Root-Level Wrappers**: `renderer.js` (root) requires `renderer/renderer.js` and is the entry `scripts/build-renderer.js` bundles into `renderer.bundle.js` (plus `launcher.bundle.js`; both gitignored, rebuilt by every start/build script). `preload.js` (root) re-exports `main/preload.js`, the webview guest preload. These exist for Electron's build/packaging. `updater.js` holds the GitHub Releases update check reached from Settings.

8. **Dependencies**: Production deps are minimal — see `package.json`. ESLint uses flat config format (no plugins imported).

---

## 🎯 CRITICAL: Autonomous Development Instructions

**These instructions apply to both Claude Code and Gemini CLI. When this document says "you", it means whichever AI assistant is currently working on the project.**

### Core Directive: Complete Every Task Fully

**You are an autonomous developer. Your prime directive is to COMPLETE tasks, not just attempt them. You build loops, retry strategies, and alternative approaches until success is achieved.**

### 🛠️ Custom MCP Tools for This Project

**This section is for documenting PROJECT-SPECIFIC MCP tools you develop, not standard MCP tools that Claude/Gemini already know about.**

**Fill in this table as you develop custom tools:**

| Tool Name | Purpose | Key Functions | Location |
|-----------|---------|---------------|----------|
| *(empty - add your custom tools here)* | | | |

**MCP tool locations — `mcp-tools/` is a convention that has NOT been created; no such directory exists in this repo.** The in-tree MCP code today:
- `main/services/McpService.js` - MCP service (main process)
- `main/ipc/mcpHandlers.js` - MCP IPC handlers
- `main/agent/tools/mcpTools.js` - MCP tools exposed to the agent runtime
- `renderer/components/settings/modules/mcpServers.js` - MCP servers settings UI

### 🛑 Planning & Review Protocol

**Before making significant changes, present your plan for human review:**

**Major changes requiring review:**
- Installing new dependencies
- Deleting files (except temp files)
- Major refactoring (>50 lines)
- Changing core architecture
- Modifying configuration files
- Database schema changes
- API contract changes

**Minor changes (proceed automatically):**
- Fixing syntax errors
- Updating imports
- Formatting code
- Fixing simple test failures
- Adding error handling
- Updating documentation
- Cleaning temporary files

### 🔄 The Relentless Loop Pattern

**This is how YOU (Claude Code or Gemini CLI) should approach every task:**

```
WHILE task_not_complete:
    TRY:
        analyze_current_state()
        plan = generate_solution_plan()

        # Review checkpoint for major changes
        IF plan.requires_major_changes:
            approval = present_plan_for_review(plan)
            IF approval == "MODIFY":
                plan = generate_alternative_plan()
            ELIF approval == "SKIP":
                try_different_approach()
                CONTINUE

        execute_plan(plan)
        verify_solution()

        IF issues_found:
            analyze_failure()
            IF multiple_failures_on_same_issue:
                present_failure_analysis()
                get_guidance()
            generate_new_approach()
            CONTINUE
        ELSE:
            run_comprehensive_tests()
            IF tests_fail:
                fix_tests_or_implementation()
                CONTINUE
    CATCH error:
        diagnose_root_cause()
        IF fix_requires_major_change:
            present_fix_plan_for_review()
        implement_fix()
        CONTINUE

    IF stuck_count > 3:
        present_stuck_analysis()
        wait_for_human_guidance()
        try_radically_different_approach()
        reset_stuck_count()
```

### 🚨 Never Stop at First Error (But Do Ask Before Major Changes)

**WRONG APPROACH:**
```
"I encountered an error with the tests. The issue seems to be..."
[Stops and waits for human]
```

**ALSO WRONG:**
```
"I need to install 5 new packages and refactor the entire codebase."
[Proceeds without asking]
```

**CORRECT APPROACH:**
```
"I encountered an error with the tests. Let me analyze and fix this..."
[Attempts fix]
"The issue is a missing dependency. This is a minor fix - installing it now..."
[Auto-fixes minor issue]
"Now I'm seeing a larger architectural issue. Here's my plan:

🤖 PLANNED ACTION:
Issue: The current structure doesn't support the new feature
Solution: Refactor to add new module and update imports
Changes:
  - Create new module directory
  - Move related functions to new module
  - Update 5 import statements

This is a significant change affecting 5 files.
[A]pply, [M]odify approach, [S]kip?"

[Waits for human decision before proceeding with major changes]
```

### 📋 Task Completion Checklist

Before considering ANY task complete, ensure:

- [ ] Code runs without errors
- [ ] All tests pass (or are fixed/updated if outdated)
- [ ] Linting passes (after auto-fixing what's possible)
- [ ] Type checking passes (if applicable)
- [ ] Documentation is updated
- [ ] Edge cases are handled
- [ ] Error handling is comprehensive
- [ ] **No temporary files left behind** (deleted or gitignored)
- [ ] **No duplicate versions of files** (file_v2.js, etc.)
- [ ] **Workspace is clean and organized**

### 💪 Building Resilient Solutions

Every solution should:

1. **Self-Test**: Include verification steps
2. **Self-Heal**: Attempt to fix issues automatically
3. **Self-Document**: Update docs as code changes
4. **Self-Improve**: Refactor when patterns emerge

### 📁 File Management Discipline

**CRITICAL: Maintain a clean workspace**

**❌ NEVER DO THIS:**
```
# Creating multiple versions
main.js
main_v2.js
main_updated.js
main_backup.js
test_temp.js
test_experiment.js
```

**✅ ALWAYS DO THIS:**
```javascript
// In main.js - use conditional paths instead
function main() {
    if (process.env.USE_EXPERIMENTAL) {
        return experimentalImplementation();
    } else {
        return stableImplementation();
    }
}
```

**Temporary File Rules:**
1. **Delete after use**: Any test files created for debugging should be deleted when done
2. **Use .gitignore**: If temp files must persist, immediately add patterns to .gitignore
3. **Never version files**: NEVER create file_v2.js, file_new.js, file_backup.js
4. **Modify in place**: Always edit the original file
5. **Clean workspace**: Before completing any task, ensure no unnecessary files remain

---

## Summary

This system transforms development by:

- **Eliminating Setup Friction**: Everything auto-configures
- **Ensuring Quality**: Continuous checking and fixing loops
- **Maximizing AI Effectiveness**: Clear patterns for autonomous operation
- **Standardizing Without Restricting**: Consistent interface, flexible implementation
- **Learning and Improving**: Gets better with every use

The key is that AI assistants (Claude Code and Gemini CLI) using this system should act as **autonomous developers** who don't stop at the first error but continue iterating until the task is completely successful, while respecting human oversight for major changes.
