#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  assessRepo,
  buildIssueQuery,
  createClient,
  formatIssues,
  GitHubError,
  summarizeActivity,
  type GitHubEvent,
  type PullRequest,
  type Repo,
  type SearchIssue,
} from "./github.js";

const gh = createClient();

const server = new McpServer({ name: "github-pulse", version: "0.1.0" });

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof GitHubError ? err.message : `Unexpected error: ${String(err)}` }],
});

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

server.registerTool(
  "get_user_activity",
  {
    title: "Summarise a GitHub user's recent activity",
    description:
      "Summarises a GitHub user's public activity over the last N days: commits, pull requests opened and merged, reviews, new repos, busiest repositories and highlights. Use it for stand-up notes, weekly reports or a quick profile overview.",
    inputSchema: {
      username: z.string().min(1).describe("GitHub username, e.g. 'torvalds'"),
      days: z.number().int().min(1).max(90).default(7).describe("How many days back to look (GitHub keeps 90 days of events)"),
    },
    annotations: readOnly,
  },
  async ({ username, days }) => {
    try {
      const pages = await Promise.all(
        [1, 2, 3].map((page) => gh<GitHubEvent[]>(`/users/${encodeURIComponent(username)}/events/public?per_page=100&page=${page}`)),
      );
      return json(summarizeActivity(username, pages.flat(), days));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "get_repo_health",
  {
    title: "Check a repository's health",
    description:
      "Returns a 0-100 health score for a repository with the reasons behind it: recent activity, license, description, stale pull requests, plus stars, forks and language breakdown.",
    inputSchema: {
      repo: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/, "Use the form owner/name")
        .describe("Repository as owner/name, e.g. 'vercel/next.js'"),
    },
    annotations: readOnly,
  },
  async ({ repo }) => {
    try {
      const [info, languages, pulls] = await Promise.all([
        gh<Repo>(`/repos/${repo}`),
        gh<Record<string, number>>(`/repos/${repo}/languages`),
        gh<PullRequest[]>(`/repos/${repo}/pulls?state=open&per_page=100`),
      ]);
      return json(assessRepo(info, languages, pulls));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "find_good_first_issues",
  {
    title: "Find beginner-friendly open source issues",
    description:
      "Searches GitHub for open, unassigned issues labelled 'good first issue', optionally filtered by language and a topic keyword. Good for finding a first open source contribution.",
    inputSchema: {
      language: z.string().optional().describe("Programming language, e.g. 'typescript' or 'python'"),
      topic: z.string().optional().describe("Free-text keyword, e.g. 'react' or 'cli'"),
      limit: z.number().int().min(1).max(30).default(10),
    },
    annotations: readOnly,
  },
  async ({ language, topic, limit }) => {
    try {
      const q = encodeURIComponent(buildIssueQuery(language, topic));
      const res = await gh<{ total_count: number; items: SearchIssue[] }>(
        `/search/issues?q=${q}&sort=created&order=desc&per_page=${limit}`,
      );
      return json({ total: res.total_count, issues: formatIssues(res.items) });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerPrompt(
  "weekly_report",
  {
    title: "Weekly GitHub report",
    description: "Writes a short weekly report of what a developer shipped on GitHub.",
    argsSchema: { username: z.string().describe("GitHub username") },
  },
  ({ username }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Use get_user_activity for "${username}" with days=7. Then write a friendly weekly report in under 150 words: what they shipped, where they spent most time, and one suggestion for next week. If a busy repo looks unhealthy, check it with get_repo_health and mention the top issue.`,
        },
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
console.error("github-pulse MCP server running on stdio");
