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
    /WG-Zimmer listing URL/,
  );
  assert.throws(
    () => validateWgzimmerApplication({ ...APPLICATION, name: "" }),
    /Name is required/,
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

function browserFixture({ missingForm = false, signedIn = true, readOnlyName = false } = {}) {
  const calls = [];
  let closed = false;
  const page = {
    goto: async (url, options) => {
      calls.push(["goto", url, options]);
      return { ok: () => true };
    },
    $: async (selector) => (selector.includes('data-mode="account"') && signedIn ? {} : null),
    waitForSelector: async () => {
      if (missingForm) throw new Error("Timeout");
    },
    fill: async (selector, value) => calls.push(["fill", selector, value]),
    locator: (selector) => ({
      count: async () => 1,
      evaluate: async () => readOnlyName && selector === "#kontakt-name",
      fill: async (value) => calls.push(["fill", selector, value]),
      click: async () => calls.push(["click", selector]),
      innerHTML: async () => "<p>Your message was successfully sent.</p>",
    }),
    waitForNavigation: async () => ({ ok: () => true }),
    content: async () => "<html></html>",
  };
  return {
    calls,
    get closed() { return closed; },
    launcher: async (options) => {
      calls.push(["launch", options]);
      return { newPage: async () => page, close: async () => { closed = true; } };
    },
  };
}

test("a signed-in WG-Zimmer form is filled and sent in a hidden browser", async () => {
  const fixture = browserFixture();
  assert.deepEqual(await sendWgzimmerApplication(APPLICATION, fixture.launcher), { ok: true });
  assert.equal(fixture.closed, true);
  assert.equal(fixture.calls[0][1].headless, true);
  assert.deepEqual(fixture.calls.filter(([type]) => type === "fill"), [
    ["fill", "#kontakt-name", "Test Person"],
    ["fill", "#kontakt-phone", "+41 79 000 00 00"],
    ["fill", "#kontakt-text", "Hallo zusammen"],
  ]);
  assert.ok(fixture.calls.some(([type, selector]) => type === "click" && /submit/.test(selector)));
});

test("fields the account fills in are left alone", async () => {
  const fixture = browserFixture({ readOnlyName: true });
  await sendWgzimmerApplication(APPLICATION, fixture.launcher);
  assert.ok(!fixture.calls.some(([type, selector]) => type === "fill" && selector === "#kontakt-name"));
});

test("without a WG-Zimmer sign-in nothing is sent", async () => {
  const fixture = browserFixture({ signedIn: false });
  await assert.rejects(sendWgzimmerApplication(APPLICATION, fixture.launcher), /Sign in to WG-Zimmer/);
  assert.ok(!fixture.calls.some(([type]) => type === "click"));
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
