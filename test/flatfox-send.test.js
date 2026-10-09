import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyFlatfoxSendResponse,
  sendFlatfoxApplication,
  validateFlatfoxApplication,
  wasRedirectedFromPost,
} from "../flatfox-send.mjs";

const URL = "https://flatfox.ch/en/flat/8001-zurich/86424524/";
const APPLICATION = {
  url: URL,
  name: "Test Person",
  email: "test@example.com",
  phone: "+41 79 000 00 00",
  message: "Hello, I am interested in the room.",
};

function redirectedResponse() {
  const post = { method: () => "POST", redirectedFrom: () => null };
  const get = { method: () => "GET", redirectedFrom: () => post };
  return {
    ok: () => true,
    status: () => 200,
    request: () => get,
  };
}

test("Flatfox applications accept only canonical listing URLs", () => {
  assert.equal(validateFlatfoxApplication(APPLICATION).pk, "86424524");
  assert.throws(
    () =>
      validateFlatfoxApplication({
        ...APPLICATION,
        url: "https://flatfox.ch/en/listing/86424524/submit/",
      }),
    /Flatfox listing URL/,
  );
  assert.throws(
    () => validateFlatfoxApplication({ ...APPLICATION, phone: "" }),
    /Phone is required/,
  );
  assert.throws(
    () => validateFlatfoxApplication({ ...APPLICATION, email: "invalid" }),
    /valid email/,
  );
});

test("Flatfox success requires a POST redirect or explicit confirmation", () => {
  const response = redirectedResponse();
  assert.equal(wasRedirectedFromPost(response), true);
  assert.deepEqual(
    classifyFlatfoxSendResponse("<p>Listing</p>", {
      redirectedFromPost: true,
    }),
    { ok: true },
  );
  assert.deepEqual(
    classifyFlatfoxSendResponse("<p>Your request was successfully sent.</p>"),
    { ok: true },
  );
  assert.match(
    classifyFlatfoxSendResponse("<p>Turnstile error. Message not sent.</p>")
      .error,
    /Turnstile/i,
  );
  assert.match(
    classifyFlatfoxSendResponse("<p>The listing page reloaded.</p>").error,
    /did not confirm/i,
  );
});

test("sending uses the listing contact form and disables subscriptions", async () => {
  const calls = [];
  let closed = false;
  const initialResponse = { ok: () => true, status: () => 200 };
  const sendResponse = redirectedResponse();
  const page = {
    goto: async (url, options) => {
      calls.push(["goto", url, options]);
      return initialResponse;
    },
    $: async (selector) => {
      calls.push(["$", selector]);
      return selector === "#onetrust-reject-all-handler" ? null : {};
    },
    waitForSelector: async (selector, options) =>
      calls.push(["waitForSelector", selector, options]),
    fill: async (selector, value) => calls.push(["fill", selector, value]),
    uncheck: async (selector) => calls.push(["uncheck", selector]),
    waitForFunction: async (...args) => calls.push(["waitForFunction", ...args]),
    waitForNavigation: () => Promise.resolve(sendResponse),
    click: async (selector) => calls.push(["submit-click", selector]),
    content: async () => "<p>Listing</p>",
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

  assert.deepEqual(await sendFlatfoxApplication(APPLICATION, launcher), {
    ok: true,
  });
  assert.equal(closed, true);
  assert.deepEqual(
    calls.filter(([type]) => type === "fill"),
    [
      ["fill", "#id_name", "Test Person"],
      ["fill", "#id_email", "test@example.com"],
      ["fill", "#id_phone_number", "+41 79 000 00 00"],
      ["fill", "#id_text", "Hello, I am interested in the room."],
    ],
  );
  assert.ok(
    calls.some(
      ([type, selector]) =>
        type === "uncheck" && selector === "#id_create_subscription",
    ),
  );
  assert.ok(calls.some(([type]) => type === "submit-click"));
});

test("the browser closes when Flatfox verification does not finish", async () => {
  let closed = false;
  const response = { ok: () => true, status: () => 200 };
  const launcher = async () => ({
    newPage: async () => ({
      goto: async () => response,
      $: async () => null,
      waitForSelector: async () => {},
      fill: async () => {},
      uncheck: async () => {},
      waitForFunction: async () => {
        throw new Error("timeout");
      },
    }),
    close: async () => {
      closed = true;
    },
  });

  await assert.rejects(
    sendFlatfoxApplication(APPLICATION, launcher),
    /requires interaction/i,
  );
  assert.equal(closed, true);
});
