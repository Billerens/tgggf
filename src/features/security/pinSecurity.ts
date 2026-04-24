const PIN_REGEX = /^\d{4,8}$/;
const SALT_BYTES = 16;

function getWebCrypto() {
  const cryptoRef = globalThis.crypto;
  if (!cryptoRef || !cryptoRef.subtle) {
    throw new Error("WebCrypto API is not available");
  }
  return cryptoRef;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function safeCompare(left: string, right: string) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

export function isValidSecurityPin(pin: string) {
  return PIN_REGEX.test(pin.trim());
}

export async function hashSecurityPin(pin: string, providedSalt?: string) {
  const normalizedPin = pin.trim();
  if (!isValidSecurityPin(normalizedPin)) {
    throw new Error("PIN must contain 4-8 digits");
  }
  const cryptoRef = getWebCrypto();
  const saltBytes = providedSalt
    ? base64ToBytes(providedSalt)
    : cryptoRef.getRandomValues(new Uint8Array(SALT_BYTES));
  const salt = bytesToBase64(saltBytes);
  const payload = new TextEncoder().encode(`${salt}:${normalizedPin}`);
  const digest = await cryptoRef.subtle.digest("SHA-256", payload);
  const hash = bytesToBase64(new Uint8Array(digest));
  return { salt, hash };
}

export async function verifySecurityPin(
  pin: string,
  salt: string,
  expectedHash: string,
) {
  const normalizedPin = pin.trim();
  if (!isValidSecurityPin(normalizedPin)) return false;
  if (!salt.trim() || !expectedHash.trim()) return false;
  const { hash } = await hashSecurityPin(normalizedPin, salt);
  return safeCompare(hash, expectedHash);
}
