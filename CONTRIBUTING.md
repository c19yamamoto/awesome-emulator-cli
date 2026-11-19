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
- Use squash merge with the PR title as the squash commit message so Release Please can determine the next version.

The CI workflow runs the build and test suite on Node.js 22, 24, and 26 across Linux, macOS, and Windows. Docker integration coverage runs on Ubuntu.

After changes reach `main`, Release Please opens a release pull request. Merging it creates a GitHub release and version tag, which triggers the npm publish workflow.
