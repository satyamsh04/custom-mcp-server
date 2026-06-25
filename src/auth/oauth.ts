import jwt, { type JwtHeader, type JwtPayload } from "jsonwebtoken";
import { JwksClient } from "jwks-rsa";
import type { AuthContext } from "../types.js";
import { createAppError } from "../errors.js";

export interface ValidateJwtDeps {
  // Injectable for tests so the JWKS network call can be avoided.
  getKey?: (header: JwtHeader) => Promise<string>;
}

// Minimum length for a symmetric (HS256) secret to be accepted.
const MIN_SECRET_LENGTH = 32;
// Allowed clock skew (seconds) when validating exp/nbf.
const CLOCK_TOLERANCE_SEC = 5;

// Strips an optional "Bearer " prefix and returns the bare token.
export function extractBearerToken(headerOrToken: string): string {
  const trimmed = headerOrToken.trim();
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  return match && match[1] !== undefined ? match[1].trim() : trimmed;
}

// Single cached JWKS client per URI. Caching + rate limiting avoid a network
// round-trip (and IdP DoS amplification) on every token verification.
const jwksClients = new Map<string, JwksClient>();

function defaultGetKey(jwksUri: string): (header: JwtHeader) => Promise<string> {
  let client = jwksClients.get(jwksUri);
  if (client === undefined) {
    client = new JwksClient({
      jwksUri,
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 10 * 60 * 1000,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
    });
    jwksClients.set(jwksUri, client);
  }
  const resolved = client;
  return async (header: JwtHeader): Promise<string> => {
    const signingKey = await resolved.getSigningKey(header.kid);
    return signingKey.getPublicKey();
  };
}

// Decides whether symmetric (HS256) verification is permitted. HS256 is a
// dev/local convenience only and is refused entirely in production.
function symmetricSecret(): string | undefined {
  const secret = process.env.JWT_SECRET;
  if (secret === undefined || secret === "") return undefined;
  if (process.env.NODE_ENV === "production") {
    throw createAppError(
      "AUTH_INVALID",
      "HS256 (JWT_SECRET) is not permitted in production; use JWKS/RS256",
      false,
    );
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw createAppError(
      "AUTH_INVALID",
      `JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
      false,
    );
  }
  return secret;
}

function toScopes(scope: unknown): string[] {
  if (typeof scope === "string" && scope.length > 0) {
    return scope.split(" ").filter((s) => s.length > 0);
  }
  if (Array.isArray(scope)) {
    return scope.filter((s): s is string => typeof s === "string");
  }
  return [];
}

// Verifies a JWT (RS256 via JWKS, or HS256 fallback when JWT_SECRET is set),
// validates issuer/audience/expiry, and maps claims to an AuthContext.
export async function validateJwt(
  token: string,
  deps?: ValidateJwtDeps,
): Promise<AuthContext> {
  const issuer = process.env.OAUTH_ISSUER;
  const audience = process.env.OAUTH_AUDIENCE;
  const jwksUri = process.env.JWKS_URI;

  if (issuer === undefined || audience === undefined) {
    throw createAppError(
      "AUTH_INVALID",
      "OAUTH_ISSUER and OAUTH_AUDIENCE must be configured",
      false,
    );
  }

  // Pin the expected algorithm from server configuration, NOT from the token
  // header. This prevents algorithm-confusion/downgrade: an attacker cannot
  // force HS256 by setting the header, and `alg: none` is rejected outright.
  const secret = symmetricSecret();
  const expectedAlg: "HS256" | "RS256" = secret !== undefined ? "HS256" : "RS256";

  try {
    const decoded = jwt.decode(token, { complete: true });
    if (decoded === null || typeof decoded === "string") {
      throw new Error("malformed token");
    }

    if (decoded.header.alg !== expectedAlg) {
      throw new Error(`unexpected token algorithm "${decoded.header.alg}"`);
    }

    let claims: JwtPayload;

    if (expectedAlg === "HS256" && secret !== undefined) {
      claims = jwt.verify(token, secret, {
        issuer,
        audience,
        algorithms: ["HS256"],
        clockTolerance: CLOCK_TOLERANCE_SEC,
      }) as JwtPayload;
    } else {
      // Defensive: config.ts already requires JWKS_URI, but oauth reads
      // process.env directly (it is not wired through loadConfig), so we
      // re-check here rather than assume the validated config ran.
      if (jwksUri === undefined || jwksUri === "") {
        throw new Error("JWKS_URI must be configured for RS256 verification");
      }
      const getKey = deps?.getKey ?? defaultGetKey(jwksUri);
      const publicKey = await getKey(decoded.header);
      claims = jwt.verify(token, publicKey, {
        issuer,
        audience,
        algorithms: ["RS256"],
        clockTolerance: CLOCK_TOLERANCE_SEC,
      }) as JwtPayload;
    }

    const subject = typeof claims.sub === "string" ? claims.sub : "";
    if (subject === "") {
      throw new Error("token missing sub claim");
    }

    return {
      subject,
      scopes: toScopes(claims.scope),
      raw: claims as Record<string, unknown>,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid token";
    throw createAppError("AUTH_INVALID", message, false);
  }
}
