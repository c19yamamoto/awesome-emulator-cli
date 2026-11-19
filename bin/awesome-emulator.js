#!/usr/bin/env node

import("../dist/cli.js").catch((error) => {
  console.error(`awesome-emulator: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
