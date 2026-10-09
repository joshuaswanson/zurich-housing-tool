import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyWgzimmerSendResponse,
  sendWgzimmerApplication,
  validateWgzimmerApplication,
} from "../wgzimmer-send.mjs";

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

test("sending uses WGZimmer's contact button and normal form submission", async () => {
  const calls = [];
  let closed = false;
  const response = { ok: () => true, status: () => 200 };
  const page = {
    goto: async (url, options) => {
      calls.push(["goto", url, options]);
      return response;
    },
    $: async (selector) => {
      calls.push(["$", selector]);
      if (selector === ".fc-cta-consent") return null;
      return { click: async () => calls.push(["contact-click"]) };
    },
    waitForSelector: async (selector, options) =>
      calls.push(["waitForSelector", selector, options]),
    fill: async (selector, value) => calls.push(["fill", selector, value]),
    waitForNavigation: () => Promise.resolve(response),
    click: async (selector) => calls.push(["submit-click", selector]),
    content: async () => "<p>Your email was successfully sent.</p>",
  };
  const launcher = async (options) => {
    calls.push(["launch", options]);
    return {
      newPage: async () => page,
      close: async () => {
        closed = true;
      },
    };
  };

  assert.deepEqual(await sendWgzimmerApplication(APPLICATION, launcher), {
    ok: true,
  });
  assert.equal(closed, true);
  assert.deepEqual(
    calls.filter(([type]) => type === "fill"),
    [
      ["fill", "#senderName", "Test Person"],
      ["fill", "#senderEmail", "test@example.com"],
      ["fill", "#senderPhone", "+41 79 000 00 00"],
      ["fill", "#senderText", "Hallo zusammen"],
    ],
  );
  assert.ok(calls.some(([type]) => type === "contact-click"));
  assert.ok(calls.some(([type]) => type === "submit-click"));
});

test("the background browser closes when WGZimmer rejects the send", async () => {
  let closed = false;
  const response = { ok: () => true, status: () => 200 };
  const launcher = async () => ({
    newPage: async () => ({
      goto: async () => response,
      $: async (selector) =>
        selector === ".fc-cta-consent" ? null : { click: async () => {} },
      waitForSelector: async () => {},
      fill: async () => {},
      waitForNavigation: () => Promise.resolve(response),
      click: async () => {},
      content: async () => "<p>reCAPTCHA error. Message not sent.</p>",
    }),
    close: async () => {
      closed = true;
    },
  });

  await assert.rejects(
    sendWgzimmerApplication(APPLICATION, launcher),
    /reCAPTCHA/i,
  );
  assert.equal(closed, true);
});
