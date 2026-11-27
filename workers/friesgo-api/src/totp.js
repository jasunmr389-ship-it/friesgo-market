// Pure WebCrypto RFC 6238 TOTP (6-digit, 30s period, HMAC-SHA1) for super_admin mandatory 2FA

import { randomBytes, timingSafeEqualStr } from "./crypto.js";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < arr.length; i++) {
    value = (value << 8) | arr[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32Decode(str) {
  const clean = String(str || "").toUpperCase().replace(/[\s=-]+/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function generateTotpSecret(byteLen = 20) {
  return base32Encode(randomBytes(byteLen));
}

export async function generateTotpCode(secretBase32, timestampMs = Date.now(), periodSec = 30) {
  const keyBytes = base32Decode(secretBase32);
  if (!keyBytes.length) throw new Error("Invalid TOTP secret");
  const counter = Math.floor(timestampMs / 1000 / periodSec);
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 1000000).padStart(6, "0");
}

export async function verifyTotpCodeWithStep(secretBase32, candidate, timestampMs = Date.now(), windowSteps = 1) {
  const clean = String(candidate || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return { ok: false, step: 0 };
  const baseStep = Math.floor(timestampMs / 1000 / 30);
  for (let offset = -windowSteps; offset <= windowSteps; offset++) {
    const expected = await generateTotpCode(secretBase32, timestampMs + offset * 30000);
    if (timingSafeEqualStr(clean, expected)) {
      return { ok: true, step: baseStep + offset };
    }
  }
  return { ok: false, step: 0 };
}

export async function verifyTotpCode(secretBase32, candidate, timestampMs = Date.now(), windowSteps = 1) {
  const r = await verifyTotpCodeWithStep(secretBase32, candidate, timestampMs, windowSteps);
  return r.ok;
}

export function buildOtpAuthUri(secretBase32, loginId, issuer = "FriesGo Global") {
  const iss = encodeURIComponent(issuer);
  const acct = encodeURIComponent(`${issuer}:${loginId}`);
  return `otpauth://totp/${acct}?secret=${encodeURIComponent(secretBase32)}&issuer=${iss}&algorithm=SHA1&digits=6&period=30`;
}
