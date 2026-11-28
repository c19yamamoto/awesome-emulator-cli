# Contributing

Contributions are welcome. Open an issue to discuss larger changes, then submit a pull request against `main`.

## Development

Requirements: Node.js 22+ and npm. Docker is required for the integration test.

```sh
npm ci
npm test
```

To run the Docker integration test, set `AWS_EMULATOR_INTEGRATION_TESTS=1` and run `npm run test:integration`. This downloads the pinned emulator package and requires Docker.

## Pull requests

- Include tests for behavior changes and update user documentation when needed.
- Keep changes focused and describe their user impact in the pull request.
- Use [Conventional Commits](https://www.conventionalcommits.org/), for example `feat: add custom image support`, `fix: clean up on startup failure`, or `docs: clarify port selection`.
- Use squash merge with the PR title as the commit subject, preserving any required commit body footers.

The CI workflow runs the build and test suite on Node.js 22, 24, and 26 across Linux, macOS, and Windows. Docker integration coverage runs on Ubuntu.

After changes reach `main`, Release Please opens a release pull request. Merging it creates a GitHub release and version tag, which triggers the package publish workflow. After tests and publication to npmjs.com succeed, a separate job publishes the same version to GitHub Packages as `@c19yamamoto/awesome-emulator-cli`. Only that job changes the package name and registry; the npmjs.com package remains `awesome-emulator-cli`.

GitHub Packages publishing uses the workflow's `GITHUB_TOKEN` with `packages: write`; no additional secret or personal access token is required. The `repository` field in `package.json` links the package to this repository. After the first successful publish, open the package's **Package settings → Danger Zone → Change visibility** and select **Public** if it should be visible to everyone. New packages default to private, and changing to public is irreversible. The next `v*` tag after this workflow is merged performs the first publish; creating or merging this PR does not publish a package.

The AWS Emulator version updater checks for a newer stable upstream release each day and opens or refreshes a pull request titled `chore(emulator-version): update AWS Emulator to vX.Y.Z`. The repository must allow GitHub Actions to create pull requests. Checks on updater PRs wait for a maintainer to approve them. CI runs the integration test against the proposed default version. Squash-merge the update using its title; Release Please includes it in the `Maintenance` changelog section and proposes a patch release.
