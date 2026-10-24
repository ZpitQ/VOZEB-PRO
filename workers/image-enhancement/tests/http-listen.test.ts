import { request } from "node:http";

import { describe, expect, it } from "vitest";

import { createWorkerConfig } from "../src/config.js";
import {
  listenEnhancementServer,
  type EnhancementServer,
} from "../src/http.js";
import { configInput } from "./fixtures.js";
import { transportLimits } from "./http-fixtures.js";
import {
  runnerLimits,
  storageFixture,
  submissionLimits,
} from "./storage-fixtures.js";

function get(host: string, port: number, authorization?: string) {
  return new Promise<number>((resolve, reject) => {
    const outgoing = request(
      {
        host,
        port,
        path: "/healthz",
        agent: false,
        headers: authorization === undefined ? {} : { authorization },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode!));
        response.once("error", reject);
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

describe("internal HTTP listener", () => {
  it("binds the explicit IP and retains token authentication without any certificate", async () => {
    const f = await storageFixture();
    const config = createWorkerConfig(configInput());
    let server: EnhancementServer | undefined;
    try {
      server = await Reflect.apply(listenEnhancementServer, undefined, [
        {
          store: f.store,
          config: () => config,
          submissionLimits,
          runnerLimits,
          transportLimits,
        },
        0,
        "127.0.0.2",
      ]);
      const address = server!.address();
      expect(address && typeof address !== "string" && address.address).toBe(
        "127.0.0.2",
      );
      if (!address || typeof address === "string")
        throw new Error("listener address unavailable");
      expect(await get("127.0.0.2", address.port)).toBe(401);
      expect(
        await get(
          "127.0.0.2",
          address.port,
          `Bearer ${f.initialized.credential.key}`,
        ),
      ).toBe(200);
    } finally {
      if (server)
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      await f.cleanup();
    }
  });
});
