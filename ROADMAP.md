# Agentic Next.js Starter Roadmap

## 1. Next.js Skills (via MCP)

- Integrate [`next-devtools-mcp`](https://github.com/vercel/next-devtools-mcp) for route/component introspection
- Create skills for common operations: create page, create API route, add middleware
- Add skills for Next.js-specific patterns (server actions, parallel routes, etc.)

## 2. Browser Feedback Loop

- Integrate dev3000 or similar browser automation MCP
- Enable screenshot capture of running app for visual feedback
- Add console/network error capture for debugging context
- Consider Playwright MCP for e2e test generation

## 3. Local Next.js Documentation

- Script to fetch/update Next.js docs from GitHub (`vercel/next.js/docs`)
- Store in `.claude/docs/nextjs/` for local context
- Add to `.claude/CLAUDE.md` as reference path
- Include App Router and Pages Router sections
- Consider versioning to match project's Next.js version

## 4. Evaluation

- Use [`next-evals-oss`](https://github.com/vercel/next-evals-oss) to benchmark agentic setup
- Track improvements across iterations
- Compare performance with different MCP/skill configurations

## 5. Configuration

- Add `.claude/settings.json` with MCP server configs
- Create setup script (`bun run setup:claude`) for first-time config
- Document required API keys/permissions
