import jwt from "jsonwebtoken";
import { extractBearerToken, validateJwt } from "../../src/auth/oauth.js";
import { isAppError } from "../../src/errors.js";

const SECRET = "test-secret-at-least-32-characters-long";
const ISSUER = "https://auth.example.com/";
const AUDIENCE = "custom-mcp-server";

function signToken(
  payload: Record<string, unknown>,
  overrides?: jwt.SignOptions,
): string {
  return jwt.sign(payload, SECRET, {
    algorithm: "HS256",
    issuer: ISSUER,
    audience: AUDIENCE,
    subject: "user-123",
    expiresIn: "1h",
    ...overrides,
  });
}

describe("extractBearerToken", () => {
  it("strips the Bearer prefix", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("returns the token unchanged when no prefix", () => {
    expect(extractBearerToken("abc.def.ghi")).toBe("abc.def.ghi");
  });
});

describe("validateJwt", () => {
  beforeEach(() => {
    process.env.OAUTH_ISSUER = ISSUER;
    process.env.OAUTH_AUDIENCE = AUDIENCE;
    process.env.JWT_SECRET = SECRET;
    process.env.JWKS_URI = "https://auth.example.com/.well-known/jwks.json";
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it("returns an AuthContext for a valid token", async () => {
    const token = signToken({ scope: "read write" });
    const ctx = await validateJwt(token);
    expect(ctx.subject).toBe("user-123");
    expect(ctx.scopes).toEqual(["read", "write"]);
    expect(ctx.raw.iss).toBe(ISSUER);
  });

  it("throws AUTH_INVALID for an expired token", async () => {
    const token = signToken({}, { expiresIn: -10 });
    await expect(validateJwt(token)).rejects.toMatchObject({
      code: "AUTH_INVALID",
    });
  });

  it("throws AUTH_INVALID for a wrong audience", async () => {
    const token = signToken({}, { audience: "someone-else" });
    try {
      await validateJwt(token);
      fail("expected AUTH_INVALID");
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) {
        expect(err.code).toBe("AUTH_INVALID");
        expect(err.retryable).toBe(false);
      }
    }
  });

  it("throws AUTH_INVALID for a wrong issuer", async () => {
    const token = signToken({}, { issuer: "https://evil.example.com/" });
    await expect(validateJwt(token)).rejects.toMatchObject({
      code: "AUTH_INVALID",
    });
  });

  it("throws AUTH_INVALID for a malformed token", async () => {
    await expect(validateJwt("not-a-jwt")).rejects.toMatchObject({
      code: "AUTH_INVALID",
    });
  });

  it("rejects a token whose alg does not match the pinned algorithm", async () => {
    // Secret is configured → HS256 is pinned; an HS384 token must be refused.
    const token = signToken({}, { algorithm: "HS384" });
    await expect(validateJwt(token)).rejects.toMatchObject({
      code: "AUTH_INVALID",
    });
  });

  it("rejects a symmetric secret shorter than 32 characters", async () => {
    process.env.JWT_SECRET = "too-short";
    const token = signToken({});
    await expect(validateJwt(token)).rejects.toMatchObject({
      code: "AUTH_INVALID",
    });
  });

  it("refuses HS256 (JWT_SECRET) in production", async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const token = signToken({});
    try {
      await expect(validateJwt(token)).rejects.toMatchObject({
        code: "AUTH_INVALID",
      });
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});
