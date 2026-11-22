/**
 * Passwords in the macOS login Keychain. The secret goes to `security` on
 * stdin so it never appears in the process list.
 */
import { execFile, spawn } from "child_process";

const quote = (value) => `"${String(value).replace(/[\\"]/g, (c) => `\\${c}`)}"`;

// `security -i` exits 0 even when a command fails, so the save is checked by
// reading the secret back.
export async function saveSecret(service, account, secret) {
  const output = await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", ["-i"], { stdio: ["pipe", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.stderr.on("data", (chunk) => (text += chunk));
    child.on("error", reject);
    child.on("close", () => resolve(text.trim()));
    child.stdin.end(
      `add-generic-password -U -a ${quote(account)} -s ${quote(service)} -w ${quote(secret)}\n`,
    );
  });
  if ((await readSecret(service, account)) !== secret) {
    throw new Error(`The Keychain did not save the password.${output ? ` ${output}` : ""}`);
  }
}

// `security -w` prints a secret with non-ASCII characters as hex.
export function decodeSecret(output) {
  if (!/^(?:[0-9a-f]{2})+$/.test(output)) return output;
  const bytes = Buffer.from(output, "hex");
  if (!bytes.some((b) => b >= 0x80)) return output;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return output;
  }
}

export function readSecret(service, account) {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-a", account, "-s", service, "-w"],
      (err, stdout) => resolve(err ? null : decodeSecret(stdout.replace(/\n$/, ""))),
    );
  });
}

export function deleteSecret(service, account) {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["delete-generic-password", "-a", account, "-s", service],
      () => resolve(),
    );
  });
}
