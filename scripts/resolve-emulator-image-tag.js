import { createEmulatorDockerfile, createEmulatorImageTag, getArchitecture } from "../dist/emulator-image.js";
import { resolveEmulatorOptions } from "../dist/emulator-options.js";

const { version } = resolveEmulatorOptions({});
const imageTag = createEmulatorImageTag(version, getArchitecture(), createEmulatorDockerfile());
console.log(imageTag);
