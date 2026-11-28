import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { env } from "node:process";
import { fileURLToPath } from "node:url";

const coverageMarker = "<!-- awesome-emulator-coverage-report -->";
const apiVersion = "2022-11-28";

interface IssueComment {
  id: number;
  body?: string;
  user?: { login?: string };
}

interface PullRequest {
  number: number;
  head?: { sha?: string; repo?: { full_name?: string } };
}

interface PublisherOptions {
  token: string;
  repository: string;
  report: string;
  result: string;
  pullRequestNumber?: number;
  headSha?: string;
  headRepository?: string;
  fetcher?: typeof fetch;
}

export function formatCoverageComment(report: string, result: string): string {
  const safeReport = report.replaceAll("@", `@${String.fromCharCode(0x200b)}`);
  return `${coverageMarker}\n${safeReport}\n\nCoverage job result: ${result}.`;
}

export function findCoverageComment(comments: IssueComment[]): IssueComment | undefined {
  return comments.find((comment) => comment.user?.login === "github-actions[bot]"
    && comment.body?.includes(coverageMarker));
}

async function findPullRequestNumber(
  apiBase: string,
  headers: HeadersInit,
  headSha: string,
  headRepository: string,
  fetcher: typeof fetch,
): Promise<number> {
  const response = await fetcher(`${apiBase}/commits/${headSha}/pulls?per_page=100`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub pull request lookup failed: ${response.status} ${await response.text()}`);
  }

  const pulls = await response.json() as PullRequest[];
  const pull = pulls.find((candidate) => candidate.head?.sha === headSha
    && candidate.head.repo?.full_name === headRepository);
  if (!pull) {
    throw new Error(`No pull request found for ${headRepository}@${headSha}.`);
  }
  return pull.number;
}

export async function publishCoverageComment(options: PublisherOptions): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const [owner, repositoryName] = options.repository.split("/");
  if (!owner || !repositoryName || options.repository.split("/").length !== 2) {
    throw new Error(`Invalid repository name: ${options.repository}`);
  }

  const apiBase = `https://api.github.com/repos/${owner}/${repositoryName}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${options.token}`,
    "X-GitHub-Api-Version": apiVersion,
  };

  const pullRequestNumber = options.pullRequestNumber
    ?? (options.headSha && options.headRepository
      ? await findPullRequestNumber(apiBase, headers, options.headSha, options.headRepository, fetcher)
      : undefined);
  if (!pullRequestNumber || !Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new Error("A pull request number or matching head SHA and repository is required.");
  }

  const commentsEndpoint = `${apiBase}/issues/${pullRequestNumber}/comments`;
  const body = formatCoverageComment(options.report, options.result);
  let existing: IssueComment | undefined;
  for (let page = 1; !existing; page += 1) {
    const response = await fetcher(`${commentsEndpoint}?per_page=100&page=${page}`, { headers });
    if (!response.ok) {
      throw new Error(`GitHub comment lookup failed: ${response.status} ${await response.text()}`);
    }
    const comments = await response.json() as IssueComment[];
    existing = findCoverageComment(comments);
    if (existing || comments.length < 100) break;
  }

  const response = existing
    ? await fetcher(`${apiBase}/issues/comments/${existing.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ body }),
    })
    : await fetcher(commentsEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ body }),
    });
  if (!response.ok) {
    throw new Error(`GitHub comment publish failed: ${response.status} ${await response.text()}`);
  }
  console.log(existing ? "Updated coverage comment." : `Created coverage comment on PR #${pullRequestNumber}.`);
}

async function main(): Promise<void> {
  const report = env.COVERAGE_REPORT
    ?? await readFile(env.COVERAGE_REPORT_PATH ?? "coverage/report.md", "utf8").catch(() =>
      "## Coverage report unavailable\n\nNo report was produced.");
  const pullRequestNumber = env.PR_NUMBER ? Number(env.PR_NUMBER) : undefined;
  await publishCoverageComment({
    token: env.GH_TOKEN ?? "",
    repository: env.GH_REPOSITORY ?? "",
    report,
    result: env.COVERAGE_RESULT ?? "unknown",
    pullRequestNumber,
    headSha: env.HEAD_SHA,
    headRepository: env.HEAD_REPOSITORY,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
