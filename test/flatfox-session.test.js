import test from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import {
  checkFlatfoxSession,
  isFlatfoxAuthenticated,
  FlatfoxLogin,
  errorMessages,
  persistentFlatfoxLauncher,
} from "../src/sources/flatfox-session.mjs";

function response(status) {
  return { status: () => status };
}

test("Flatfox authentication follows its protected account endpoint", async () => {
  const signedOut = {
    request: { get: async () => response(302) },
  };
  const signedIn = {
    request: { get: async () => response(200) },
  };
  assert.equal(await isFlatfoxAuthenticated(signedOut), false);
  assert.equal(await isFlatfoxAuthenticated(signedIn), true);
});

/**
 * A stand-in for Flatfox's login page. `visibleAfterClick` lists the fields
 * that show after each submit click, and `answers` the login responses.
 */
function fakeLogin({ visibleAfterClick, answers = [], authenticatedAfter = Infinity }) {
  const calls = [];
  const listeners = [];
  let clicks = 0;
  let shown = [];
  let checks = 0;
  const page = {
    goto: async (url) => calls.push(["goto", url]),
    fill: async (selector, value) => calls.push(["fill", selector, value]),
    click: async (selector) => {
      calls.push(["click", selector]);
      if (selector.includes("submit")) {
        shown = visibleAfterClick[clicks] || shown;
        const answer = answers[clicks - 1];
        clicks++;
        if (answer) for (const listener of listeners) listener(answer);
      }
    },
    locator: (selector) => ({
      first: () => ({
        isVisible: async () => shown.some((name) => selector.includes(`'${name}'`)),
      }),
      click: async () => calls.push(["click", selector]),
    }),
    on: (event, listener) => listeners.push(listener),
    off: () => listeners.pop(),
  };
  const context = {
    request: { get: async () => response(++checks > authenticatedAfter ? 200 : 302) },
    pages: () => [page],
    newPage: async () => page,
    close: async () => calls.push(["close"]),
  };
  const login = new FlatfoxLogin("/tmp/test-flatfox-profile", {
    launcher: async (options) => {
      calls.push(["launch", options]);
      return context;
    },
    sleep: async () => {},
    timeoutMs: 200,
  });
  return { login, calls };
}

function loginAnswer(status, body) {
  return {
    url: () => "https://flatfox.ch/api/v1/auth/login/",
    ok: () => status < 400,
    json: async () => body,
  };
}

test("Flatfox sign-in asks for the password, then saves the session", async () => {
  const { login, calls } = fakeLogin({
    visibleAfterClick: [["password"]],
    answers: [loginAnswer(200, {})],
    authenticatedAfter: 2,
  });
  assert.deepEqual(await login.start("jane@example.com"), { step: "password" });
  assert.deepEqual(await login.submit({ password: "pw" }), { connected: true });
  const launch = calls.find(([name]) => name === "launch")[1];
  assert.equal(launch.headless, true);
  assert.equal(launch.userDataDir, "/tmp/test-flatfox-profile");
  assert.match(calls.find(([name]) => name === "goto")[1], /flatfox\.ch\/en\/accounts\/login/);
  assert.ok(calls.some(([name, selector, value]) => name === "fill" && selector === "#id_email" && value === "jane@example.com"));
  assert.ok(calls.some(([name, selector, value]) => name === "fill" && selector.includes("password") && value === "pw"));
});

test("a wrong password reports Flatfox's own message", async () => {
  const { login } = fakeLogin({
    visibleAfterClick: [["password"]],
    answers: [loginAnswer(400, { non_field_errors: ["Unable to log in with provided credentials."] })],
  });
  await login.start("jane@example.com");
  await assert.rejects(login.submit({ password: "wrong" }), /Unable to log in with provided credentials/);
});

test("a new device is asked for the emailed code after the password", async () => {
  const { login } = fakeLogin({
    visibleAfterClick: [["password"], ["code-field", "otp"]],
    answers: [loginAnswer(400, { code: "device-not-verified" })],
  });
  await login.start("jane@example.com");
  assert.deepEqual(await login.submit({ password: "pw" }), { step: "code", newDevice: true });
});

test("an email without a Flatfox account is turned away", async () => {
  const { login } = fakeLogin({ visibleAfterClick: [["fullName"]] });
  await assert.rejects(login.start("nobody@example.com"), /no account/);
});

test("Flatfox error bodies are flattened into their messages", () => {
  assert.deepEqual(
    errorMessages({ code: "x", password: ["Too short."], detail: "Locked." }),
    ["Too short.", "Locked."],
  );
});

test("a missing Flatfox profile is disconnected without launching a browser", async () => {
  const missing = path.join(
    os.tmpdir(),
    `zht-missing-flatfox-profile-${Date.now()}`,
  );
  let launched = false;
  const status = await checkFlatfoxSession(missing, {
    launcher: async () => {
      launched = true;
    },
  });
  assert.deepEqual(status, { connected: false });
  assert.equal(launched, false);
});

test("the persistent launcher adds the profile without dropping send options", async () => {
  let options;
  const launcher = persistentFlatfoxLauncher("/tmp/flatfox-profile", async (o) => {
    options = o;
    return "context";
  });
  assert.equal(await launcher({ headless: true, humanize: true }), "context");
  assert.deepEqual(options, {
    headless: true,
    humanize: true,
    userDataDir: "/tmp/flatfox-profile",
  });
});
