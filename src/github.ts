// Thin GitHub REST client plus pure functions that turn raw API data into
// compact summaries. Summaries stay small on purpose: every token returned
// to the model is context it has to read.

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type Fetch = typeof fetch;

export function createClient(token = process.env.GITHUB_TOKEN, fetchImpl: Fetch = fetch) {
  return async function gh<T>(path: string): Promise<T> {
    const res = await fetchImpl(`${API}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "github-pulse-mcp",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) {
      if (res.status === 404) throw new GitHubError(`Not found: ${path}`, 404);
      if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
        throw new GitHubError(
          "GitHub rate limit reached. Set GITHUB_TOKEN to raise the limit from 60 to 5,000 requests an hour.",
          res.status,
        );
      }
      if (res.status === 403) throw new GitHubError(`Access denied: ${path}. Check that GITHUB_TOKEN can read it.`, 403);
      throw new GitHubError(`GitHub API ${res.status} on ${path}`, res.status);
    }
    return (await res.json()) as T;
  };
}

export type Client = ReturnType<typeof createClient>;

// ---------- Activity ----------

export interface GitHubEvent {
  type: string;
  repo: { name: string };
  created_at: string;
  payload: {
    action?: string;
    size?: number;
    commits?: { message: string }[];
    ref_type?: string;
    pull_request?: { title: string; merged?: boolean };
    issue?: { title: string };
  };
}

export interface ActivitySummary {
  username: string;
  days: number;
  totals: { commits: number; pushes: number; prsOpened: number; prsMerged: number; issuesOpened: number; reviews: number; reposCreated: number; stars: number };
  activeDays: number;
  busiestRepos: { repo: string; events: number; commits: number }[];
  highlights: string[];
}

export function summarizeActivity(username: string, events: GitHubEvent[], days: number, now = new Date()): ActivitySummary {
  const since = now.getTime() - days * 86_400_000;
  const recent = events.filter((e) => new Date(e.created_at).getTime() >= since);

  const totals = { commits: 0, pushes: 0, prsOpened: 0, prsMerged: 0, issuesOpened: 0, reviews: 0, reposCreated: 0, stars: 0 };
  const perRepo = new Map<string, { events: number; commits: number }>();
  const dayset = new Set<string>();
  const highlights: string[] = [];

  for (const e of recent) {
    dayset.add(e.created_at.slice(0, 10));
    const r = perRepo.get(e.repo.name) ?? { events: 0, commits: 0 };
    r.events++;
    switch (e.type) {
      case "PushEvent": {
        const n = e.payload.size ?? e.payload.commits?.length ?? 0;
        totals.pushes++;
        totals.commits += n;
        r.commits += n;
        break;
      }
      case "PullRequestEvent":
        if (e.payload.action === "opened") {
          totals.prsOpened++;
          highlights.push(`Opened PR "${e.payload.pull_request?.title}" in ${e.repo.name}`);
        }
        if (e.payload.action === "closed" && e.payload.pull_request?.merged) {
          totals.prsMerged++;
          highlights.push(`Merged PR "${e.payload.pull_request?.title}" in ${e.repo.name}`);
        }
        break;
      case "IssuesEvent":
        if (e.payload.action === "opened") totals.issuesOpened++;
        break;
      case "PullRequestReviewEvent":
        totals.reviews++;
        break;
      case "CreateEvent":
        if (e.payload.ref_type === "repository") {
          totals.reposCreated++;
          highlights.push(`Created repository ${e.repo.name}`);
        }
        break;
      case "WatchEvent":
        totals.stars++;
        break;
    }
    perRepo.set(e.repo.name, r);
  }

  const busiestRepos = [...perRepo.entries()]
    .map(([repo, v]) => ({ repo, ...v }))
    .sort((a, b) => b.events - a.events)
    .slice(0, 5);

  return { username, days, totals, activeDays: dayset.size, busiestRepos, highlights: highlights.slice(0, 10) };
}

// ---------- Repo health ----------

export interface Repo {
  full_name: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  pushed_at: string;
  license: { spdx_id: string } | null;
  archived: boolean;
  topics?: string[];
  default_branch: string;
}

export interface PullRequest {
  title: string;
  number: number;
  created_at: string;
  draft?: boolean;
}

export interface RepoHealth {
  repo: string;
  description: string | null;
  stars: number;
  forks: number;
  languages: { name: string; percent: number }[];
  daysSinceLastPush: number;
  openPullRequests: number;
  stalePullRequests: { number: number; title: string; ageDays: number }[];
  hasLicense: boolean;
  archived: boolean;
  score: number;
  flags: string[];
}

const daysBetween = (iso: string, now: Date) => Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);

export function assessRepo(repo: Repo, languages: Record<string, number>, pulls: PullRequest[], now = new Date()): RepoHealth {
  const totalBytes = Object.values(languages).reduce((a, b) => a + b, 0) || 1;
  const langs = Object.entries(languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, bytes]) => ({ name, percent: Math.round((bytes / totalBytes) * 1000) / 10 }));

  const sincepush = daysBetween(repo.pushed_at, now);
  const stale = pulls
    .filter((p) => !p.draft)
    .map((p) => ({ number: p.number, title: p.title, ageDays: daysBetween(p.created_at, now) }))
    .filter((p) => p.ageDays > 30)
    .sort((a, b) => b.ageDays - a.ageDays);

  // A simple, explainable 0-100 score. Each flag says why points were lost.
  let score = 100;
  const flags: string[] = [];
  if (repo.archived) { score -= 40; flags.push("Repository is archived"); }
  const pushPenalty = sincePushPenalty(sincepush);
  if (pushPenalty) { score -= pushPenalty; flags.push(`No push for ${sincepush} days`); }
  if (!repo.license) { score -= 15; flags.push("No license file"); }
  if (!repo.description) { score -= 5; flags.push("No description"); }
  if (stale.length) { score -= Math.min(20, stale.length * 5); flags.push(`${stale.length} pull request(s) open for more than 30 days`); }

  return {
    repo: repo.full_name,
    description: repo.description,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    languages: langs,
    daysSinceLastPush: sincepush,
    openPullRequests: pulls.length,
    stalePullRequests: stale.slice(0, 5),
    hasLicense: !!repo.license,
    archived: repo.archived,
    score: Math.max(0, score),
    flags,
  };
}

function sincePushPenalty(days: number) {
  if (days > 365) return 30;
  if (days > 180) return 20;
  if (days > 60) return 10;
  return 0;
}

// ---------- Good first issues ----------

export interface SearchIssue {
  title: string;
  html_url: string;
  repository_url: string;
  comments: number;
  created_at: string;
  labels: { name: string }[];
}

export function buildIssueQuery(language?: string, topic?: string) {
  const q = ['label:"good first issue"', "state:open", "no:assignee", "is:issue"];
  if (language) q.push(`language:${language}`);
  if (topic) q.push(topic);
  return q.join(" ");
}

export function formatIssues(items: SearchIssue[], now = new Date()) {
  return items.map((i) => ({
    title: i.title,
    repo: i.repository_url.replace("https://api.github.com/repos/", ""),
    url: i.html_url,
    comments: i.comments,
    ageDays: daysBetween(i.created_at, now),
    labels: i.labels.map((l) => l.name).slice(0, 5),
  }));
}
