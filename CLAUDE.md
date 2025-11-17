# CLAUDE.md - InstantCognition Development Guide

**For Claude Code, Gemini CLI, and Other AI Coding Assistants**

---

## 📦 PROJECT: InstantCognition

**InstantCognition** is a cross-platform Electron desktop application that provides instant access to AI LLMs and web searches via a global hotkey (Ctrl/Cmd+Space).

### Tech Stack
- **Framework**: Electron 36.4.0
- **Language**: JavaScript (with TypeScript type checking)
- **Build**: electron-builder, electron-packager
- **Testing**: Jest
- **Linting**: ESLint, Prettier
- **Key Libraries**: @cliqz/adblocker-electron, winston (logging)

### Project Architecture

```
InstantCognition/
├── main.js                    # Entry point - platform detection & app launch
├── index.html                 # Main application window
├── preload.js                 # Preload script
│
├── main/                      # Main process (Electron backend)
│   ├── index.js              # Core main process logic (1,794 lines)
│   ├── preload.js            # Webview preload script
│   ├── services/
│   │   └── ConfigService.js  # Configuration management
│   ├── utils/
│   │   ├── config.js         # Config utilities
│   │   ├── errorHandler.js   # Global error handling
│   │   ├── logger.js         # Winston logging setup
│   │   └── recovery.js       # Recovery mode
│   └── window/
│       └── windowManager.js  # Window management
│
├── renderer/                  # Renderer process (UI)
│   ├── renderer.js           # Main renderer logic (2,230 lines)
│   ├── components/
│   │   ├── Sidebar.js        # Sidebar component
│   │   └── SettingsMenu.js   # Settings UI
│   ├── utils/
│   │   ├── rendererErrorHandler.js
│   │   └── shortcuts.js      # Keyboard shortcuts
│   └── styles/
│       ├── components/       # Component-specific styles
│       └── themes/           # Theme files
│
├── scripts/                   # Build & utility scripts (10 essential)
│   ├── auto-fix.js
│   ├── build-css.js
│   ├── health-check.js
│   ├── post-build-fix.js
│   ├── pre-build-check.js
│   └── validate-build.js
│
├── tests/                     # Test suite
│   ├── e2e/                  # End-to-end tests
│   ├── integration/          # Integration tests
│   ├── unit/                 # Unit tests
│   ├── helpers/              # Test helpers
│   ├── mocks/                # Mock modules
│   └── setup/                # Jest configuration
│
├── docs/                      # Documentation
│   ├── AUTOFLOW_STATE.md
│   ├── AUTONOMOUS_CODING.md
│   ├── BUILD_FIXES.md
│   ├── GEMINI.md
│   └── PROD_*.md
│
├── assets/                    # Icons and images
│   ├── icon.{ico,icns,png}
│   └── ai-logos/
│
└── Build Configuration
    ├── package.json           # Dependencies & scripts (34 scripts)
    ├── electron-builder.json  # Build configuration
    ├── tsconfig.json          # TypeScript config
    ├── jest.config.js         # Jest configuration
    ├── eslint.config.js       # ESLint rules
    └── .prettierrc.js         # Code formatting
```

### Key Files to Understand

**Entry Point Flow:**
1. `main.js` - Detects platform, sets up single-instance lock, launches main process
2. `main/index.js` - Sets up Electron app, creates windows, registers IPC handlers
3. `index.html` - Loads renderer process
4. `renderer/renderer.js` - Manages UI, cognitizers, browser views

**Core Concepts:**
- **Cognitizers**: Predefined web pages (LLMs, search engines) accessible via sidebar tabs
- **Browser View**: Separate view for CTRL+Click links
- **Multi-Cognition Mode**: Display multiple cognitizers side-by-side
- **Global Hotkey**: CTRL/CMD+Space to show/hide app window

### Development Commands

```bash
# Run app in development
npm start

# Run tests
npm test                  # Unit tests
npm run test:all         # All tests
npm run test:coverage    # With coverage

# Code quality
npm run lint             # Check for issues
npm run lint:fix         # Auto-fix issues
npm run typecheck        # TypeScript checking
npm run fix              # Lint + format

# Build
./bld_and_cp.sh                    # Auto-detect OS and build
npm run package-win-x64            # Windows x64
npm run package-mac-arm            # macOS ARM
npm run build-win-portable         # Windows portable

# Verify everything
npm run verify           # typecheck + lint + test
```

### Important Notes for AI Assistants

1. **Main Process (`main/index.js`)**: Currently 1,794 lines - handles app lifecycle, window management, IPC, ad-blocking, shortcuts, menus. **Future refactoring target**.

2. **Renderer Process (`renderer/renderer.js`)**: Currently 2,230 lines - manages cognitizers, browser view, multi-cognition mode, find-in-page, gestures. **Future refactoring target**.

3. **Testing**: Use `npm test` frequently. Tests must pass before any major changes are considered complete.

4. **Configuration**: User settings in `config.json` (gitignored). Template in codebase shows structure.

5. **Platform-Specific Code**: Windows requires GPU disabled. macOS/Linux don't. See `main.js` for platform detection.

6. **Scripts Directory**: Only essential build/test scripts. Debug/diagnostic scripts have been removed for simplicity.

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

**Standard locations for MCP tools in this project:**
- `mcp-tools/` - Root directory for all custom MCP tools
- `mcp-tools/<tool-name>/` - Individual tool directory
- `mcp-tools/<tool-name>/index.js` - Tool entry point
- `mcp-tools/<tool-name>/README.md` - Tool documentation

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
