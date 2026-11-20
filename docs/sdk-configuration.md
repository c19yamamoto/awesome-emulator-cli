# SDK configuration

`run`, `exec`, and `up --init` give the child command the emulator endpoint, local credentials and config files, CA settings, and AWS region. The CLI removes inherited credential variables, profiles, and service-specific endpoint variables so host settings do not redirect or authenticate the test. Explicit credentials or endpoints in project code or build configuration must still be configured for the emulator.

The CLI enables `AWS_DISABLE_HOST_PREFIX_INJECTION` for SDKs that might otherwise rewrite the local endpoint.

## TLS settings by SDK

Most SDKs use the standard settings automatically. Pass `--sdk` only when a command needs extra TLS configuration; repeat it to configure multiple SDK families in one command.

| SDK | TLS configuration |
| --- | --- |
| AWS CLI v2, Boto3, AWS SDK for Go v2 | Uses `AWS_CA_BUNDLE` |
| AWS SDK for JavaScript v3 | Uses `NODE_EXTRA_CA_CERTS` |
| AWS SDK for Java 2.x | `--sdk java-v2` adds the emulator truststore to `JAVA_TOOL_OPTIONS` |
| AWS SDK for Rust | `--sdk rust` sets `SSL_CERT_FILE` |
| AWS SDK for .NET | `--sdk dotnet` sets `SSL_CERT_FILE` |

`AWS_CA_BUNDLE` and `SSL_CERT_FILE` replace the default CA bundle for SDKs that read them. If a command must also contact other HTTPS services, provide a combined bundle. `NODE_EXTRA_CA_CERTS` adds the emulator CA to Node.js's default roots.

## Java 2.x

The Java truststore is applied through `JAVA_TOOL_OPTIONS` to every JVM started by the child command, including Maven or Gradle and test workers. Resolve dependencies before running the wrapped command, or use a truststore containing both the emulator certificate and any other roots the build needs. The emulator truststore contains only the emulator certificate, so remote HTTPS calls can fail while it is active.

The CLI preserves an existing `javax.net.ssl.trustStore` in `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS`, or `_JAVA_OPTIONS`. If only `javax.net.ssl.trustStoreType=PKCS12` is set, it adds the emulator truststore and preserves the type. An incompatible truststore type requires a custom truststore path, and that truststore must trust the emulator. `MAVEN_OPTS` and `GRADLE_OPTS` stay in their own variables; check separately configured truststores there.

Java system properties take precedence over environment variables. With `--sdk java-v2`, the CLI checks inherited `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS`, `_JAVA_OPTIONS`, `JAVA_OPTS`, `MAVEN_OPTS`, `GRADLE_OPTS`, `ANT_OPTS`, and `SBT_OPTS` for AWS credential, profile, or endpoint overrides and `@argument-file` references. Explicit settings in project or build files remain the project's responsibility.

## Shell behavior

Child commands run without a shell by default, so arguments are passed as data. On Windows, `.cmd` and `.bat` programs and shell built-ins require `--shell`:

```sh
npx awesome-emulator run --shell -- npm test
```

Use `--shell` only with trusted command and argument values; shell metacharacters are interpreted in this mode.
