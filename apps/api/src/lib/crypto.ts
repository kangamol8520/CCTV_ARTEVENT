/**
 * Device credential encryption (AES-256-GCM).
 * Stored format: base64(iv[12] + ciphertext + tag[16]).
 * Key = SHA-256(APP_SECRET), so rotating APP_SECRET requires re-encrypting stored passwords.
 */
import { env } from "./env.ts";

let keyPromise: Promise<CryptoKey> | null = null;

async function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = (async () => {
      const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.appSecret));
      return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    })();
  }
  return keyPromise;
}

export async function encryptSecret(plain: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return Buffer.from(out).toString("base64");
}

export async function decryptSecret(enc: string | null | undefined): Promise<string | null> {
  if (!enc) return null;
  const key = await getKey();
  const buf = Buffer.from(enc, "base64");
  const iv = buf.subarray(0, 12);
  const ct = buf.subarray(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}
