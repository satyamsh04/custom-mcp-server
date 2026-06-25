import { createAppError } from "./errors.js";
import type { AuthContext } from "./types.js";

// Attribute used to record the owning principal on every DynamoDB item.
export const OWNER_ATTR = "owner";

// Maximum object size handled in-memory for S3 up/download (10 MiB).
// Prevents memory-exhaustion DoS from oversized payloads.
export const MAX_OBJECT_BYTES = 10 * 1024 * 1024;

// Throws FORBIDDEN unless the caller holds every required scope.
export function assertScopes(ctx: AuthContext, required: string[]): void {
  const missing = required.filter((s) => !ctx.scopes.includes(s));
  if (missing.length > 0) {
    throw createAppError(
      "FORBIDDEN",
      `missing required scope(s): ${missing.join(", ")}`,
      false,
    );
  }
}

// Normalizes a caller-supplied S3 key and rejects traversal/abuse patterns.
// S3 is a flat keyspace, but unconstrained keys allow clobbering arbitrary
// objects, so we forbid absolute paths, parent refs, backslashes, and control
// characters.
export function sanitizeObjectKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw createAppError("INVALID_PARAMS", "key must not be empty", false);
  }
  if (
    trimmed.startsWith("/") ||
    trimmed.includes("..") ||
    trimmed.includes("\\") ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(trimmed)
  ) {
    throw createAppError("INVALID_PARAMS", "key contains illegal characters", false);
  }
  return trimmed;
}

// Confines a caller to their own S3 prefix: "<subject>/<key>".
export function scopedObjectKey(ctx: AuthContext, key: string): string {
  return `${ctx.subject}/${sanitizeObjectKey(key)}`;
}

// Strips Slack control characters and neutralizes broadcast mentions so
// user-supplied text cannot inject formatting or @channel/@here pings.
export function sanitizeSlackText(text: string): string {
  return text
    .replace(/[<>]/g, "")
    .replace(/@(channel|here|everyone)/gi, "@\u200b$1");
}
