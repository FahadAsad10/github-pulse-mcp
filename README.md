# GitHub Pulse MCP

**An MCP server that gives Claude (and any MCP client) live insight into GitHub: summarise anyone's recent activity, score a repository's health, and find beginner-friendly issues to contribute to.**

Ask Claude things like:

> "What did I ship on GitHub this week?"
> "Is `expressjs/express` still actively maintained?"
> "Find me five good first issues in TypeScript CLI projects."

## Tools

| Tool | What it does |
|---|---|
| `get_user_activity` | Commits, PRs opened and merged, reviews, new repos, busiest repositories and highlights for the last 1-90 days |
| `get_repo_health` | A 0-100 health score with the reason for every point lost (stale PRs, no license, inactivity, archived), plus stars, forks and language mix |
| `find_good_first_issues` | Open, unassigned `good first issue` issues, filtered by language and keyword |

It also ships a **`weekly_report` prompt**, which tells Claude to chain the tools and write a short weekly summary.

## Design choices

- **Small, model-friendly output.** Raw GitHub responses are large. Every tool reduces them to a compact summary so Claude spends its context on reasoning, not JSON.
- **Explainable scoring.** The repo health score is a simple rule set, and every deduction comes back as a human-readable flag, so Claude can explain *why* a repo scored 65.
- **Pure logic, thin I/O.** All summarising lives in pure functions in `src/github.ts` and is unit-tested without the network. `src/index.ts` only wires them to MCP.
- **Helpful errors.** Rate limits, missing repos and permission problems come back as clear tool errors (`isError: true`) the model can act on, instead of crashing the server.
- **Read-only.** Every tool is annotated `readOnlyHint`, and the server never writes to GitHub.

## Setup

```bash
git clone https://github.com/FahadAsad10/github-pulse-mcp.git
cd github-pulse-mcp
npm install
npm run build
```

A `GITHUB_TOKEN` is optional but recommended. It raises the limit from 60 to 5,000 requests an hour. A fine-grained token with **public repositories (read-only)** access is enough.

### Claude Code

```bash
claude mcp add github-pulse -e GITHUB_TOKEN=ghp_xxx -- node /absolute/path/to/github-pulse-mcp/dist/index.js
```

### Claude Desktop

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "github-pulse": {
      "command": "node",
      "args": ["/absolute/path/to/github-pulse-mcp/dist/index.js"],
      "env": { "GITHUB_TOKEN": "ghp_xxx" }
    }
  }
}
```

### Try it with the MCP Inspector

```bash
npm run inspect
```

## Development

```bash
npm test        # vitest unit tests
npm run dev     # run from source with tsx
```

## Tech stack

TypeScript · Node.js 20+ · [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) · Zod · Vitest · GitHub REST API · GitHub Actions CI

## License

MIT, built by Fahad Shaikh with [Claude Code](https://claude.com/claude-code).
