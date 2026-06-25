import jwt, { type JwtHeader, type JwtPayload } from "jsonwebtoken";
import { JwksClient } from "jwks-rsa";
import type { AuthContext } from "../types.js";
import { createAppError } from "../errors.js";

export interface ValidateJwtDeps {
  // Injectable for tests so the JWKS network call can be avoided.
  getKey?: (header: JwtHeader) => Promise<string>;
}

// Strips an optional "Bearer " prefix and returns the bare token.
export function extractBearerToken(headerOrToken: string): string {
  const trimmed = headerOrToken.trim();
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  return match && match[1] !== undefined ? match[1].trim() : trimmed;
}

function defaultGetKey(jwksUri: string): (header: JwtHeader) => Promise<string> {
  const client = new JwksClient({ jwksUri });
  return async (header: JwtHeader): Promise<string> => {
    const signingKey = await client.getSigningKey(header.kid);
    return signingKey.getPublicKey();
  };
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
  const secret = process.env.JWT_SECRET;

  if (issuer === undefined || audience === undefined) {
    throw createAppError(
      "AUTH_INVALID",
      "OAUTH_ISSUER and OAUTH_AUDIENCE must be configured",
      false,
    );
  }

  try {
    const decoded = jwt.decode(token, { complete: true });
    if (decoded === null || typeof decoded === "string") {
      throw new Error("malformed token");
    }

    const alg = decoded.header.alg;
    let claims: JwtPayload;

    if (secret !== undefined && secret !== "" && alg.startsWith("HS")) {
      claims = jwt.verify(token, secret, {
        issuer,
        audience,
        algorithms: ["HS256"],
      }) as JwtPayload;
    } else {
      if (jwksUri === undefined || jwksUri === "") {
        throw new Error("JWKS_URI must be configured for RS256 verification");
      }
      const getKey = deps?.getKey ?? defaultGetKey(jwksUri);
      const publicKey = await getKey(decoded.header);
      claims = jwt.verify(token, publicKey, {
        issuer,
        audience,
        algorithms: ["RS256"],
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
