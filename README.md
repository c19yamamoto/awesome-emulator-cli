# Awesome Emulator CLI

<p align="center">
  <img src="./assets/social-preview-v2.png" alt="Awesome Emulator CLI — Local emulator testing for AWS SDKs" width="100%">
</p>

A Node.js CLI that manages AWS Emulator in Docker and passes its connection settings to your test command. Your tests can use any AWS SDK language; they do not need to run in Node.js.

This is an independent project and is not affiliated with or endorsed by Amazon Web Services.

## Requirements

- Node.js 22 or later
- Docker Engine or Docker Desktop
- x86_64/amd64 or ARM64/aarch64

On first use, Docker downloads the selected AWS Emulator RPM and signature, verifies the signature, and builds an image. The image is reused on later runs. To prepare it before tests start, run `npx awesome-emulator prepare`; use `--version` or `AWS_EMULATOR_VERSION` to select a release.

## Run tests

```sh
npm install --save-dev awesome-emulator-cli
npx awesome-emulator run -- npm test
```

`run` starts the emulator, supplies its endpoint and TLS settings to the child process, then stops the container. Set the child's default region with `--region`:

```sh
npx awesome-emulator run --region ap-northeast-1 -- npm test
```

Both `AWS_REGION` and `AWS_DEFAULT_REGION` default to `us-east-1`. An explicit region on an SDK client still takes precedence.

The CLI removes inherited AWS credentials, profiles, and service endpoints from the child environment. Credentials or endpoints explicitly set in project or build configuration still need to target the emulator. Commands run without a shell by default; on Windows, `.cmd` and `.bat` commands need `--shell`, which should only be used with trusted arguments.

The CLI can run commands from projects without a `package.json` too. For example, run Python tests with:

```sh
npm exec --yes --package=awesome-emulator-cli -- awesome-emulator run -- python -m pytest
```

The same pattern works with AWS CLI, Go, Java, Rust, and .NET projects. Use `--sdk` when a command needs SDK-specific TLS settings; see the [SDK configuration guide](./docs/sdk-configuration.md).

## Reuse the emulator across commands

Use a named session when setup and tests run as separate commands or CI steps:

```sh
npx awesome-emulator up --session ci-tests --init -- node scripts/seed-emulator.js
npx awesome-emulator exec --session ci-tests -- npm test
npx awesome-emulator down --session ci-tests
```

`--init` runs once after the emulator is healthy. If it fails, `up` stops the container and exits with an error. Initializer output goes to stderr so `up`'s JSON output stays machine-readable. Use `down` in an always-run CI cleanup step to stop the session after failures.

Session metadata is stored under `~/.aws/emulator/sessions/` (Windows: `%USERPROFILE%\.aws\emulator\sessions\`) and contains connection details, not credential values.

## Use from Node.js

Use the API when a test harness needs to control the emulator directly:

```js
import { startEmulator } from "awesome-emulator-cli";

const emulator = await startEmulator({ port: 0, telemetry: "off" });
try {
  console.log(emulator.endpointUrl, emulator.environment);
} finally {
  await emulator.stop();
}
```

Pass an `AbortSignal` as `signal` to cancel image building or startup. For an already-running Node.js process, configure the AWS SDK's HTTPS handler with `emulator.caFile`; `NODE_EXTRA_CA_CERTS` is only read when Node.js starts.

## Local files and telemetry

The emulator stores its config, credentials, and CA certificate under `~/.aws/emulator/<port>/` (Windows: `%USERPROFILE%\.aws\emulator\<port>\`). Resources stay in memory and are removed when the container stops.

Telemetry is on by default. Turn it off for a run with `--telemetry off`. See [AWS Emulator telemetry details](https://docs.aws.amazon.com/emulator/latest/userguide/telemetry.html) for what it collects.

AWS Emulator is for building and testing. Do not use it for production workloads or security testing. See the [official limitations](https://docs.aws.amazon.com/emulator/latest/userguide/) and [security guidance](https://docs.aws.amazon.com/emulator/latest/userguide/security.html).

## License

MIT. See [LICENSE](./LICENSE). This license covers the wrapper; downloaded AWS Emulator binaries retain their own license and notices.

See [CONTRIBUTING.md](./CONTRIBUTING.md) to contribute and [SECURITY.md](./SECURITY.md) to report a vulnerability.
