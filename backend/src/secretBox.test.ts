import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encryptSecret, decryptSecret, secretsEnabled } from "./secretBox.js";

const SAVED = process.env.COMMS_SECRET_KEY;

beforeEach(() => {
  process.env.COMMS_SECRET_KEY = "test-master-secret-please-rotate";
});
afterEach(() => {
  if (SAVED === undefined) delete process.env.COMMS_SECRET_KEY;
  else process.env.COMMS_SECRET_KEY = SAVED;
});

describe("secretBox (AES-256-GCM)", () => {
  it("round-trips a secret", () => {
    const plain = "sk-super-secret-api-key-1234567890";
    const blob = encryptSecret(plain);
    expect(blob.startsWith("v1.")).toBe(true);
    expect(blob).not.toContain(plain);
    expect(decryptSecret(blob)).toBe(plain);
  });

  it("produces different ciphertext each time (random salt+iv)", () => {
    const plain = "same-input";
    expect(encryptSecret(plain)).not.toBe(encryptSecret(plain));
  });

  it("fails to decrypt tampered ciphertext (auth tag)", () => {
    const blob = encryptSecret("hello");
    const parts = blob.split(".");
    // Flip a byte in the ciphertext segment.
    const ct = Buffer.from(parts[4], "base64");
    ct[0] ^= 0xff;
    parts[4] = ct.toString("base64");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });

  it("fails to decrypt under a different master key", () => {
    const blob = encryptSecret("hello");
    process.env.COMMS_SECRET_KEY = "a-completely-different-master-secret";
    expect(() => decryptSecret(blob)).toThrow();
  });

  it("rejects a malformed blob", () => {
    expect(() => decryptSecret("not-a-valid-blob")).toThrow(/malformed/);
  });

  it("throws when no master key is configured", () => {
    delete process.env.COMMS_SECRET_KEY;
    expect(secretsEnabled()).toBe(false);
    expect(() => encryptSecret("x")).toThrow(/COMMS_SECRET_KEY/);
  });
});
