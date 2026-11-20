import { createEmulatorDockerfile, createEmulatorImageTag, getArchitecture } from "../dist/emulator-image.js";
import { DEFAULT_VERSION } from "../dist/emulator-options.js";

const version = process.env.AWS_EMULATOR_VERSION ?? DEFAULT_VERSION;
const imageTag = createEmulatorImageTag(version, getArchitecture(), createEmulatorDockerfile());
console.log(imageTag);
