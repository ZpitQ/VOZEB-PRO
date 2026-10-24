import { readFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

let EnhancementError;

try {
  ({ EnhancementError } = await import("./dist/contracts.js"));
  if (process.argv[2] === "validate-config") {
    const args = process.argv.slice(2);
    const path = args[1];
    if (
      args.length !== 2 ||
      !path ||
      !isAbsolute(path) ||
      /[\x00-\x1f\x7f-\x9f]/.test(path)
    )
      throw new EnhancementError("invalid_request");
    const bytes = await readFile(path);
    let config;
    try {
      config = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new EnhancementError("configuration_invalid");
    }
    const { validateWindowsWorkerInstallConfiguration } =
      await import("./dist/bootstrap.js");
    validateWindowsWorkerInstallConfiguration(
      config,
      dirname(fileURLToPath(import.meta.url)),
    );
    process.stdout.write('{"configurationValid":true}\n');
  } else {
    const { runOfflineCredentialCommand } =
      await import("./dist/offline-management.js");
    const pairing = runOfflineCredentialCommand(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(pairing)}\n`);
  }
} catch (error) {
  const code =
    EnhancementError && error instanceof EnhancementError
      ? error.code
      : "internal_error";
  process.stderr.write(`enhancement_management_failed:${code}\n`);
  process.exitCode = 1;
}
