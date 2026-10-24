import { createServer, type Server } from "node:https";
import { isIP } from "node:net";

import { EnhancementError } from "./contracts.js";
import { createHttpTransportLimits } from "./http-config.js";
import {
  createEnhancementHandler,
  type EnhancementHttpOptions,
  type HttpFileIoOwner,
} from "./http.js";

export type EnhancementTlsServer = Server &
  Readonly<{ fileIo: HttpFileIoOwner }>;

export async function listenEnhancementTlsServer(
  options: EnhancementHttpOptions,
  port: number,
  transport: Readonly<{ host: string; pfx: Buffer }>,
): Promise<EnhancementTlsServer> {
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65_535 ||
    typeof transport?.host !== "string" ||
    !isIP(transport.host) ||
    !Buffer.isBuffer(transport.pfx) ||
    transport.pfx.length === 0
  )
    throw new EnhancementError("configuration_invalid");
  const limits = createHttpTransportLimits(options.transportLimits);
  const handler = createEnhancementHandler(options);
  let server: Server;
  try {
    server = createServer(
      {
        pfx: transport.pfx,
        headersTimeout: limits.headersTimeoutMs,
        // The authenticated receiver owns the body deadline and its JSON response.
        requestTimeout: 0,
        maxHeaderSize: limits.maxHeaderBytes,
      },
      handler,
    );
  } catch {
    throw new EnhancementError("configuration_invalid");
  }
  server.on("checkContinue", handler);
  server.on("checkExpectation", handler);
  Object.defineProperty(server, "fileIo", {
    value: Object.freeze({
      sealFileIo: handler.sealFileIo,
      pendingRequests: handler.pendingRequests,
      activity: handler.activity,
    }),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, transport.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server as EnhancementTlsServer;
}
