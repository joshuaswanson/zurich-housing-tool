import test from "node:test";
import assert from "node:assert/strict";
import { decodeSecret } from "../src/keychain.mjs";

test("secrets the Keychain prints as hex are decoded", () => {
  assert.equal(decodeSecret("c3bce282ac"), "ü€");
  assert.equal(decodeSecret("plain-password"), "plain-password");
  assert.equal(decodeSecret("deadbeef"), "deadbeef");
  assert.equal(decodeSecret("0123"), "0123");
});
