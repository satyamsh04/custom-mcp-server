# custom-mcp-server

A production [Model Context Protocol](https://modelcontextprotocol.io) server for a
data-annotation workflow. It exposes six tools over the MCP stdio transport,
backed by AWS S3 + DynamoDB and Slack, with JWT auth, per-tool rate limiting,
and exponential-backoff retries.

## Prerequisites

- Node.js 20 LTS
- npm
- AWS account (S3 bucket + DynamoDB table) and a Slack bot token for runtime use
  (not required to run the test suite — all external calls are mocked)

## Install

```bash
npm install
```

## Environment setup

Copy `.env.example` to `.env` and fill in the values. Keys:

| Key | Required by | Notes |
|---|---|---|
| `AWS_REGION` | all AWS tools | e.g. `us-east-1` |
| `AWS_ACCESS_KEY_ID` | all AWS tools | secret — keep out of source control |
| `AWS_SECRET_ACCESS_KEY` | all AWS tools | secret |
| `S3_BUCKET_NAME` | `s3_upload`, `s3_download` | default bucket |
| `DYNAMO_TABLE_NAME` | `dynamo_read/write`, `annotation_status` | table with partition key `id` |
| `SLACK_BOT_TOKEN` | `slack_notify`, `annotation_status` | secret, `xoxb-...` |
| `SLACK_DEFAULT_CHANNEL` | `slack_notify`, `annotation_status` | e.g. `#annotations` |
| `OAUTH_ISSUER` | auth (every call) | expected `iss` claim |
| `OAUTH_AUDIENCE` | auth (every call) | expected `aud` claim |
| `JWKS_URI` | auth (RS256) | JWKS endpoint for signature verification |
| `JWT_SECRET` | auth (HS256, dev only) | optional; **≥ 32 chars**; refused when `NODE_ENV=production` |
| `NODE_ENV` | auth | set to `production` to force RS256/JWKS and forbid HS256 |
| `RATE_LIMIT_PER_MIN` | rate limiter | default `100` |
| `RETRY_MAX_ATTEMPTS` | retry | default `3` |
| `RETRY_BASE_DELAY_MS` | retry | default `200` |
| `LOG_LEVEL` | logger | `debug`/`info`/`warn`/`error`, default `info` |

## Build / test / run

```bash
npm run build       # compile TypeScript to dist/
npm run typecheck   # tsc --noEmit
npm test            # Jest (ESM) — all external calls mocked
npm start           # node dist/server.js (stdio transport)
```

## Tools

| Tool | Input (required**) | Required scope | Behavior |
|---|---|---|---|
| `s3_upload` | `key`**, `contentBase64`**, `contentType?` | `s3:write` | Upload base64 content to S3 under the caller's prefix; returns `{ bucket, key, etag }` |
| `s3_download` | `key`** | `s3:read` | Download object from the caller's prefix; returns `{ bucket, key, contentBase64, contentType }` |
| `dynamo_read` | `id`**, `consistentRead?` | `dynamo:read` | Read a record the caller owns; returns the item (without `owner`) or `{ found: false }` |
| `dynamo_write` | `id`**, `attributes`**, `overwrite?` | `dynamo:write` | Put a record stamped with the caller as `owner`; can only overwrite records the caller owns |
| `slack_notify` | `message`**, `channel?`, `threadTs?` | `slack:write` | Post to Slack (text sanitized); returns `{ channel, ts }` |
| `annotation_status` | `taskId`**, `newStatus?`, `notify?` | `annotation:read` (+ `annotation:write` to update) | Read/update a task the caller owns, optionally notify Slack |

## Auth model

Every tool call is authenticated **and authorized**:

- **Authentication.** The caller supplies a JWT via `_meta.authorization`
  (optionally `Bearer`-prefixed). The expected algorithm is pinned from server
  configuration — **not** the token header — to block algorithm-confusion
  attacks: RS256 (verified against `JWKS_URI`) by default, or HS256 only when a
  `JWT_SECRET` (≥ 32 chars) is set and `NODE_ENV` is not `production`. The
  server checks `iss`/`aud`/expiry (with a small clock skew) and derives an
  `AuthContext` (`subject`, `scopes`). Invalid tokens → `AUTH_INVALID`.
- **Scope authorization.** Each tool declares `requiredScopes`. A token missing
  a required scope is rejected with `FORBIDDEN` before the handler runs.
- **Object-level authorization (ownership).** DynamoDB records carry an `owner`
  attribute and S3 keys are confined to a per-subject prefix (`<subject>/…`).
  Callers can only read/update their own records and objects; foreign records
  are reported as not-found to avoid ID enumeration. This prevents IDOR.
- **Error handling.** Callers receive only a stable error `code` plus a
  `requestId`; full error detail is logged server-side (stderr) and never
  leaked to the client.

> JWKS keys are fetched through a cached, rate-limited client to avoid a network
> round-trip (and IdP DoS) on every verification. S3 up/downloads are capped at
> 10 MiB to bound memory use.

## Rate limiting & retries

- **Rate limit:** 100 requests/min per principal+tool (configurable), in-memory
  per process, keyed by `subject:tool` so one caller cannot starve others.
  Unknown tool names are rejected before consuming limiter budget. Exceeding it
  yields `RATE_LIMITED`.
- **Retry:** transient failures (`retryable: true`) are retried up to 3 times
  with exponential backoff (`baseDelay * 2^(n-1)`). Conflicts, validation, and
  auth errors are never retried.
- **Idempotency note:** retries wrap non-idempotent writes (`dynamo_write`,
  `slack_notify`). Only transient errors are retried, but adding idempotency
  keys is recommended future work.

## Cursor setup

`.cursor/mcp.json` registers the server with Cursor:

```json
{
  "mcpServers": {
    "custom-mcp-server": {
      "command": "node",
      "args": ["dist/server.js"],
      "env": { "AWS_REGION": "us-east-1", "...": "..." }
    }
  }
}
```

Secrets (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SLACK_BOT_TOKEN`,
`JWT_SECRET`) are **not** placed in `mcp.json`; provide them via your shell
environment / `.env`. Run `npm run build` before launching so `dist/server.js`
exists.

## Architecture

See [`PLAN.md`](./PLAN.md) for the full milestone plan, interface contracts, and
blocker analysis. Source layout:

```
src/
  server.ts            stdio transport + tool-call pipeline
  config.ts            env loading + validation (zod)
  types.ts             shared interface contracts
  errors.ts            AppError exception + guards
  security.ts          scopes, ownership, key-scoping & sanitization helpers
  logger.ts            stderr-only structured logger
  auth/oauth.ts        JWT validation (algorithm-pinned) + cached JWKS
  middleware/          retry.ts, rate-limiter.ts
  clients/             s3/dynamo/slack factories
  tools/               one file per tool + index.ts
```
