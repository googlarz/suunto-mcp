import { createHmac, timingSafeEqual } from "node:crypto";

// Suunto signs each webhook body with HMAC-SHA256 using your notification
// secret and sends it in X-HMAC-SHA256-Signature. Their own example code
// wasn't fully extractable from the docs page (the code block didn't
// render in the fetch), so this accepts either hex or base64 digest
// encoding rather than guessing wrong and rejecting every real request —
// verify against Suunto's actual example if you hit persistent 401s.
export function verifySignature(body: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const digest = createHmac("sha256", secret).update(body).digest();
  for (const encoding of ["hex", "base64"] as const) {
    const expected = Buffer.from(digest.toString(encoding), encoding === "hex" ? "hex" : "base64");
    const provided = Buffer.from(header, encoding === "hex" ? "hex" : "base64");
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) return true;
  }
  return false;
}
