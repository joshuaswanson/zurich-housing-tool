/**
 * The saved ETH Housing Office sign-in: the user name in data/ and the
 * password in the Keychain, so scans can sign in again when the session ends.
 */
import fs from "fs";
import {
  ETHZ_KEYCHAIN_SERVICE,
  ETHZ_SESSION_FILE,
  ensureDataDir,
  readJson,
} from "./lib.js";
import { deleteSecret, readSecret, saveSecret } from "./keychain.mjs";

export const keychain = { saveSecret, readSecret, deleteSecret };

export function ethzUsername() {
  return readJson(ETHZ_SESSION_FILE, {})?.username || null;
}

/** The saved user name and password, or null when either is missing. */
export async function ethzCredentials() {
  const username = ethzUsername();
  if (!username) return null;
  const password = await keychain.readSecret(ETHZ_KEYCHAIN_SERVICE, username);
  return password ? { username, password } : null;
}

export async function saveEthzCredentials({ username, password }) {
  await keychain.saveSecret(ETHZ_KEYCHAIN_SERVICE, username, password);
  ensureDataDir();
  fs.writeFileSync(ETHZ_SESSION_FILE, JSON.stringify({ username }, null, 2));
}

export async function forgetEthzCredentials() {
  const username = ethzUsername();
  if (username) await keychain.deleteSecret(ETHZ_KEYCHAIN_SERVICE, username);
  fs.rmSync(ETHZ_SESSION_FILE, { force: true });
}
