import { readFileSync } from "node:fs";

const pullRequest = JSON.parse(readFileSync(0, "utf8"));
const versionPattern = String.raw`\d+\.\d+\.\d+`;
const trustedPullRequestAuthor = process.env.TRUSTED_PR_AUTHOR?.toLowerCase();

function hasExactFiles(expectedFiles) {
  const actualFiles = pullRequest.files?.map(({ path }) => path).sort();
  return JSON.stringify(actualFiles) === JSON.stringify([...expectedFiles].sort());
}

function isSingleCommitWithHeadline(headline) {
  return pullRequest.commits?.length === 1
    && pullRequest.commits[0].messageHeadline === headline;
}

function isEmulatorVersionUpdate() {
  const titlePattern = new RegExp(`^chore\\(emulator-version\\): update AWS Emulator to v${versionPattern}$`);
  return pullRequest.headRefName === "update-aws-emulator-version"
    && titlePattern.test(pullRequest.title)
    && isSingleCommitWithHeadline(pullRequest.title)
    && hasExactFiles(["src/emulator-options.ts"]);
}

function isEmulatorOnlyRelease() {
  const titlePattern = new RegExp(`^chore\\(main\\): release (${versionPattern})$`);
  const titleMatch = titlePattern.exec(pullRequest.title);
  if (!titleMatch
      || pullRequest.headRefName !== "release-please--branches--main--components--awesome-emulator-cli"
      || !isSingleCommitWithHeadline(pullRequest.title)
      || !hasExactFiles([
        ".release-please-manifest.json",
        "CHANGELOG.md",
        "package-lock.json",
        "package.json",
      ])) {
    return false;
  }

  const body = pullRequest.body ?? "";
  if (!body.includes("This PR was generated with [Release Please]")) return false;

  const sectionStart = body.search(/^## \[/m);
  const sectionEnd = body.indexOf("\n---", sectionStart);
  if (sectionStart < 0 || sectionEnd < 0) return false;

  const sectionLines = body
    .slice(sectionStart, sectionEnd)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (sectionLines.length !== 3) return false;

  const [heading, category, entry] = sectionLines;
  const headingPattern = new RegExp(`^## \\[${titleMatch[1]}\\]\\([^)]*\\) \\(\\d{4}-\\d{2}-\\d{2}\\)$`);
  const entryPattern = /^\* \*\*emulator-version:\*\* update AWS Emulator to v\d+\.\d+\.\d+(?: \(.*\))?$/;
  return headingPattern.test(heading)
    && category === "### Maintenance"
    && entryPattern.test(entry);
}

const eligible = pullRequest.baseRefName === "main"
  && pullRequest.isDraft === false
  && pullRequest.isCrossRepository === false
  && Boolean(trustedPullRequestAuthor)
  && pullRequest.author?.login?.toLowerCase() === trustedPullRequestAuthor
  && (isEmulatorVersionUpdate() || isEmulatorOnlyRelease());

process.stdout.write(`${eligible}\n`);
