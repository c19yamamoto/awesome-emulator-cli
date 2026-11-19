import path from "node:path";

export type EmulatorEnvironment = {
  AWS_ENDPOINT_URL: string;
  AWS_SHARED_CREDENTIALS_FILE: string;
  AWS_CONFIG_FILE: string;
  AWS_CA_BUNDLE: string;
  AWS_EC2_METADATA_DISABLED: "true";
  AWS_REGION: string;
  AWS_DEFAULT_REGION: string;
  NODE_EXTRA_CA_CERTS: string;
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
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS",
] as const;

export function createEmulatorConnectionSettings(port: number, stateDirectory: string): EmulatorConnectionSettings {
  const endpointUrl = `https://127.0.0.1:${port}`;
  const portDirectory = path.join(stateDirectory, String(port));
  const environment: EmulatorEnvironment = {
    AWS_ENDPOINT_URL: endpointUrl,
    AWS_SHARED_CREDENTIALS_FILE: path.join(portDirectory, "emulator_credentials"),
    AWS_CONFIG_FILE: path.join(portDirectory, "config"),
    AWS_CA_BUNDLE: path.join(portDirectory, "ca.pem"),
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_REGION: "us-east-1",
    AWS_DEFAULT_REGION: "us-east-1",
    NODE_EXTRA_CA_CERTS: path.join(portDirectory, "ca.pem"),
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
): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = { ...parentEnvironment, ...emulatorEnvironment };
  for (const key of AWS_CREDENTIAL_ENVIRONMENT_KEYS) delete childEnvironment[key];
  for (const key of Object.keys(childEnvironment)) {
    if (key.startsWith("AWS_ENDPOINT_URL_")) delete childEnvironment[key];
  }
  return childEnvironment;
}
