export const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];

const SIGNAL_EXIT_CODES: Record<ForwardedSignal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export function isForwardedSignal(value: unknown): value is ForwardedSignal {
  return typeof value === "string" && Object.hasOwn(SIGNAL_EXIT_CODES, value);
}

export function getSignalExitCode(value: unknown): number {
  return isForwardedSignal(value) ? SIGNAL_EXIT_CODES[value] : 1;
}
