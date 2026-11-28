import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  createChildEnvironment,
  createEmulatorConnectionSettings,
  normalizeEmulatorSdks,
} from "../dist/emulator-environment.js";

const emulator = createEmulatorConnectionSettings(9297, "/Users/test user/.aws/emulator");

test("uses the host port for endpoints and the container port for state-file paths", () => {
  const connection = createEmulatorConnectionSettings(54321, "/tmp/emulator-state", 51234);
  assert.equal(connection.endpointUrl, "https://127.0.0.1:54321");
  assert.equal(connection.healthCheckUrl, "https://127.0.0.1:54321/__admin/health");
  assert.equal(connection.caFile, path.join("/tmp/emulator-state", "51234", "ca.pem"));
  assert.equal(connection.credentialsFile, path.join("/tmp/emulator-state", "51234", "emulator_credentials"));
});

test("overrides AWS settings and removes host credentials and endpoints", () => {
  const child = createChildEnvironment({
    AWS_ACCESS_KEY: "host-key-legacy",
    AWS_ACCESS_KEY_ID: "host-key",
    AWS_SECRET_KEY: "host-secret-legacy",
    AWS_SECRET_ACCESS_KEY: "host-secret",
    AWS_SECURITY_TOKEN: "host-security-token",
    AWS_SESSION_TOKEN: "host-session",
    AWS_PROFILE: "production",
    AWS_DEFAULT_PROFILE: "production",
    AWS_CREDENTIAL_PROFILES_FILE: "/host/credentials",
    AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/production",
    AWS_WEB_IDENTITY_TOKEN_FILE: "/host/token",
    AWS_ENDPOINT_URL: "https://aws.example.com",
    AWS_ENDPOINT_URL_DYNAMODB: "https://aws.example.com/dynamodb",
    AWS_ENDPOINT_URL_PREFIX: "https://prefix.example.com",
    AWS_ENDPOINT_URL_SUFFIX: ".example.com",
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
    AWS_EC2_METADATA_SERVICE_ENDPOINT: "http://169.254.169.254:80/host-credentials",
    AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE: "IPv6",
  }, emulator.environment);

  assert.equal(child.AWS_ENDPOINT_URL, emulator.endpointUrl);
  assert.equal(child.AWS_SHARED_CREDENTIALS_FILE, emulator.credentialsFile);
  assert.equal(child.AWS_CONFIG_FILE, emulator.configFile);
  assert.equal(child.AWS_CA_BUNDLE, emulator.caFile);
  assert.equal(child.AWS_EC2_METADATA_DISABLED, "true");
  assert.equal(child.AWS_DISABLE_HOST_PREFIX_INJECTION, "true");
  assert.equal(child.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(child.AWS_ACCESS_KEY, undefined);
  assert.equal(child.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(child.AWS_SECRET_KEY, undefined);
  assert.equal(child.AWS_SECURITY_TOKEN, undefined);
  assert.equal(child.AWS_SESSION_TOKEN, undefined);
  assert.equal(child.AWS_PROFILE, undefined);
  assert.equal(child.AWS_DEFAULT_PROFILE, undefined);
  assert.equal(child.AWS_CREDENTIAL_PROFILES_FILE, undefined);
  assert.equal(child.AWS_ROLE_ARN, undefined);
  assert.equal(child.AWS_WEB_IDENTITY_TOKEN_FILE, undefined);
  assert.equal(child.AWS_ENDPOINT_URL_DYNAMODB, undefined);
  assert.equal(child.AWS_ENDPOINT_URL_PREFIX, undefined);
  assert.equal(child.AWS_ENDPOINT_URL_SUFFIX, undefined);
  assert.equal(child.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS, undefined);
  assert.equal(child.AWS_EC2_METADATA_SERVICE_ENDPOINT, undefined);
  assert.equal(child.AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE, undefined);
});

test("sets both child region variables to us-east-1 by default", () => {
  const child = createChildEnvironment({}, emulator.environment);

  assert.equal(child.AWS_REGION, "us-east-1");
  assert.equal(child.AWS_DEFAULT_REGION, "us-east-1");
});

test("sets both child region variables when an explicit region is provided", () => {
  const child = createChildEnvironment({
    AWS_REGION: "host-region",
    AWS_DEFAULT_REGION: "host-default-region",
  }, emulator.environment, { region: "ap-northeast-1" });

  assert.equal(child.AWS_REGION, "ap-northeast-1");
  assert.equal(child.AWS_DEFAULT_REGION, "ap-northeast-1");
  assert.equal(child.AWS_ENDPOINT_URL, emulator.endpointUrl);
});

test("removes npm exec package selection while preserving user npm registry and proxy settings", () => {
  const child = createChildEnvironment({
    npm_config_package: "awesome-emulator-cli",
    npm_config_registry: "https://registry.example.test/",
    npm_config_proxy: "http://proxy.example.test:8080",
  }, emulator.environment);

  assert.equal(child.npm_config_package, undefined);
  assert.equal(child.npm_config_registry, "https://registry.example.test/");
  assert.equal(child.npm_config_proxy, "http://proxy.example.test:8080");
});

test("filters npm exec package selection case-insensitively on Windows", () => {
  const child = createChildEnvironment({
    NPM_CONFIG_PACKAGE: "awesome-emulator-cli",
    NPM_CONFIG_REGISTRY: "https://registry.example.test/",
  }, emulator.environment, { platform: "win32" });

  assert.equal(child.NPM_CONFIG_PACKAGE, undefined);
  assert.equal(child.NPM_CONFIG_REGISTRY, "https://registry.example.test/");
});

test("rejects an empty child region", () => {
  assert.throws(
    () => createChildEnvironment({}, emulator.environment, { region: "   " }),
    /Region must not be empty/,
  );
});

test("filters case-insensitive AWS and Java environment names on Windows", () => {
  const child = createChildEnvironment({
    aws_access_key_id: "host-key",
    aws_endpoint_url_sts: "https://aws.example.com",
    java_tool_options: "-Xmx1g",
    ssl_cert_file: "/host/certificates.pem",
  }, emulator.environment, { sdks: ["java-v2", "rust"], platform: "win32" });

  assert.equal(child.aws_access_key_id, undefined);
  assert.equal(child.aws_endpoint_url_sts, undefined);
  assert.equal(child.java_tool_options, undefined);
  assert.equal(child.ssl_cert_file, undefined);
  assert.match(child.JAVA_TOOL_OPTIONS, /^-Xmx1g /);
  assert.equal(child.SSL_CERT_FILE, emulator.caFile);
  assert.equal(child.AWS_ENDPOINT_URL, emulator.endpointUrl);
});

test("does not alter Java or OpenSSL settings for an unrelated child", () => {
  const child = createChildEnvironment({
    JAVA_TOOL_OPTIONS: "-Xmx1g -Dcustom.setting=value",
    SSL_CERT_FILE: "/host/certificates.pem",
  }, emulator.environment);

  assert.equal(child.JAVA_TOOL_OPTIONS, "-Xmx1g -Dcustom.setting=value");
  assert.equal(child.SSL_CERT_FILE, "/host/certificates.pem");
});

test("adds the Java truststore while preserving existing JVM options", () => {
  const child = createChildEnvironment({
    JAVA_TOOL_OPTIONS: "-Xmx1g -Dcustom.setting=value",
  }, emulator.environment, { sdks: ["java-v2"] });
  const trustStore = path.join(path.dirname(emulator.caFile), "truststore.p12");

  assert.equal(
    child.JAVA_TOOL_OPTIONS,
    `-Xmx1g -Dcustom.setting=value "-Djavax.net.ssl.trustStore=${trustStore}" -Djavax.net.ssl.trustStoreType=PKCS12`,
  );
  assert.equal(child.SSL_CERT_FILE, undefined);
});

test("quotes truststore paths safely and rejects paths Java cannot represent", () => {
  const doubleQuotePath = createEmulatorConnectionSettings(9297, '/tmp/emulator"state');
  const singleQuotePath = createEmulatorConnectionSettings(9297, "/tmp/emulator'state");
  assert.match(createChildEnvironment({}, doubleQuotePath.environment, { sdks: ["java-v2"] }).JAVA_TOOL_OPTIONS, /'[^']*truststore\.p12'/);
  assert.match(createChildEnvironment({}, singleQuotePath.environment, { sdks: ["java-v2"] }).JAVA_TOOL_OPTIONS, /"[^"]*truststore\.p12"/);

  const newlinePath = createEmulatorConnectionSettings(9297, "/tmp/emulator\nstate");
  assert.throws(() => createChildEnvironment({}, newlinePath.environment, { sdks: ["java-v2"] }), /cannot contain line breaks/);

  const bothQuotePath = createEmulatorConnectionSettings(9297, `/tmp/emulator'"state`);
  assert.throws(() => createChildEnvironment({}, bothQuotePath.environment, { sdks: ["java-v2"] }), /both quote characters/);
});

test("preserves an explicitly configured Java truststore for combined certificate bundles", () => {
  const javaOptions = '-Xmx1g -Djavax.net.ssl.trustStore="/tmp/combined truststore.p12" -Djavax.net.ssl.trustStoreType=PKCS12';
  const child = createChildEnvironment({ JAVA_TOOL_OPTIONS: javaOptions }, emulator.environment, { sdks: ["java-v2"] });

  assert.equal(child.JAVA_TOOL_OPTIONS, javaOptions);
});

test("adds the emulator truststore when only its type is configured", () => {
  const child = createChildEnvironment({
    JDK_JAVA_OPTIONS: "-Xmx1g -Djavax.net.ssl.trustStoreType=PKCS12",
  }, emulator.environment, { sdks: ["java-v2"] });

  assert.match(child.JAVA_TOOL_OPTIONS, /-Djavax\.net\.ssl\.trustStore=.*truststore\.p12/);
  assert.equal(child.JDK_JAVA_OPTIONS, "-Xmx1g -Djavax.net.ssl.trustStoreType=PKCS12");
  assert.doesNotMatch(child.JAVA_TOOL_OPTIONS, /trustStoreType=PKCS12/);
});

test("rejects an incompatible Java truststore type without a custom truststore", () => {
  assert.throws(
    () => createChildEnvironment({ JAVA_TOOL_OPTIONS: "-Djavax.net.ssl.trustStoreType=JKS" }, emulator.environment, { sdks: ["java-v2"] }),
    /emulator truststore uses PKCS12/,
  );
});

test("rejects Java system properties that can override emulator credentials or endpoints", () => {
  for (const property of [
    { JAVA_TOOL_OPTIONS: "-Daws.accessKeyId=host-key" },
    { JDK_JAVA_OPTIONS: "-Daws.profile=production" },
    { _JAVA_OPTIONS: "-Daws.endpointUrl.sts=https://aws.example.com" },
    { MAVEN_OPTS: "-Daws.sharedCredentialsFile=/host/credentials" },
    { GRADLE_OPTS: "-Daws.endpointUrl=https://aws.example.com" },
    { JAVA_OPTS: "-Daws.accessKeyId=host-key" },
    { ANT_OPTS: "-Daws.profile=production" },
    { SBT_OPTS: "-Daws.endpointUrl=https://aws.example.com" },
  ]) {
    assert.throws(
      () => createChildEnvironment(property, emulator.environment, { sdks: ["java-v2"] }),
      /Inherited JVM options contain an AWS credential, profile, or endpoint override/,
    );
  }

  assert.throws(
    () => createChildEnvironment({ java_tool_options: "-Daws.secretAccessKey=host-secret" }, emulator.environment, { sdks: ["java-v2"], platform: "win32" }),
    /Inherited JVM options contain an AWS credential, profile, or endpoint override/,
  );

  assert.throws(
    () => createChildEnvironment({ JDK_JAVA_OPTIONS: "@/tmp/aws-options.txt" }, emulator.environment, { sdks: ["java-v2"] }),
    /reference an @argument file/,
  );
});

test("keeps build-tool JVM options in their own variables", () => {
  const mavenOptions = "-Xmx1g -Djavax.net.ssl.trustStore=/tmp/maven-truststore.p12";
  const child = createChildEnvironment({ MAVEN_OPTS: mavenOptions }, emulator.environment, { sdks: ["java-v2"] });

  assert.equal(child.MAVEN_OPTS, mavenOptions);
  assert.match(child.JAVA_TOOL_OPTIONS, /truststore\.p12/);
  assert.doesNotMatch(child.JAVA_TOOL_OPTIONS, /maven-truststore|Xmx1g/);
});

test("rejects an incompatible truststore type from build-tool options", () => {
  assert.throws(
    () => createChildEnvironment({ GRADLE_OPTS: "-Djavax.net.ssl.trustStoreType=JKS" }, emulator.environment, { sdks: ["java-v2"] }),
    /emulator truststore uses PKCS12/,
  );
});

test("sets SSL_CERT_FILE only for Rust or .NET and combines SDK selections", () => {
  for (const sdk of ["rust", "dotnet"]) {
    const child = createChildEnvironment({}, emulator.environment, { sdks: [sdk] });
    assert.equal(child.SSL_CERT_FILE, emulator.caFile);
    assert.equal(child.JAVA_TOOL_OPTIONS, undefined);
  }

  const combined = createChildEnvironment({}, emulator.environment, { sdks: ["java-v2", "rust"] });
  assert.equal(combined.SSL_CERT_FILE, emulator.caFile);
  assert.match(combined.JAVA_TOOL_OPTIONS, /truststore\.p12/);
});

test("normalizes SDK selections and rejects unsupported names", () => {
  assert.deepEqual(normalizeEmulatorSdks(["rust", "java-v2", "rust"]), ["rust", "java-v2"]);
  assert.throws(() => normalizeEmulatorSdks(["unknown"]), /Unsupported SDK: unknown/);
  assert.throws(() => normalizeEmulatorSdks([""]), /Unsupported SDK: /);
});
