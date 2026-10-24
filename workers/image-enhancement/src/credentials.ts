import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { EnhancementError } from "./contracts.js";
import type { AuthenticatedClient, EnhancementStore } from "./store.js";

export type CredentialIdentity = Readonly<{
  clientId: string;
  credentialId: string;
  version: number;
}>;
export type IssuedCredential = CredentialIdentity & Readonly<{ key: string }>;

function digest(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

export function credentialDigestsMatch(candidate: string, stored?: string) {
  const candidateBytes = Buffer.from(candidate, "hex");
  const storedBytes = stored ? Buffer.from(stored, "hex") : Buffer.alloc(32);
  return (
    candidateBytes.length === 32 &&
    storedBytes.length === 32 &&
    timingSafeEqual(candidateBytes, storedBytes) &&
    stored !== undefined
  );
}

export function authenticate(
  store: EnhancementStore,
  authorization: unknown,
): AuthenticatedClient {
  if (typeof authorization !== "string")
    throw new EnhancementError("authentication_failed");
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  const key = match?.[1];
  if (!key || Buffer.from(key, "base64url").toString("base64url") !== key)
    throw new EnhancementError("authentication_failed");
  return store.authenticateDigest(digest(key));
}

export function createClient(store: EnhancementStore): IssuedCredential {
  const key = randomBytes(32).toString("base64url");
  return Object.freeze({ ...store.issueCredential(digest(key)), key });
}

export function rotateCredential(
  store: EnhancementStore,
  options: Readonly<{ clientId: string; revokeCredentialId?: string }>,
  principal?: AuthenticatedClient,
): IssuedCredential {
  const key = randomBytes(32).toString("base64url");
  return Object.freeze({
    ...store.issueCredential(digest(key), options, principal),
    key,
  });
}

export function revokeCredential(
  store: EnhancementStore,
  credentialId: string,
  principal?: AuthenticatedClient,
) {
  store.revokeCredential(credentialId, principal);
}
