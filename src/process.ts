import { spawn } from "node:child_process";
import { FORWARDED_SIGNALS, getSignalExitCode, isForwardedSignal, type ForwardedSignal } from "./signals.js";

export function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  shell = false,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: "inherit",
      shell,
      windowsHide: false,
    });
    let receivedSignal: ForwardedSignal | undefined;
    let settled = false;
    const handlers = new Map<ForwardedSignal, () => void>();
    let abortHandler: (() => void) | undefined;
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    };
    const forwardSignal = (signal: ForwardedSignal) => {
      if (receivedSignal) return;
      receivedSignal = signal;
      child.kill(signal);
    };
    for (const signal of FORWARDED_SIGNALS) {
      const handler = () => forwardSignal(signal);
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
    if (signal) {
      abortHandler = () => {
        const reason = signal.reason;
        const abortSignal = isForwardedSignal(reason) ? reason : "SIGTERM";
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
        resolve(getSignalExitCode(receivedSignal));
      } else if (signal) {
        resolve(1);
      } else {
        resolve(code ?? 1);
      }
    });
  });
}
