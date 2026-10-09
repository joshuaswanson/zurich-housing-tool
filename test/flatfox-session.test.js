import test from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import {
  checkFlatfoxSession,
  isFlatfoxAuthenticated,
  loginFlatfox,
  persistentFlatfoxLauncher,
} from "../flatfox-session.mjs";

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

test("Flatfox login opens the real login page and saves a persistent session", async () => {
  const calls = [];
  let checks = 0;
  let closed = false;
  const page = {
    goto: async (url, options) => calls.push(["goto", url, options]),
  };
  const context = {
    request: {
      get: async () => response(++checks === 1 ? 302 : 200),
    },
    pages: () => [page],
    close: async () => {
      closed = true;
    },
  };
  const launcher = async (options) => {
    calls.push(["launch", options]);
    return context;
  };

  assert.deepEqual(
    await loginFlatfox("/tmp/test-flatfox-profile", {
      launcher,
      pollIntervalMs: 0,
      sleep: async () => {},
    }),
    { connected: true },
  );
  assert.equal(closed, true);
  assert.equal(calls[0][1].headless, false);
  assert.equal(calls[0][1].userDataDir, "/tmp/test-flatfox-profile");
  assert.match(calls[1][1], /flatfox\.ch\/en\/accounts\/login/);
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
