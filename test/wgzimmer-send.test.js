import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyWgzimmerSendResponse,
  sendWgzimmerApplication,
  validateWgzimmerApplication,
} from "../src/sources/wgzimmer-send.mjs";

const URL =
  "https://www.wgzimmer.ch/wglink/en/11111111-2222-4333-8444-555555555555/zurich-stadt/a.html";
const APPLICATION = {
  url: URL,
  name: "Test Person",
  email: "test@example.com",
  phone: "+41 79 000 00 00",
  message: "Hallo zusammen",
};

test("WGZimmer applications are validated before a browser is opened", () => {
  assert.equal(validateWgzimmerApplication(APPLICATION).uuid, "11111111-2222-4333-8444-555555555555");
  assert.throws(
    () => validateWgzimmerApplication({ ...APPLICATION, url: "https://example.com/x" }),
    /WGZimmer listing URL/,
  );
  assert.throws(
    () => validateWgzimmerApplication({ ...APPLICATION, email: "not-an-email" }),
    /valid email/,
  );
  assert.throws(
    () => validateWgzimmerApplication({ ...APPLICATION, message: "" }),
    /Message is required/,
  );
});

test("WGZimmer send responses require an explicit success signal", () => {
  assert.deepEqual(
    classifyWgzimmerSendResponse("<p>Deine E-Mail wurde erfolgreich versendet.</p>"),
    { ok: true },
  );
  assert.deepEqual(
    classifyWgzimmerSendResponse(
      '<script>setLocalStorageValueByKey("contact-abc", new Date())</script>',
    ),
    { ok: true },
  );
  assert.match(
    classifyWgzimmerSendResponse("<p>reCAPTCHA error. Nachricht nicht gesendet.</p>").error,
    /reCAPTCHA/i,
  );
  assert.match(
    classifyWgzimmerSendResponse("<p>The listing page reloaded.</p>").error,
    /did not confirm/i,
  );
});

function browserFixture({ missingForm = false } = {}) {
  const calls = [];
  let closed = false;
  let closeWindow;
  const page = {
    goto: async (url, options) => {
      calls.push(["goto", url, options]);
      return { ok: () => true };
    },
    $: async () => null,
    waitForSelector: async (selector) => {
      assert.equal(selector, "#kontakt form.contact-form__form");
      if (missingForm) throw new Error("Timeout");
    },
    fill: async (selector, value) => calls.push(["fill", selector, value]),
    locator: (selector) => {
      assert.equal(selector, "#kontakt");
      return { scrollIntoViewIfNeeded: async () => {} };
    },
    bringToFront: async () => calls.push(["front"]),
    once: (event, callback) => {
      assert.equal(event, "close");
      closeWindow = callback;
    },
  };
  return {
    calls,
    get closed() { return closed; },
    closeWindow: () => closeWindow(),
    launcher: async (options) => {
      calls.push(["launch", options]);
      return { newPage: async () => page, close: async () => { closed = true; } };
    },
  };
}

test("current WGZimmer form is filled and handed over without claiming a send", async () => {
  const fixture = browserFixture();
  assert.deepEqual(await sendWgzimmerApplication(APPLICATION, fixture.launcher), {
    ok: false, requiresCompletion: true,
  });
  assert.equal(fixture.closed, false);
  assert.equal(fixture.calls[0][1].headless, false);
  assert.equal(fixture.calls[1][2].waitUntil, "domcontentloaded");
  assert.deepEqual(fixture.calls.filter(([type]) => type === "fill"), [
    ["fill", "#kontakt-name", "Test Person"],
    ["fill", "#kontakt-email", "test@example.com"],
    ["fill", "#kontakt-phone", "+41 79 000 00 00"],
    ["fill", "#kontakt-text", "Hallo zusammen"],
  ]);
  fixture.closeWindow();
  assert.equal(fixture.closed, true);
});

test("missing contact form closes the browser and reports an actionable error", async () => {
  const fixture = browserFixture({ missingForm: true });
  await assert.rejects(sendWgzimmerApplication(APPLICATION, fixture.launcher), /no longer has/);
  assert.equal(fixture.closed, true);
});

test("current form limits reject overlong values instead of truncating drafts", async () => {
  for (const [field, length] of [["name", 101], ["phone", 31], ["message", 3001]]) {
    await assert.rejects(sendWgzimmerApplication({ ...APPLICATION, [field]: "x".repeat(length) },
      async () => { assert.fail("Invalid input must not launch a browser"); }), /too long/);
  }
});
