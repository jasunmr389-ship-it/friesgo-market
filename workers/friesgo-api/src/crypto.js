// WebCrypto security primitives for FriesGo Global V2.1 M2-A (zero external dependencies)

const enc = new TextEncoder();
const dec = new TextDecoder();

export function bytesToHex(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex) {
  const clean = String(hex || "").trim();
  if (!clean || clean.length % 2 !== 0) return new Uint8Array(0);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}

export function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(String(b64 || "").trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(len = 16) {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return buf;
}

export function randomHex(len = 16) {
  return bytesToHex(randomBytes(len));
}

export function randomId(prefix = "fg") {
  return `${prefix}_${Date.now().toString(36)}_${randomHex(6)}`;
}

export async function sha256Hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(String(str || "")));
  return bytesToHex(new Uint8Array(digest));
}

export function timingSafeEqualStr(a, b) {
  const aBytes = enc.encode(String(a || ""));
  const bBytes = enc.encode(String(b || ""));
  const maxLen = Math.max(aBytes.length, bBytes.length, 1);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLen; i++) {
    const av = i < aBytes.length ? aBytes[i] : 0;
    const bv = i < bBytes.length ? bBytes[i] : 0;
    diff |= av ^ bv;
  }
  return diff === 0 && aBytes.length > 0;
}

export function validatePasswordStrength(password) {
  const p = String(password || "");
  if (p.length < 8 || p.length > 128) {
    return { ok: false, error: "密码长度须为 8–128 位" };
  }
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) {
    return { ok: false, error: "密码须同时包含字母与数字" };
  }
  if (/^(12345678|password|admin123|qwerty123|friesgo123)$/i.test(p)) {
    return { ok: false, error: "禁止使用常见弱密码" };
  }
  return { ok: true };
}

async function hmacSha256Bytes(keyStr, msgStr) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(String(keyStr || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(String(msgStr || "")));
  return new Uint8Array(sig);
}

/**
 * PBKDF2-HMAC-SHA256 with server-side HMAC pepper + unique per-user 16-byte random salt.
 * Note: Cloudflare Workers WebCrypto caps PBKDF2 at 100,000 iterations natively in BoringSSL.
 */
export async function hashPassword(password, pepper, saltHex = "", iterations = 100000) {
  if (!pepper || String(pepper).length < 16) {
    throw new Error("AUTH_PEPPER secret is missing or too short");
  }
  const salt = saltHex ? hexToBytes(saltHex) : randomBytes(16);
  const iter = Math.min(100000, Math.max(10000, parseInt(iterations, 10) || 100000));
  const peppered = await hmacSha256Bytes(pepper, String(password || ""));
  const baseKey = await crypto.subtle.importKey("raw", peppered, { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iter },
    baseKey,
    256
  );
  return {
    hashHex: bytesToHex(new Uint8Array(bits)),
    saltHex: bytesToHex(salt),
    iterations: iter,
  };
}

export async function verifyPassword(password, pepper, saltHex, storedHashHex, iterations = 100000) {
  if (!password || !saltHex || !storedHashHex) return false;
  try {
    const derived = await hashPassword(password, pepper, saltHex, iterations);
    return timingSafeEqualStr(derived.hashHex, storedHashHex);
  } catch {
    return false;
  }
}

async function importAesKey(keyB64) {
  const raw = base64ToBytes(keyB64);
  if (raw.length !== 32) {
    throw new Error("TOTP_ENC_KEY must be a 32-byte base64 key");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plaintext, keyB64) {
  const key = await importAesKey(keyB64);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(String(plaintext || ""))
  );
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ct))}`;
}

export async function decryptSecret(packed, keyB64) {
  const parts = String(packed || "").split(".");
  if (parts.length !== 2) throw new Error("Invalid encrypted secret format");
  const key = await importAesKey(keyB64);
  const iv = base64ToBytes(parts[0]);
  const ct = base64ToBytes(parts[1]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return dec.decode(pt);
}

export async function generateRecoveryCodes(pepper, count = 8) {
  const plainCodes = [];
  const hashedCodes = [];
  for (let i = 0; i < count; i++) {
    const raw = randomHex(5).toUpperCase();
    const code = `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
    plainCodes.push(code);
    hashedCodes.push(await sha256Hex(`${pepper}:rec:${code}`));
  }
  return { plainCodes, hashedCodes };
}

export async function consumeRecoveryCode(candidate, hashedCodes, pepper) {
  const norm = String(candidate || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (!norm || !Array.isArray(hashedCodes) || !hashedCodes.length) {
    return { matched: false, remaining: hashedCodes || [] };
  }
  const candHash = await sha256Hex(`${pepper}:rec:${norm}`);
  let idx = -1;
  for (let i = 0; i < hashedCodes.length; i++) {
    if (timingSafeEqualStr(hashedCodes[i], candHash)) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return { matched: false, remaining: hashedCodes };
  const remaining = hashedCodes.slice(0, idx).concat(hashedCodes.slice(idx + 1));
  return { matched: true, remaining };
}
