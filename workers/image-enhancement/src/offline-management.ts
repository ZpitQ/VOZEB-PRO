import { isAbsolute } from "node:path";

import { EnhancementError } from "./contracts.js";
import { rotateCredential, type IssuedCredential } from "./credentials.js";
import { initializeStore, openStore, type EnhancementStore } from "./store.js";

export function runOfflineCredentialCommand(args: readonly string[]): Readonly<{
  serviceId: string;
  credential: IssuedCredential;
}> {
  const [command, directory, clientId] = args;
  if (
    (command !== "initialize" && command !== "issue") ||
    args.length !== (command === "initialize" ? 2 : 3) ||
    !directory ||
    !isAbsolute(directory) ||
    (command === "issue" && !clientId) ||
    args.some((value) => !value || /[\x00-\x1f\x7f-\x9f]/.test(value))
  )
    throw new EnhancementError("invalid_request");

  let store: EnhancementStore | undefined;
  try {
    let credential: IssuedCredential;
    if (command === "initialize") {
      const initialized = initializeStore({ directory, clock: Date.now });
      store = initialized.store;
      credential = initialized.credential;
    } else {
      store = openStore({ directory, clock: Date.now });
      credential = rotateCredential(store, { clientId: clientId! });
    }
    return Object.freeze({ serviceId: store.identity.serviceId, credential });
  } finally {
    store?.close();
  }
}
