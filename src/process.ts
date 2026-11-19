import { spawn } from "node:child_process";

const signalExitCodes: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
      windowsHide: false,
    });
    let receivedSignal: NodeJS.Signals | undefined;
    let settled = false;
    const handlers = new Map<NodeJS.Signals, () => void>();
    let abortHandler: (() => void) | undefined;
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    };
    const forwardSignal = (signal: NodeJS.Signals) => {
      if (receivedSignal) return;
      receivedSignal = signal;
      child.kill(signal);
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const handler = () => forwardSignal(signal);
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
    if (signal) {
      abortHandler = () => {
        const reason = signal.reason;
        const abortSignal = reason === "SIGINT" || reason === "SIGTERM" || reason === "SIGHUP" ? reason : "SIGTERM";
        forwardSignal(abortSignal);
      };
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (receivedSignal) {
        resolve(signalExitCodes[receivedSignal] ?? 1);
      } else if (signal) {
        resolve(1);
      } else {
        resolve(code ?? 1);
      }
    });
  });
}
