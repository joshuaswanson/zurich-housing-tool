import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const handler = source.slice(source.indexOf("async function sendDirectDraft("), source.indexOf("async function handOverDraft("));

test("a WG-Zimmer message the site accepted is saved and marked applied", async () => {
  const elements = new Map();
  let saved = false;
  let tracked = null;
  const context = vm.createContext({
    $: id => {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    },
    t: key => key,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    saveDraft: async () => { saved = true; },
    track: async (url, action) => { tracked = action; },
    statusOf: () => "new",
  });
  vm.runInContext(handler, context);
  await context.sendDirectDraft({ source: "wgzimmer", url: "https://www.wgzimmer.ch/" }, "Draft");
  assert.equal(saved, true);
  assert.equal(tracked, "apply");
  assert.equal(elements.get("dialog-hint").textContent, "sent_wgzimmer");
});

test("a WG-Zimmer send that fails is not marked applied", async () => {
  const elements = new Map();
  const context = vm.createContext({
    $: id => {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    },
    t: key => key,
    fetch: async () => ({ ok: false, status: 502, json: async () => ({ error: "Sign in to WG-Zimmer under Accounts first." }) }),
    saveDraft: async () => {},
    track: async () => { assert.fail("A failed send is not an application"); },
    statusOf: () => "new",
  });
  vm.runInContext(handler, context);
  await context.sendDirectDraft({ source: "wgzimmer", url: "https://www.wgzimmer.ch/" }, "Draft");
  assert.match(elements.get("dialog-hint").textContent, /Sign in to WG-Zimmer/);
});
