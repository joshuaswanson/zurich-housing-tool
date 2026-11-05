import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const LIB_URL = new URL("../src/lib.js", import.meta.url).href;
const EXAMPLE = JSON.parse(
  fs.readFileSync(
    fileURLToPath(new URL("../config.example.json", import.meta.url)),
    "utf8",
  ),
);

/** Runs a snippet against lib.js with the given config and returns its JSON output. */
function withConfig(overrides, snippet) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zht-config-"));
  const config = {
    ...EXAMPLE,
    ...overrides,
    search: { ...EXAMPLE.search, ...overrides.search },
  };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
  try {
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `const lib = await import(${JSON.stringify(LIB_URL)});\n${snippet}`],
      {
        env: { ...process.env, ZHT_HOME: home },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return JSON.parse(out);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const SETTINGS = `console.log(JSON.stringify({
  categories: lib.FLATFOX_CATEGORIES,
  type: lib.HOUSING_TYPE,
  radius: lib.MAX_DISTANCE_KM,
  sources: ["flatfox", "wgzimmer", "ronorp", "students"].map(lib.sourceEnabled),
}));`;

test("the defaults search shared rooms on every source", () => {
  const { objectCategory, maxDistanceKm, ...search } = EXAMPLE.search;
  const { sources, ...rest } = EXAMPLE;
  const result = withConfig({ ...rest, search }, SETTINGS);
  assert.deepEqual(result, {
    categories: ["SHARED"],
    type: "room",
    radius: 5,
    sources: [true, true, true, true],
  });
});

test("an apartment search is configured from config.json", () => {
  const result = withConfig(
    {
      search: { objectCategory: ["apartment", "HOUSE"], maxDistanceKm: 8 },
      sources: { wgzimmer: false, students: false },
    },
    SETTINGS,
  );
  assert.deepEqual(result, {
    categories: ["APARTMENT", "HOUSE"],
    type: "apartment",
    radius: 8,
    sources: [true, false, true, false],
  });
});

test("an unknown Flatfox category is rejected", () => {
  assert.throws(
    () => withConfig({ search: { objectCategory: "CASTLE" } }, SETTINGS),
    /unknown category "CASTLE"/,
  );
});

test("geocoding retries after network errors and caches misses", () => {
  const result = withConfig(
    { search: { geocodeSuffix: "" } },
    `
const answers = [
  () => { throw new Error("offline"); },
  () => ({ ok: true, json: async () => [{ lat: "47.37", lon: "8.54" }] }),
  () => ({ ok: true, json: async () => [] }),
];
let calls = 0;
globalThis.fetch = async () => answers[calls++]();
const offline = await lib.geocodeAddress("Seefeldstrasse 1");
const found = await lib.geocodeAddress("Seefeldstrasse 1");
const cached = await lib.geocodeAddress("Seefeldstrasse 1");
const missing = await lib.geocodeAddress("Nowhere 99");
const missingAgain = await lib.geocodeAddress("Nowhere 99");
console.log(JSON.stringify({ offline, found, cached, missing, missingAgain, calls }));`,
  );
  assert.deepEqual(result, {
    offline: null,
    found: { lat: 47.37, lng: 8.54 },
    cached: { lat: 47.37, lng: 8.54 },
    missing: null,
    missingAgain: null,
    calls: 3,
  });
});
