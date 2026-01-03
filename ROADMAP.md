# Agentic Next.js Starter Roadmap

## 1. Browser Feedback Loop ✓

- `bun run d3k` replaces `bun run dev` - starts Next.js with browser monitoring, no MCP context overhead
- `/debug` skill reads `~/.d3k/logs/` and analyzes errors by priority
- Screenshots captured on errors via dev3000's CDP monitoring
- Browser actions available via dev3000 API (localhost:3684) when needed

## 2. Local Next.js Documentation ✓

- **Download script** (`bun run docs:update`) fetches docs from `vercel/next.js/docs`
- Store in `.claude/docs/nextjs/` for direct Grep/Read access
- **Hook** checks docs age on session start, prompts update if stale (>7 days)
- Reference path in `CLAUDE.md` - no skill needed, native file access is faster

## 3. Remaining Items

### Version-lock docs
- Match docs to project's Next.js version in `package.json`
- Currently fetches canary branch

### Evaluation
- Use [`next-evals-oss`](https://github.com/vercel/next-evals-oss) to benchmark agentic setup
- Track improvements across iterations
- Compare before/after with docs + debug skill

### Next.js Skills (optional)
- Skipping basic scaffolding skills (create page, API route) - too simple
- Consider skills for complex patterns only (parallel routes, intercepting routes)
- May not be needed if docs access is sufficient

## Design Considerations

- Fewer tool calls to resolve files
- Docs on disk, not web
- Skills for multi-step workflows only
- Pull context on demand, don't preload
- One path = one file
