import { readFile } from "node:fs/promises";

export type EmulatorCredentialEnvironment = {
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_SESSION_TOKEN?: string;
};

export async function readEmulatorCredentialEnvironment(credentialsFile: string): Promise<EmulatorCredentialEnvironment> {
  const contents = await readFile(credentialsFile, "utf8");
  const credentials: Record<string, string> = {};
  let inDefaultProfile = false;

  for (const rawLine of contents.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;

    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      inDefaultProfile = section[1].trim().toLowerCase() === "default";
      continue;
    }
    if (!inDefaultProfile) continue;

    const entry = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (!entry) continue;
    const key = entry[1].trim().toLowerCase();
    if (["aws_access_key_id", "aws_secret_access_key", "aws_session_token"].includes(key)) {
      credentials[key] = entry[2].trim();
    }
  }

  const accessKeyId = credentials.aws_access_key_id;
  const secretAccessKey = credentials.aws_secret_access_key;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("The Emulator credentials file does not contain a usable [default] access key and secret key.");
  }

  return {
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    ...(credentials.aws_session_token ? { AWS_SESSION_TOKEN: credentials.aws_session_token } : {}),
  };
}
