/**
 * Passwords in the macOS login Keychain. The secret goes to `security` on
 * stdin so it never appears in the process list.
 */
import { execFile, spawn } from "child_process";

const quote = (value) => `"${String(value).replace(/[\\"]/g, (c) => `\\${c}`)}"`;

export function saveSecret(service, account, secret) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk) => (error += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 && !error ? resolve() : reject(new Error(error.trim() || "Keychain refused the password.")),
    );
    child.stdin.end(
      `add-generic-password -U -a ${quote(account)} -s ${quote(service)} -w ${quote(secret)}\n`,
    );
  });
}

export function readSecret(service, account) {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-a", account, "-s", service, "-w"],
      (err, stdout) => resolve(err ? null : stdout.replace(/\n$/, "")),
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
