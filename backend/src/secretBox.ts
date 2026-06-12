/**
 * Authenticated symmetric encryption for secrets at rest (H3).
 *
 * Per-tenant LLM API keys are encrypted with AES-256-GCM before they touch the
 * database. The 256-bit key is derived per-blob via scrypt from the operator's
 * COMMS_SECRET_KEY (env), with a random salt, so two encryptions of the same
 * key produce different ciphertext and a stolen DB yields nothing without the
 * master secret.
 *
 * Blob format (all base64, dot-separated):  v1.<salt>.<iv>.<tag>.<ciphertext>
 */
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";

const VERSION = "v1";

/** True when an operator master secret is configured (required to store keys). */
export function secretsEnabled(): boolean {
  return !!process.env.COMMS_SECRET_KEY;
}

function requireMaster(): string {
  const secret = process.env.COMMS_SECRET_KEY;
  if (!secret) {
    throw new Error(
      "COMMS_SECRET_KEY is not set — cannot encrypt/decrypt tenant secrets. " +
        "Set it (a long random string) to enable per-tenant API keys.",
    );
  }
  return secret;
}

export function encryptSecret(plaintext: string): string {
  const master = requireMaster();
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(master, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    salt.toString("base64"),
    iv.toString("base64"),
    tag.toString("base64"),
    ct.toString("base64"),
  ].join(".");
}

export function decryptSecret(blob: string): string {
  const master = requireMaster();
  const parts = blob.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error("malformed secret blob");
  }
  const [, saltB, ivB, tagB, ctB] = parts;
  const key = scryptSync(master, Buffer.from(saltB, "base64"), 32);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString(
    "utf8",
  );
}
