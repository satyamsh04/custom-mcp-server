import { createAppError } from "./errors.js";
import type { AuthContext } from "./types.js";

// Attribute used to record the owning principal on every DynamoDB item.
export const OWNER_ATTR = "owner";

// Maximum object size handled in-memory for S3 up/download (10 MiB).
// Prevents memory-exhaustion DoS from oversized payloads.
export const MAX_OBJECT_BYTES = 10 * 1024 * 1024;

// Maximum serialized size of a DynamoDB item. DynamoDB's hard limit is 400 KB;
// we cap below that to leave headroom and bound per-request work.
export const MAX_ITEM_BYTES = 350 * 1024;

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

// Escapes the three characters Slack treats as markup control characters and
// neutralizes broadcast mentions. Escaping (rather than deleting) `<`/`>`
// preserves character balance and, critically, prevents `<URL|label>` link
// injection (e.g. `<javascript:...|click me>`) because the angle brackets can
// no longer open a Slack link. `&` is escaped first to avoid double-encoding.
export function sanitizeSlackText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@(channel|here|everyone)/gi, "@\u200b$1");
}
