function importKey(secret) {
  if (typeof secret !== "string" || !secret) {
    throw new Error("cookieSecret is required for signing authorization state");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );
}

async function signData(data, secret) {
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Signs approval-form state so the browser cannot alter the OAuth request
 * between the authorization screen and the approval POST.
 */
export async function signAuthorizationState(state, secret) {
  const payload = JSON.stringify(state);
  const bytes = new TextEncoder().encode(payload);
  if (bytes.byteLength > 32_768) {
    throw new Error("OAuth approval state is too large.");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const signature = await signData(payload, secret);
  return signature + "." + btoa(binary);
}

/** Verify and decode the exact approval state rendered by the server. */
export async function verifyAuthorizationState(encodedState, secret) {
  if (typeof encodedState !== "string" || encodedState.length > 44_000) return null;
  const parts = encodedState.split(".");
  if (parts.length !== 2 || !/^[0-9a-f]{64}$/.test(parts[0])) return null;
  let payload;
  try {
    const binary = atob(parts[1]);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    payload = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  try {
    const key = await importKey(secret);
    const signature = Uint8Array.from(parts[0].match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
    const valid = await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(payload));
    if (!valid) return null;
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(payload);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}
