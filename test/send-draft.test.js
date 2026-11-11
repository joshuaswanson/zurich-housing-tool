import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const handler = source.slice(source.indexOf("async function sendDirectDraft("), source.indexOf("// WGZimmer opens"));

test("a prepared WGZimmer form preserves the draft without marking it applied", async () => {
  const elements = new Map();
  let saved = false;
  const context = vm.createContext({
    $: id => {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    },
    t: key => key,
    fetch: async () => ({ ok: true, json: async () => ({ ok: false, requiresCompletion: true }) }),
    saveDraft: async () => { saved = true; },
    track: async () => { assert.fail("A prepared form is not a sent message"); },
    statusOf: () => "new",
  });
  vm.runInContext(handler, context);
  await context.sendDirectDraft({ source: "wgzimmer", url: "https://www.wgzimmer.ch/" }, "Draft");
  assert.equal(saved, true);
  assert.equal(elements.get("dialog-applied").hidden, false);
  assert.equal(elements.get("dialog-hint").textContent, "wgzimmer_complete_in_browser");
});
