# Debug Skill

Diagnose browser and server errors from dev3000 logs.

## Prerequisites

Use dev3000 instead of `bun run dev`:

```bash
bun run d3k
```

This starts your Next.js dev server with browser monitoring. It runs `dev3000@0.0.128 --disable-mcp-configs all`, which prevents MCP registration and keeps Claude Code context lean.

## What this skill does

1. Reads `~/.d3k/logs/{project}-d3k.log` for captured browser/server logs
2. Reads `~/.d3k/{project}.json` for session info and screenshot paths
3. Categorizes errors by severity (build > server > browser > network > warning)
4. Returns prioritized issues

## Instructions

When the user runs `/debug`, do the following:

### 1. Find the active session

```bash
ls -la ~/.d3k/*.json
```

Read the most recent session file to get:
- `logFilePath` - where logs are written
- `screenshotDir` - where screenshots are saved (if available)

### 2. Read and analyze logs

Read the last 200 lines of the log file and categorize:

**Build errors** (priority 1000+):
- `Module not found`
- `SyntaxError`
- `Failed to compile`
- `Build failed`

**Server errors** (priority 500+):
- `[SERVER]` entries with `Error`, `Exception`, `FATAL`
- Unhandled promise rejections
- Server crashes

**Browser errors** (priority 300+):
- `[ERROR]` entries
- `[BROWSER]` with exceptions
- React/hydration errors

**Network errors** (priority 200+):
- HTTP 4xx/5xx responses
- Failed fetches
- CORS errors

**Warnings** (priority 100+):
- `[WARNING]` entries
- Deprecation notices

### 3. Check screenshots

If `screenshotDir` is available, list recent screenshots. Files ending in `-error.png` show app state when errors occurred.

### 4. Report findings

Output a prioritized list:

```
## Debug Report

### Critical Issues
1. [BUILD] Module not found: './missing-file'
   Screenshot: 2024-01-03T10-15-30-error.png

### Errors
2. [BROWSER] Uncaught TypeError: Cannot read property 'x' of undefined
   at src/components/Button.tsx:42

### Warnings
3. [WARNING] React hydration mismatch
```

## Error priority scoring

```
Base scores:
- build: 1000
- server: 500
- browser: 300
- network: 200
- warning: 100

Modifiers:
- CRITICAL/FATAL/crashed: x2
- ERROR/Exception/FAIL: x1.5
- Multiple occurrences: +50 each
- Recent (< 1 min): +100
```

## Browser actions

dev3000 exposes browser actions through its MCP server at `localhost:3684`. While we're not using MCP for context, you can still call the API directly if needed:

```bash
# Take screenshot
curl -X POST http://localhost:3684/api/screenshots/capture

# List screenshots
curl http://localhost:3684/api/screenshots/list

# Get log tail
curl "http://localhost:3684/api/logs/tail?lines=50"
```

## File locations

- `~/.d3k/logs/{project}-d3k.log` - Consolidated logs
- `~/.d3k/{project}.json` - Session info
- `~/.d3k/chrome-profiles/{project}/` - Chrome profile
- Screenshots location varies - check session file
