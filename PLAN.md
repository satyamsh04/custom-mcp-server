# PLAN.md — Custom MCP Server (Data Annotation Workflow)

> **Repo:** `satyamsh04/custom-mcp-server`
> **Role of this document:** Architecture & execution plan. Authored by the ARCHITECT (Claude). Each task is written to be executed independently by the EXECUTOR (Ollama) with **no additional context required**.
> **Golden rule for the EXECUTOR:** Implement exactly one task at a time, in order. After each task run `npm test`. **Do not start the next task until `npm test` passes for the current one.**

---

## 0. Project Facts (read once, applies to every task)

| Item | Value |
|---|---|
| Language | TypeScript 5.x (`strict: true`) |
| Runtime | Node.js 20 LTS, ESM modules (`"type": "module"`) |
| MCP SDK | `@modelcontextprotocol/sdk` (stdio transport) |
| Cloud | AWS S3 + DynamoDB (`@aws-sdk/client-s3`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`) |
| Messaging | Slack Web API (`@slack/web-api`) |
| Auth | OAuth2 token exchange + JWT validation (`jsonwebtoken`, `jwks-rsa`) |
| Validation | `zod` for all tool input schemas |
| Test | Jest + `ts-jest` + `@types/jest` |
| Mocks | `aws-sdk-client-mock` for AWS, `nock`/manual mocks for Slack/HTTP |
| Cross-cutting | JWT on every call · Rate limit 100 req/min per tool · Retry 3x exponential backoff |
| Tools to build | `s3_upload`, `s3_download`, `dynamo_read`, `dynamo_write`, `slack_notify`, `annotation_status` |

### Conventions every task MUST follow
1. **ESM imports** use `.js` extension in relative paths (e.g. `import { x } from "./foo.js"`) because of `NodeNext` module resolution.
2. Every exported function has an **explicit return type**. No `any`. No `// @ts-ignore`.
3. Each tool exposes a `definition` object (name/description/inputSchema as JSON Schema) and a `handler` function. This is the **interface contract** consumed by `server.ts`.
4. Errors thrown inside handlers are `McpError`-compatible objects `{ code: string; message: string; retryable: boolean }`.
5. Tests live in `tests/` mirroring `src/` paths, suffix `.test.ts`.
6. No network or AWS calls in tests — everything mocked.

---

## 1. Target File Structure (final state)

```
custom-mcp-server/
├── PLAN.md
├── package.json
├── tsconfig.json
├── jest.config.js
├── .env.example
├── .gitignore
├── README.md
├── .cursor/
│   └── mcp.json
├── src/
│   ├── server.ts                # stdio transport entrypoint, tool registration
│   ├── config.ts                # env loading + validation
│   ├── types.ts                 # shared types & interface contracts
│   ├── logger.ts                # structured stderr logger (stdout reserved for MCP)
│   ├── auth/
│   │   └── oauth.ts             # OAuth2 + JWT validation
│   ├── middleware/
│   │   ├── rate-limiter.ts      # 100 req/min per tool
│   │   └── retry.ts             # 3x exponential backoff
│   ├── clients/
│   │   ├── s3-client.ts         # S3 client factory
│   │   ├── dynamo-client.ts     # DynamoDB DocumentClient factory
│   │   └── slack-client.ts      # Slack WebClient factory
│   └── tools/
│       ├── index.ts             # aggregates all tool definitions
│       ├── s3-upload.ts
│       ├── s3-download.ts
│       ├── dynamo-read.ts
│       ├── dynamo-write.ts
│       ├── slack-notify.ts
│       └── annotation-status.ts
└── tests/
    ├── auth/oauth.test.ts
    ├── middleware/rate-limiter.test.ts
    ├── middleware/retry.test.ts
    └── tools/
        ├── s3-upload.test.ts
        ├── s3-download.test.ts
        ├── dynamo-read.test.ts
        ├── dynamo-write.test.ts
        ├── slack-notify.test.ts
        └── annotation-status.test.ts
```

---

## 2. Interface Contracts (shared types — the spine of the project)

These types are defined in `src/types.ts` (Task 1.3) and imported everywhere. Every tool conforms to `ToolModule`.

```ts
// JSON Schema object as accepted by MCP SDK inputSchema
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

// Standard MCP tool result content
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// The auth context produced by oauth.ts and passed to every handler
export interface AuthContext {
  subject: string;        // JWT `sub`
  scopes: string[];       // JWT `scope` split on space
  raw: Record<string, unknown>; // full decoded claims
}

// Each tool file default-exports this shape
export interface ToolModule<TInput = unknown> {
  definition: ToolDefinition;
  // validated input is guaranteed to match the zod schema before handler runs
  handler: (input: TInput, ctx: AuthContext) => Promise<ToolResult>;
}

export interface AppError {
  code: string;        // e.g. "S3_UPLOAD_FAILED"
  message: string;
  retryable: boolean;
}
```

**Contract between modules:**
- `server.ts` → wraps each `handler` with: `validateJwt` (auth) → `rateLimit(toolName)` → `zod.parse(input)` → `withRetry(handler)`.
- `middleware/retry.ts` exposes `withRetry<T>(fn: () => Promise<T>, opts?) => Promise<T>`.
- `middleware/rate-limiter.ts` exposes `checkRateLimit(toolName: string) => void` (throws `AppError` code `RATE_LIMITED` when exceeded).
- `auth/oauth.ts` exposes `validateJwt(token: string) => Promise<AuthContext>`.
- `clients/*` export factory functions returning configured SDK clients; tools import these (never construct SDK clients inline) so tests can mock the module.

---

## 3. Environment Variables (`.env.example`) — credentials flagged ⚠️

Tasks marked ⚠️ require these. The EXECUTOR must NOT hardcode secrets; read via `src/config.ts`.

```dotenv
# ── AWS ⚠️ (required by s3_upload, s3_download, dynamo_read, dynamo_write, annotation_status) ──
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
S3_BUCKET_NAME=annotation-artifacts
DYNAMO_TABLE_NAME=annotation-records

# ── Slack ⚠️ (required by slack_notify, annotation_status) ──
SLACK_BOT_TOKEN=xoxb-...
SLACK_DEFAULT_CHANNEL=#annotations

# ── OAuth2 / JWT ⚠️ (required by auth/oauth.ts, every tool) ──
OAUTH_ISSUER=https://auth.example.com/
OAUTH_AUDIENCE=custom-mcp-server
JWKS_URI=https://auth.example.com/.well-known/jwks.json
# Fallback only for local/dev symmetric verification (optional):
JWT_SECRET=

# ── Server tuning (optional, have defaults) ──
RATE_LIMIT_PER_MIN=100
RETRY_MAX_ATTEMPTS=3
RETRY_BASE_DELAY_MS=200
LOG_LEVEL=info
```

`config.ts` validates presence at startup with `zod` and throws a clear error listing missing keys. In tests these are injected via `process.env` in `beforeEach` or mocked.

---

## 4. Milestones Overview

| Milestone | Theme | Tasks | Gate |
|---|---|---|---|
| **M1** | Scaffold & config | 1.1 – 1.6 | `npm test` runs (even if 0 tests), `tsc --noEmit` clean |
| **M2** | Cross-cutting middleware & auth | 2.1 – 2.3 | unit tests green |
| **M3** | Client factories | 3.1 – 3.3 | typecheck green |
| **M4** | Tools (6) + tests | 4.1 – 4.6 | each tool's tests green before next |
| **M5** | Server wiring & MCP registration | 5.1 – 5.2 | full suite green, server boots over stdio |
| **M6** | Cursor integration & docs | 6.1 – 6.2 | `.cursor/mcp.json` valid, README complete |

---

## MILESTONE 1 — Scaffold & Config

### Task 1.1 — `package.json`
- **File:** `custom-mcp-server/package.json`
- **Action:** Create with ESM config and scripts.
- **Dependencies:** none (first task).
- **Exact content requirements:**
  - `"type": "module"`
  - `scripts`: `"build": "tsc"`, `"start": "node dist/server.js"`, `"dev": "tsc --watch"`, `"typecheck": "tsc --noEmit"`, `"test": "node --experimental-vm-modules node_modules/jest/bin/jest.js"`
  - `dependencies`: `@modelcontextprotocol/sdk`, `@aws-sdk/client-s3`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@slack/web-api`, `jsonwebtoken`, `jwks-rsa`, `zod`, `dotenv`
  - `devDependencies`: `typescript`, `ts-jest`, `jest`, `@types/jest`, `@types/node`, `@types/jsonwebtoken`, `aws-sdk-client-mock`, `aws-sdk-client-mock-jest`
- **Validation:** `npm install` succeeds.

### Task 1.2 — `tsconfig.json`
- **File:** `custom-mcp-server/tsconfig.json`
- **Action:** Strict TS config for Node 20 ESM.
- **Required compilerOptions:** `"target": "ES2022"`, `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"strict": true`, `"esModuleInterop": true`, `"outDir": "dist"`, `"rootDir": ".", "declaration": false`, `"skipLibCheck": true`, `"resolveJsonModule": true`, `"forceConsistentCasingInFileNames": true`, `"noUncheckedIndexedAccess": true`.
- **include:** `["src/**/*.ts", "tests/**/*.ts"]`
- **Validation:** `npx tsc --noEmit` runs with no config errors.

### Task 1.3 — `src/types.ts`
- **File:** `src/types.ts`
- **Action:** Define and export exactly the interfaces in **Section 2** (`JsonSchema`, `ToolDefinition`, `ToolResult`, `AuthContext`, `ToolModule`, `AppError`).
- **Dependencies:** Task 1.2.
- **Output:** No runtime code, types only. `tsc --noEmit` clean.

### Task 1.4 — `src/config.ts`
- **File:** `src/config.ts`
- **Function signatures:**
  ```ts
  export interface AppConfig {
    awsRegion: string;
    s3Bucket: string;
    dynamoTable: string;
    slackBotToken: string;
    slackDefaultChannel: string;
    oauthIssuer: string;
    oauthAudience: string;
    jwksUri: string;
    jwtSecret?: string;
    rateLimitPerMin: number;
    retryMaxAttempts: number;
    retryBaseDelayMs: number;
    logLevel: string;
  }
  export function loadConfig(env?: NodeJS.ProcessEnv): AppConfig;
  ```
- **Behavior:** Use `dotenv/config`; validate with `zod`; throw `Error` listing all missing required keys at once. Numeric envs parsed with sane defaults (`RATE_LIMIT_PER_MIN=100`, `RETRY_MAX_ATTEMPTS=3`, `RETRY_BASE_DELAY_MS=200`).
- **⚠️ Credentials:** reads all `.env` keys in Section 3.
- **Dependencies:** 1.2, `zod`, `dotenv`.

### Task 1.5 — `src/logger.ts`
- **File:** `src/logger.ts`
- **Critical constraint:** MCP uses **stdout** for protocol messages. The logger MUST write only to **stderr**.
- **Function signatures:**
  ```ts
  export type LogLevel = "debug" | "info" | "warn" | "error";
  export function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
  ```
- **Behavior:** JSON line to `process.stderr`. Respect `LOG_LEVEL`.
- **Dependencies:** 1.2.

### Task 1.6 — `jest.config.js`, `.gitignore`, `.env.example`
- **Files:** `jest.config.js`, `.gitignore`, `.env.example`
- **jest.config.js:** `ts-jest` ESM preset:
  ```js
  export default {
    preset: "ts-jest/presets/default-esm",
    testEnvironment: "node",
    extensionsToTreatAsEsm: [".ts"],
    moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
    transform: { "^.+\\.ts$": ["ts-jest", { useESM: true }] },
    testMatch: ["**/tests/**/*.test.ts"]
  };
  ```
- **.gitignore:** `node_modules/`, `dist/`, `.env`, `coverage/`
- **.env.example:** verbatim from Section 3.
- **Gate (M1 complete):** `npm test` exits cleanly reporting "no tests found"; `npx tsc --noEmit` passes.

---

## MILESTONE 2 — Cross-cutting Middleware & Auth

### Task 2.1 — `src/middleware/retry.ts` (+ test)
- **File:** `src/middleware/retry.ts`
- **Function signatures:**
  ```ts
  export interface RetryOptions {
    maxAttempts?: number;   // default from config / 3
    baseDelayMs?: number;   // default 200
    isRetryable?: (err: unknown) => boolean; // default: AppError.retryable === true
  }
  export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T>;
  ```
- **Behavior:** Up to `maxAttempts` attempts. Delay before attempt *n* = `baseDelayMs * 2^(n-1)` (+ optional jitter, deterministic-disable via injectable sleep). Non-retryable errors rethrow immediately. After final failure, rethrow last error.
- **Testability requirement:** Accept an injectable `sleep` (e.g. `opts` hidden param or module-level export) OR use `jest.useFakeTimers()`. Document chosen approach in a comment.
- **Test file:** `tests/middleware/retry.test.ts`
  - succeeds first try → fn called once.
  - fails twice then succeeds → fn called 3 times, returns value.
  - non-retryable error → fn called once, throws.
  - exhausts attempts → throws last error, called `maxAttempts` times.
  - delays follow exponential pattern (assert via fake timers).
- **Gate:** these tests pass.

### Task 2.2 — `src/middleware/rate-limiter.ts` (+ test)
- **File:** `src/middleware/rate-limiter.ts`
- **Function signatures:**
  ```ts
  export interface RateLimiter {
    check(toolName: string): void; // throws AppError {code:"RATE_LIMITED", retryable:true} if over limit
    reset(): void;                 // test helper
  }
  export function createRateLimiter(limitPerMin?: number, now?: () => number): RateLimiter;
  ```
- **Behavior:** Sliding/fixed window of 60_000 ms, **per tool name**, default limit 100. Inject `now()` for deterministic tests.
- **Test file:** `tests/middleware/rate-limiter.test.ts`
  - allows up to `limit` calls within window.
  - throws `RATE_LIMITED` on call `limit+1`.
  - separate tools have independent counters.
  - window advances (via injected `now`) → counter resets.
- **Gate:** tests pass.

### Task 2.3 — `src/auth/oauth.ts` (+ test) ⚠️
- **File:** `src/auth/oauth.ts`
- **Function signatures:**
  ```ts
  export function extractBearerToken(headerOrToken: string): string;
  export async function validateJwt(token: string, deps?: {
    getKey?: (header: unknown) => Promise<string>; // injectable for tests
  }): Promise<AuthContext>;
  ```
- **Behavior:** Verify signature (RS256 via `jwks-rsa` against `JWKS_URI`, fallback HS256 via `JWT_SECRET` when set), validate `iss` == `OAUTH_ISSUER`, `aud` == `OAUTH_AUDIENCE`, and expiry. Map claims → `AuthContext` (`subject` from `sub`, `scopes` from `scope` space-split). Throw `AppError {code:"AUTH_INVALID", retryable:false}` on any failure.
- **⚠️ Env:** `OAUTH_ISSUER`, `OAUTH_AUDIENCE`, `JWKS_URI`, `JWT_SECRET` (optional).
- **Test file:** `tests/auth/oauth.test.ts` — use HS256 + injected `JWT_SECRET` (no network):
  - valid token → returns `AuthContext` with subject & scopes.
  - expired token → throws `AUTH_INVALID`.
  - wrong audience/issuer → throws `AUTH_INVALID`.
  - malformed/missing token → throws.
  - `extractBearerToken` strips `Bearer ` prefix.
- **Gate:** tests pass.

---

## MILESTONE 3 — Client Factories

> Factories isolate SDK construction so tests mock the module, not env. No business logic here.

### Task 3.1 — `src/clients/s3-client.ts` ⚠️
- **Signature:** `export function getS3Client(): S3Client;`
- **Behavior:** Construct `new S3Client({ region })` from config. Memoize a singleton. Re-export `PutObjectCommand`, `GetObjectCommand` for tool use (optional convenience).
- **⚠️ Env:** `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
- **Test:** none required standalone (covered via tool tests with `aws-sdk-client-mock`). Typecheck must pass.

### Task 3.2 — `src/clients/dynamo-client.ts` ⚠️
- **Signature:** `export function getDynamoClient(): DynamoDBDocumentClient;`
- **Behavior:** Wrap `DynamoDBClient` with `DynamoDBDocumentClient.from(...)`. Memoize singleton.
- **⚠️ Env:** AWS keys + `DYNAMO_TABLE_NAME` (table name read by tools, not client).

### Task 3.3 — `src/clients/slack-client.ts` ⚠️
- **Signature:** `export function getSlackClient(): WebClient;`
- **Behavior:** `new WebClient(config.slackBotToken)`. Memoize.
- **⚠️ Env:** `SLACK_BOT_TOKEN`, `SLACK_DEFAULT_CHANNEL`.
- **Gate (M3):** `npx tsc --noEmit` clean.

---

## MILESTONE 4 — Tools (implement + test, one at a time)

> For EVERY tool task the EXECUTOR must: (a) create the tool file exporting `{ definition, handler }` (`ToolModule`), (b) define a matching `zod` schema, (c) create the test file, (d) run `npm test` and confirm green before moving on.
> The JSON Schemas below are **authoritative** — copy them into each tool's `definition.inputSchema`. Build the `zod` schema to match exactly.

### Task 4.1 — `s3_upload`
- **File:** `src/tools/s3-upload.ts` · **Test:** `tests/tools/s3-upload.test.ts`
- **Dependencies:** 3.1 (S3 client), 2.x (used at server layer, not inside tool).
- **Handler signature:** `handler(input: S3UploadInput, ctx: AuthContext): Promise<ToolResult>`
- **Input type:**
  ```ts
  interface S3UploadInput { key: string; contentBase64: string; contentType?: string; bucket?: string; }
  ```
- **JSON Schema (inputSchema):**
  ```json
  {
    "type": "object",
    "properties": {
      "key": { "type": "string", "minLength": 1, "description": "S3 object key/path" },
      "contentBase64": { "type": "string", "minLength": 1, "description": "File contents, base64-encoded" },
      "contentType": { "type": "string", "description": "MIME type, e.g. image/png", "default": "application/octet-stream" },
      "bucket": { "type": "string", "description": "Override default S3 bucket" }
    },
    "required": ["key", "contentBase64"],
    "additionalProperties": false
  }
  ```
- **Behavior:** Decode base64 → `PutObjectCommand` to `bucket ?? config.s3Bucket`. On AWS error throw `AppError {code:"S3_UPLOAD_FAILED", retryable:true}`. Success result text = JSON `{ bucket, key, etag }`.
- **Tests (aws-sdk-client-mock):**
  - mock `PutObjectCommand` resolves → result contains key & etag, `isError` falsy.
  - invalid base64 / missing key → zod validation error (test via schema parse).
  - S3 throws → handler throws `S3_UPLOAD_FAILED` with `retryable:true`.
  - uses override `bucket` when provided.

### Task 4.2 — `s3_download`
- **File:** `src/tools/s3-download.ts` · **Test:** `tests/tools/s3-download.test.ts`
- **Input type:** `interface S3DownloadInput { key: string; bucket?: string; }`
- **JSON Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "key": { "type": "string", "minLength": 1, "description": "S3 object key/path to fetch" },
      "bucket": { "type": "string", "description": "Override default S3 bucket" }
    },
    "required": ["key"],
    "additionalProperties": false
  }
  ```
- **Behavior:** `GetObjectCommand`; stream body → Buffer → base64. Result text = JSON `{ bucket, key, contentBase64, contentType }`. Missing object → `AppError {code:"S3_DOWNLOAD_FAILED", retryable:false}` for `NoSuchKey`, retryable:true for transient.
- **Tests:**
  - mock returns a readable stream → base64 round-trips correctly.
  - `NoSuchKey` → throws `S3_DOWNLOAD_FAILED` `retryable:false`.
  - override bucket honored.

### Task 4.3 — `dynamo_read`
- **File:** `src/tools/dynamo-read.ts` · **Test:** `tests/tools/dynamo-read.test.ts`
- **Input type:** `interface DynamoReadInput { id: string; consistentRead?: boolean; }`
- **JSON Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "id": { "type": "string", "minLength": 1, "description": "Primary key (partition key 'id') of the record" },
      "consistentRead": { "type": "boolean", "default": false, "description": "Use strongly consistent read" }
    },
    "required": ["id"],
    "additionalProperties": false
  }
  ```
- **Behavior:** `GetCommand` on `config.dynamoTable`, key `{ id }`. Found → result text = JSON of item. Not found → result text `{ found: false }`, `isError` falsy. AWS error → `AppError {code:"DYNAMO_READ_FAILED", retryable:true}`.
- **Tests:** item found, item not found, AWS error path, consistentRead flag passed through.

### Task 4.4 — `dynamo_write`
- **File:** `src/tools/dynamo-write.ts` · **Test:** `tests/tools/dynamo-write.test.ts`
- **Input type:** `interface DynamoWriteInput { id: string; attributes: Record<string, unknown>; overwrite?: boolean; }`
- **JSON Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "id": { "type": "string", "minLength": 1, "description": "Primary key 'id' for the record" },
      "attributes": { "type": "object", "description": "Arbitrary attributes to store with the record", "additionalProperties": true },
      "overwrite": { "type": "boolean", "default": true, "description": "If false, fail when item already exists" }
    },
    "required": ["id", "attributes"],
    "additionalProperties": false
  }
  ```
- **Behavior:** `PutCommand` with item `{ id, ...attributes }`. When `overwrite:false` add `ConditionExpression: "attribute_not_exists(id)"`. Conditional failure → `AppError {code:"DYNAMO_CONFLICT", retryable:false}`. Other AWS error → `DYNAMO_WRITE_FAILED` retryable:true. Success text = `{ id, written: true }`.
- **Tests:** successful put; overwrite:false with existing item → conflict; AWS error path; merged item shape asserted via mock call args.

### Task 4.5 — `slack_notify`
- **File:** `src/tools/slack-notify.ts` · **Test:** `tests/tools/slack-notify.test.ts`
- **Dependencies:** 3.3.
- **Input type:** `interface SlackNotifyInput { message: string; channel?: string; threadTs?: string; }`
- **JSON Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "message": { "type": "string", "minLength": 1, "description": "Text to post to Slack" },
      "channel": { "type": "string", "description": "Channel ID or name; defaults to SLACK_DEFAULT_CHANNEL" },
      "threadTs": { "type": "string", "description": "Optional parent message ts to reply in a thread" }
    },
    "required": ["message"],
    "additionalProperties": false
  }
  ```
- **Behavior:** `chat.postMessage({ channel: channel ?? config.slackDefaultChannel, text: message, thread_ts: threadTs })`. Slack `{ ok:false }` or throw → `AppError {code:"SLACK_NOTIFY_FAILED", retryable:true}`. Success text = `{ channel, ts }`.
- **Tests (mock WebClient.chat.postMessage):** success returns ts; default channel used when omitted; `ok:false` response → throws; thread_ts forwarded.

### Task 4.6 — `annotation_status`
- **File:** `src/tools/annotation-status.ts` · **Test:** `tests/tools/annotation-status.test.ts`
- **Dependencies:** 3.2 (Dynamo), 3.3 (Slack, optional notify).
- **Purpose:** Domain tool — read an annotation task's status from DynamoDB and optionally post a status update to Slack.
- **Input type:** `interface AnnotationStatusInput { taskId: string; newStatus?: "pending" | "in_progress" | "completed" | "rejected"; notify?: boolean; }`
- **JSON Schema:**
  ```json
  {
    "type": "object",
    "properties": {
      "taskId": { "type": "string", "minLength": 1, "description": "Annotation task identifier (Dynamo 'id')" },
      "newStatus": { "type": "string", "enum": ["pending", "in_progress", "completed", "rejected"], "description": "If provided, update the task status" },
      "notify": { "type": "boolean", "default": false, "description": "If true, post the status to Slack" }
    },
    "required": ["taskId"],
    "additionalProperties": false
  }
  ```
- **Behavior:**
  1. `GetCommand` task by `taskId`. Not found → `AppError {code:"ANNOTATION_NOT_FOUND", retryable:false}`.
  2. If `newStatus` set → `UpdateCommand` set `status` + `updatedAt` (ISO).
  3. If `notify:true` → `slack_notify` underlying call with summary text.
  4. Result text = JSON `{ taskId, status, updatedAt? }`.
- **Tests:** found read-only; status update path (assert UpdateCommand args); not found → error; notify:true triggers Slack mock; notify defaults off.
- **Gate (M4):** all six tool test files green individually and collectively.

---

## MILESTONE 5 — Server Wiring & MCP Registration

### Task 5.1 — `src/tools/index.ts`
- **File:** `src/tools/index.ts`
- **Signature:** `export const tools: Record<string, ToolModule>;`
- **Behavior:** Import all six tool modules; export a map keyed by `definition.name`. No logic.
- **Dependencies:** Tasks 4.1–4.6.

### Task 5.2 — `src/server.ts`
- **File:** `src/server.ts`
- **Behavior:**
  - Create `Server` from `@modelcontextprotocol/sdk` with stdio transport.
  - Register `ListTools` handler → returns every `definition` from `tools`.
  - Register `CallTool` handler → pipeline per tool call:
    1. Extract bearer token from request meta/`_meta.authorization` → `validateJwt` → `AuthContext`. On failure return MCP error.
    2. `rateLimiter.check(toolName)`.
    3. Look up tool; `zod.parse(arguments)` (validation error → MCP `InvalidParams`).
    4. `withRetry(() => tool.handler(parsedInput, ctx))`.
    5. Return `ToolResult`; map thrown `AppError` to MCP error content with `isError:true`.
  - `main()` connects transport; log "started" to **stderr**; handle SIGINT/SIGTERM graceful shutdown.
- **Dependencies:** all prior tasks.
- **Test:** `tests/server.test.ts` (optional but recommended) — unit-test the call pipeline with a stub tool: asserts auth runs first, rate limit enforced, validation rejects bad input, retry invoked. Mock the transport.
- **Gate (M5):** full `npm test` green; `node dist/server.js` boots without crashing (manual smoke: pipe a `tools/list` JSON-RPC line, expect a response).

---

## MILESTONE 6 — Cursor Integration & Docs

### Task 6.1 — `.cursor/mcp.json`
- **File:** `.cursor/mcp.json`
- **Content:**
  ```json
  {
    "mcpServers": {
      "custom-mcp-server": {
        "command": "node",
        "args": ["dist/server.js"],
        "env": {
          "AWS_REGION": "us-east-1",
          "S3_BUCKET_NAME": "annotation-artifacts",
          "DYNAMO_TABLE_NAME": "annotation-records",
          "SLACK_DEFAULT_CHANNEL": "#annotations",
          "OAUTH_ISSUER": "https://auth.example.com/",
          "OAUTH_AUDIENCE": "custom-mcp-server",
          "JWKS_URI": "https://auth.example.com/.well-known/jwks.json"
        }
      }
    }
  }
  ```
- **Note for EXECUTOR:** Secrets (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SLACK_BOT_TOKEN`, `JWT_SECRET`) are NOT placed here; they come from the user's shell `.env`. Document this.

### Task 6.2 — `README.md`
- **File:** `README.md`
- **Sections:** overview, prerequisites (Node 20), install, env setup (link Section 3 keys), build, test, run, the 6 tools table with input summaries, auth model, rate-limit/retry notes, Cursor setup via `.cursor/mcp.json`.
- **Gate (M6):** docs complete; `npm run build && npm test` both green.

---

## 5. Potential Blockers (flagged for both roles)

| # | Blocker | Impact | Mitigation |
|---|---|---|---|
| B1 | **ESM + Jest + ts-jest** config friction (top failure mode) | Tests won't run | Use exact `jest.config.js` in Task 1.6; run Jest via `node --experimental-vm-modules`; `moduleNameMapper` strips `.js` ext. Validate at M1 before any logic. |
| B2 | **stdout pollution** breaks MCP protocol | Server hangs / client errors | Logger writes **only to stderr** (Task 1.5). No `console.log` anywhere in `src/`. |
| B3 | **AWS credentials absent** in CI/test env | Real calls fail | All AWS calls mocked with `aws-sdk-client-mock`; never hit network in tests. Real creds only at runtime via `.env`. ⚠️ Tasks 3.1–3.3, 4.1–4.4, 4.6. |
| B4 | **JWKS network dependency** in auth tests | Flaky/slow tests | Tests use HS256 + injected `JWT_SECRET`; `getKey` is injectable (Task 2.3). |
| B5 | **S3 GetObject stream → Buffer** in Node 20 | Body type is a stream, base64 conversion subtle | Use `transformToByteArray()` from SDK v3 stream helper or `Readable` collection; cover with stream mock test (Task 4.2). |
| B6 | **`noUncheckedIndexedAccess`** strictness | Compile errors on map/array access | Guard tool lookup (`tools[name]`) with explicit undefined check in server.ts. |
| B7 | **Rate limiter state in stdio process** | Per-process only, resets on restart | Acceptable for single-process MCP; document. In-memory Map keyed by tool. |
| B8 | **Retry wrapping non-idempotent writes** (dynamo_write, slack_notify) | Duplicate side-effects | Only retry on `retryable:true`; conflicts/validation are non-retryable. Consider idempotency keys as future work — note in README. |
| B9 | **MCP SDK version API drift** | Import paths change | Pin `@modelcontextprotocol/sdk` version in package.json; EXECUTOR must not upgrade mid-build. |

---

## 6. Execution Order (linear handoff list for Ollama)

```
1.1 → 1.2 → 1.3 → 1.4 → 1.5 → 1.6        (M1 gate: npm test runs, tsc clean)
2.1 → 2.2 → 2.3                          (M2 gate: middleware/auth tests green)
3.1 → 3.2 → 3.3                          (M3 gate: tsc clean)
4.1 → 4.2 → 4.3 → 4.4 → 4.5 → 4.6        (M4: npm test green after EACH tool)
5.1 → 5.2                                (M5 gate: full suite green + boot smoke test)
6.1 → 6.2                                (M6 gate: build + test green, docs done)
```

**Reminder:** Do not advance a task until `npm test` passes for the current one. Strict TypeScript throughout. Run `npm test` after every change.
```
