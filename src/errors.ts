import type { AppError } from "./types.js";

// Error subclass that carries the AppError contract { code, message, retryable }.
// Handlers throw this; retry/server inspect `retryable` to decide flow.
export class AppErrorException extends Error implements AppError {
  public readonly code: string;
  public readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "AppErrorException";
    this.code = code;
    this.retryable = retryable;
    Object.setPrototypeOf(this, AppErrorException.prototype);
  }
}

export function createAppError(
  code: string,
  message: string,
  retryable: boolean,
): AppErrorException {
  return new AppErrorException(code, message, retryable);
}

export function isAppError(err: unknown): err is AppError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "message" in err &&
    "retryable" in err &&
    typeof (err as Record<string, unknown>).retryable === "boolean"
  );
}
