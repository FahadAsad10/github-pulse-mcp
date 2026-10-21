import { describe, expect, it, vi } from "vitest";
import { assessRepo, buildIssueQuery, createClient, formatIssues, summarizeActivity, type GitHubEvent } from "../src/github.js";

const now = new Date("2026-10-21T12:00:00Z");
const ev = (type: string, repo: string, daysAgo: number, payload: GitHubEvent["payload"] = {}): GitHubEvent => ({
  type,
  repo: { name: repo },
  created_at: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
  payload,
});

describe("summarizeActivity", () => {
  const events = [
    ev("PushEvent", "me/app", 1, { size: 3 }),
    ev("PushEvent", "me/app", 2, { size: 2 }),
    ev("PullRequestEvent", "me/app", 2, { action: "opened", pull_request: { title: "Add login" } }),
    ev("PullRequestEvent", "org/lib", 3, { action: "closed", pull_request: { title: "Fix typo", merged: true } }),
    ev("CreateEvent", "me/new", 4, { ref_type: "repository" }),
    ev("PullRequestReviewEvent", "org/lib", 5),
    ev("PushEvent", "me/old", 30, { size: 10 }),
  ];

  it("counts only events inside the window", () => {
    const s = summarizeActivity("me", events, 7, now);
    expect(s.totals.commits).toBe(5);
    expect(s.totals.prsOpened).toBe(1);
    expect(s.totals.prsMerged).toBe(1);
    expect(s.totals.reviews).toBe(1);
    expect(s.totals.reposCreated).toBe(1);
    expect(s.activeDays).toBe(5);
  });

  it("ranks the busiest repositories", () => {
    const s = summarizeActivity("me", events, 7, now);
    expect(s.busiestRepos[0]).toEqual({ repo: "me/app", events: 3, commits: 5 });
  });

  it("writes readable highlights", () => {
    const s = summarizeActivity("me", events, 7, now);
    expect(s.highlights).toContain('Merged PR "Fix typo" in org/lib');
  });
});

describe("assessRepo", () => {
  const base = {
    full_name: "me/app",
    description: "An app",
    stargazers_count: 12,
    forks_count: 3,
    open_issues_count: 2,
    pushed_at: "2026-10-20T00:00:00Z",
    license: { spdx_id: "MIT" },
    archived: false,
    default_branch: "main",
  };

  it("gives a healthy repo full marks", () => {
    const h = assessRepo(base, { TypeScript: 900, CSS: 100 }, [], now);
    expect(h.score).toBe(100);
    expect(h.flags).toEqual([]);
    expect(h.languages[0]).toEqual({ name: "TypeScript", percent: 90 });
  });

  it("explains every point it takes away", () => {
    const h = assessRepo(
      { ...base, license: null, description: null, pushed_at: "2025-09-01T00:00:00Z" },
      {},
      [{ title: "Old PR", number: 4, created_at: "2026-06-01T00:00:00Z" }],
      now,
    );
    expect(h.score).toBe(100 - 30 - 15 - 5 - 5);
    expect(h.flags).toHaveLength(4);
    expect(h.stalePullRequests[0].number).toBe(4);
  });
});

describe("issues", () => {
  it("builds a search query", () => {
    expect(buildIssueQuery("python", "cli")).toBe('label:"good first issue" state:open no:assignee is:issue language:python cli');
  });

  it("formats search results", () => {
    const [i] = formatIssues(
      [{ title: "Docs", html_url: "u", repository_url: "https://api.github.com/repos/a/b", comments: 1, created_at: "2026-10-11T12:00:00Z", labels: [{ name: "good first issue" }] }],
      now,
    );
    expect(i).toMatchObject({ repo: "a/b", ageDays: 10 });
  });
});

describe("createClient", () => {
  it("sends the token and maps rate limits to a helpful error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    const gh = createClient("secret", fetchMock);
    await expect(gh("/users/x")).rejects.toThrow(/rate limit/);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer secret");
  });
});
