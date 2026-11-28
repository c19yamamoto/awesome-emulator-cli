import assert from "node:assert/strict";
import test from "node:test";
import { findCoverageComment, formatCoverageComment, publishCoverageComment } from "../.coverage-tools/scripts/coverage/publish-coverage-comment.js";

test("formats a coverage comment and prevents mention notifications", () => {
  const body = formatCoverageComment("## Coverage report\n\n@maintainer", "success");

  assert.match(body, /<!-- awesome-emulator-coverage-report -->/);
  assert.match(body, /@\u200bmaintainer/);
  assert.match(body, /Coverage job result: success\./);
});

test("finds only the existing bot coverage comment for updates", () => {
  const existing = { id: 42, body: "<!-- awesome-emulator-coverage-report -->\nold report", user: { login: "github-actions[bot]" } };
  const comments = [
    { id: 1, body: existing.body, user: { login: "contributor" } },
    { id: 2, body: "A bot comment without the marker", user: { login: "github-actions[bot]" } },
    existing,
  ];

  assert.equal(findCoverageComment(comments), existing);
  assert.equal(findCoverageComment(comments.slice(0, 2)), undefined);
});

test("updates the existing bot coverage comment instead of creating a duplicate", async () => {
  const requests = [];
  const fetcher = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) {
      return new Response(JSON.stringify([
        { id: 42, body: "<!-- awesome-emulator-coverage-report -->\nold", user: { login: "github-actions[bot]" } },
      ]), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  await publishCoverageComment({
    token: "test-token",
    repository: "owner/repo",
    pullRequestNumber: 105,
    report: "## Coverage report\n\nC0: 98%",
    result: "success",
    fetcher,
  });

  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /\/issues\/105\/comments\/42$/);
  assert.equal(requests[1].options.method, "PATCH");
  assert.match(JSON.parse(requests[1].options.body).body, /C0: 98%/);
});
