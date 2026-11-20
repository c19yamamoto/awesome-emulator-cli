import path from "node:path";

export type EmulatorEnvironment = {
  AWS_EMULATOR_STATE_DIR: string;
  AWS_EMULATOR_CA_FILE: string;
  AWS_EMULATOR_TRUSTSTORE_FILE: string;
  AWS_ENDPOINT_URL: string;
  AWS_SHARED_CREDENTIALS_FILE: string;
  AWS_CONFIG_FILE: string;
  AWS_CA_BUNDLE: string;
  AWS_EC2_METADATA_DISABLED: "true";
  AWS_REGION: string;
  AWS_DEFAULT_REGION: string;
  NODE_EXTRA_CA_CERTS: string;
  AWS_DISABLE_HOST_PREFIX_INJECTION: "true";
};

export const SUPPORTED_EMULATOR_SDKS = [
  "java-v2",
  "rust",
  "dotnet",
] as const;

export type EmulatorSdk = typeof SUPPORTED_EMULATOR_SDKS[number];
export const DEFAULT_AWS_REGION = "us-east-1";

export type ChildEnvironmentOptions = {
  sdks?: readonly EmulatorSdk[];
  region?: string;
  platform?: NodeJS.Platform;
};

export type EmulatorConnectionSettings = {
  endpointUrl: string;
  healthCheckUrl: string;
  configFile: string;
  credentialsFile: string;
  caFile: string;
  environment: EmulatorEnvironment;
};

const AWS_CREDENTIAL_ENVIRONMENT_KEYS = [
  "AWS_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SECURITY_TOKEN",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CREDENTIAL_PROFILES_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
  "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS",
  "AWS_ENDPOINT_URL_PREFIX",
  "AWS_ENDPOINT_URL_SUFFIX",
] as const;

const JAVA_OPTION_ENVIRONMENT_KEYS = [
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "JAVA_OPTS",
  "MAVEN_OPTS",
  "GRADLE_OPTS",
  "ANT_OPTS",
  "SBT_OPTS",
] as const;

// npm exec --package exports its selector to children; nested npx must use its own requested package.
const NPM_LAUNCHER_ENVIRONMENT_KEYS = ["npm_config_package"] as const;

const JVM_WIDE_JAVA_OPTION_ENVIRONMENT_KEYS = [
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
] as const;

export function normalizeEmulatorSdks(sdks: readonly string[] = []): EmulatorSdk[] {
  const unsupportedSdk = sdks.find((sdk) => !SUPPORTED_EMULATOR_SDKS.includes(sdk as EmulatorSdk));
  if (unsupportedSdk !== undefined) {
    throw new Error(`Unsupported SDK: ${unsupportedSdk}. Choose from ${SUPPORTED_EMULATOR_SDKS.join(", ")}.`);
  }
  return [...new Set(sdks)] as EmulatorSdk[];
}

export function resolveAwsRegion(region: string | undefined, defaultRegion = DEFAULT_AWS_REGION): string {
  const resolvedRegion = region ?? defaultRegion;
  if (resolvedRegion.trim().length === 0) throw new Error("Region must not be empty.");
  return resolvedRegion;
}

export function createEmulatorConnectionSettings(port: number, stateDirectory: string): EmulatorConnectionSettings {
  const endpointUrl = `https://127.0.0.1:${port}`;
  const portDirectory = path.join(stateDirectory, String(port));
  const environment: EmulatorEnvironment = {
    AWS_EMULATOR_STATE_DIR: stateDirectory,
    AWS_EMULATOR_CA_FILE: path.join(portDirectory, "ca.pem"),
    AWS_EMULATOR_TRUSTSTORE_FILE: path.join(portDirectory, "truststore.p12"),
    AWS_ENDPOINT_URL: endpointUrl,
    AWS_SHARED_CREDENTIALS_FILE: path.join(portDirectory, "emulator_credentials"),
    AWS_CONFIG_FILE: path.join(portDirectory, "config"),
    AWS_CA_BUNDLE: path.join(portDirectory, "ca.pem"),
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_REGION: DEFAULT_AWS_REGION,
    AWS_DEFAULT_REGION: DEFAULT_AWS_REGION,
    NODE_EXTRA_CA_CERTS: path.join(portDirectory, "ca.pem"),
    AWS_DISABLE_HOST_PREFIX_INJECTION: "true",
  };

  return {
    endpointUrl,
    healthCheckUrl: `${endpointUrl}/__admin/health`,
    configFile: environment.AWS_CONFIG_FILE,
    credentialsFile: environment.AWS_SHARED_CREDENTIALS_FILE,
    caFile: environment.AWS_CA_BUNDLE,
    environment,
  };
}

export function createChildEnvironment(
  parentEnvironment: NodeJS.ProcessEnv,
  emulatorEnvironment: EmulatorEnvironment,
  options: ChildEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const { sdks = [], region, platform = process.platform } = options;
  const caseInsensitiveEnvironment = platform === "win32";
  const normalizeName = (name: string): string => caseInsensitiveEnvironment ? name.toUpperCase() : name;
  const childEnvironment: NodeJS.ProcessEnv = { ...parentEnvironment };
  const controlledEnvironmentKeys = new Set([
    ...Object.keys(emulatorEnvironment),
    ...AWS_CREDENTIAL_ENVIRONMENT_KEYS,
    ...NPM_LAUNCHER_ENVIRONMENT_KEYS,
    ...(sdks.includes("rust") || sdks.includes("dotnet") ? ["SSL_CERT_FILE"] : []),
  ].map(normalizeName));
  for (const key of Object.keys(childEnvironment)) {
    const normalizedKey = normalizeName(key);
    if (controlledEnvironmentKeys.has(normalizedKey) || normalizedKey.startsWith("AWS_ENDPOINT_URL_")) {
      delete childEnvironment[key];
    }
  }
  const childRegion = resolveAwsRegion(region, emulatorEnvironment.AWS_REGION);
  Object.assign(childEnvironment, emulatorEnvironment, {
    AWS_REGION: childRegion,
    AWS_DEFAULT_REGION: childRegion,
  });

  if (sdks.includes("java-v2")) {
    const inheritedJavaOptions: string[] = [];
    const inheritedJvmWideOptions: string[] = [];
    for (const name of JAVA_OPTION_ENVIRONMENT_KEYS) {
      const matchingKeys = Object.keys(parentEnvironment)
        .filter((key) => normalizeName(key) === normalizeName(name));
      const values = matchingKeys
        .map((key) => parentEnvironment[key])
        .filter((value): value is string => value !== undefined);
      for (const key of Object.keys(childEnvironment)) {
        if (normalizeName(key) === normalizeName(name)) delete childEnvironment[key];
      }
      if (values.length > 0) {
        const combinedOptions = values.join(" ");
        childEnvironment[name] = combinedOptions;
        inheritedJavaOptions.push(combinedOptions);
        if ((JVM_WIDE_JAVA_OPTION_ENVIRONMENT_KEYS as readonly string[]).includes(name)) {
          inheritedJvmWideOptions.push(combinedOptions);
        }
      }
    }

    const existingOptions = childEnvironment.JAVA_TOOL_OPTIONS;
    rejectJavaAwsOverrides(inheritedJavaOptions);
    const hasConfiguredTrustStore = inheritedJvmWideOptions.some((options) =>
      /(?:^|[\s"'])-Djavax\.net\.ssl\.trustStore(?:=|\s|["'])/.test(options));
    const hasConfiguredTrustStoreType = inheritedJvmWideOptions.some((options) =>
      /(?:^|[\s"'])-Djavax\.net\.ssl\.trustStoreType(?:=|\s|["'])/.test(options));
    const hasIncompatibleTrustStoreTypeWithoutPath = inheritedJavaOptions.some((options) => {
      const hasCustomTrustStore = /(?:^|[\s"'])-Djavax\.net\.ssl\.trustStore(?:=|\s|["'])/.test(options);
      if (hasCustomTrustStore) return false;
      const types = [...options.matchAll(/(?:^|[\s"'])-Djavax\.net\.ssl\.trustStoreType=(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g)]
        .map((match) => match[1] ?? match[2] ?? match[3] ?? "");
      return types.some((type) => type.toUpperCase() !== "PKCS12");
    });
    if (hasIncompatibleTrustStoreTypeWithoutPath) {
      throw new Error("The emulator truststore uses PKCS12. Set javax.net.ssl.trustStoreType=PKCS12 or provide a compatible custom truststore with javax.net.ssl.trustStore.");
    }
    if (hasConfiguredTrustStore) {
      childEnvironment.JAVA_TOOL_OPTIONS = existingOptions;
    } else {
      const trustStore = path.join(path.dirname(emulatorEnvironment.AWS_CA_BUNDLE), "truststore.p12");
      const trustStoreOption = quoteJavaToolOption(`-Djavax.net.ssl.trustStore=${trustStore}`);
      childEnvironment.JAVA_TOOL_OPTIONS = [
        existingOptions?.trim(),
        trustStoreOption,
        hasConfiguredTrustStoreType ? undefined : "-Djavax.net.ssl.trustStoreType=PKCS12",
      ].filter(Boolean).join(" ");
    }
  }

  if (sdks.includes("rust") || sdks.includes("dotnet")) {
    childEnvironment.SSL_CERT_FILE = emulatorEnvironment.AWS_CA_BUNDLE;
  }
  return childEnvironment;
}

function rejectJavaAwsOverrides(options: readonly string[]): void {
  const property = /(?:^|[\s"'])-Daws\.(?:accessKeyId|secretAccessKey|secretKey|sessionToken|profile|webIdentityTokenFile|roleArn|roleSessionName|sharedCredentialsFile|configFile|ignoreConfiguredEndpointUrls|disableEc2Metadata|ec2MetadataServiceEndpointMode|ec2MetadataServiceEndpoint|endpointUrl(?:\.[A-Za-z0-9_-]+|[A-Z][A-Za-z0-9_-]*)?)(?==|\s|["'])/;
  if (options.some((value) => /(?:^|[\s"'])@/.test(value))) {
    throw new Error("Inherited JVM options reference an @argument file, which can hide AWS credential or endpoint overrides. Remove it when using --sdk java-v2.");
  }
  if (options.some((value) => property.test(value))) {
    throw new Error("Inherited JVM options contain an AWS credential, profile, or endpoint override. Remove the aws.* system property so the emulator settings can be used.");
  }
}

function quoteJavaToolOption(option: string): string {
  if (/[\r\n]/.test(option)) throw new Error("Java truststore path cannot contain line breaks.");
  const quote = option.includes('"') ? "'" : '"';
  if (option.includes(quote)) throw new Error("Java truststore path cannot contain both quote characters.");
  return `${quote}${option}${quote}`;
}
