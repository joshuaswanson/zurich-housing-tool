import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const code = source.slice(source.indexOf("function scanFraction("), source.indexOf("function timeLeft("));
const context = vm.createContext({});
vm.runInContext(code, context);

const progress = (current) => ({
  current,
  steps: [{ expectedMs: 60000 }, { expectedMs: 20000 }, { expectedMs: 20000 }],
});

test("the scan bar moves by how long each step took last time", () => {
  assert.deepEqual({ ...context.scanFraction(progress(0), 30000) }, { fraction: 0.3, remainingMs: 70000 });
  assert.deepEqual({ ...context.scanFraction(progress(1), 0) }, { fraction: 0.6, remainingMs: 40000 });
});

test("a step that runs long holds the bar short of its end", () => {
  const { fraction } = context.scanFraction(progress(2), 600000);
  assert.ok(fraction < 1);
  assert.ok(fraction > 0.98);
});
