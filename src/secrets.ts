import { base64UrlToBytes, bytesToBase64Url } from "./crypto";

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function importEncryptionKey(encodedKey: string): Promise<CryptoKey> {
  const bytes = base64UrlToBytes(encodedKey);
  if (bytes.byteLength !== 32) throw new Error("GOOGLE_HEALTH_TOKEN_KEY must be a base64url-encoded 32-byte key.");
  return crypto.subtle.importKey("raw", arrayBuffer(bytes), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(value: string, encodedKey: string, context: string): Promise<EncryptedSecret> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importEncryptionKey(encodedKey);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    key,
    new TextEncoder().encode(value)
  );
  return { ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)), iv: bytesToBase64Url(iv) };
}

export async function decryptSecret(secret: EncryptedSecret, encodedKey: string, context: string): Promise<string> {
  const key = await importEncryptionKey(encodedKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: arrayBuffer(base64UrlToBytes(secret.iv)), additionalData: new TextEncoder().encode(context) },
    key,
    arrayBuffer(base64UrlToBytes(secret.ciphertext))
  );
  return new TextDecoder().decode(plaintext);
}
