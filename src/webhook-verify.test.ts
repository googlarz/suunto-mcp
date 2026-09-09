import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySignature } from "./webhook-verify.js";

const secret = "test-notification-secret";
const body = Buffer.from(JSON.stringify({ type: "WORKOUT_CREATED", username: "johndoe123" }));

test("verifySignature: accepts a correct hex-encoded signature", () => {
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifySignature(body, sig, secret), true);
});

test("verifySignature: accepts a correct base64-encoded signature", () => {
  const sig = createHmac("sha256", secret).update(body).digest("base64");
  assert.equal(verifySignature(body, sig, secret), true);
});

test("verifySignature: rejects a wrong secret", () => {
  const sig = createHmac("sha256", "wrong-secret").update(body).digest("hex");
  assert.equal(verifySignature(body, sig, secret), false);
});

test("verifySignature: rejects a tampered body", () => {
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  const tampered = Buffer.from(JSON.stringify({ type: "WORKOUT_CREATED", username: "attacker" }));
  assert.equal(verifySignature(tampered, sig, secret), false);
});

test("verifySignature: rejects a missing signature header", () => {
  assert.equal(verifySignature(body, undefined, secret), false);
});

test("verifySignature: rejects garbage in the signature header", () => {
  assert.equal(verifySignature(body, "not-a-real-signature", secret), false);
});
