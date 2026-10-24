import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isDeepStrictEqual } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { EnhancementError } from "../src/contracts.js";
import {
  authenticate,
  createClient,
  revokeCredential,
  rotateCredential,
  type IssuedCredential,
} from "../src/credentials.js";
import {
  openStore,
  type AuthenticatedClient,
  type EnhancementStore,
} from "../src/store.js";
import { httpFixture, jobOf, type HttpResult } from "./http-fixtures.js";
import { snapshot, type StorageFixture } from "./lifecycle-fixtures.js";
import {
  requestBinary,
  succeededThroughRunner,
  type ResultHttpFixture,
} from "./result-http-fixtures.js";
import { diskContains, sha256, storageFixture } from "./storage-fixtures.js";

const endpoints = [
  ["POST", "/v1/credentials"],
  ["DELETE", "/v1/credentials/current"],
] as const;
const writes = [
  "store issue",
  "store revoke",
  "helper issue",
  "helper revoke",
] as const;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: Parameters<typeof httpFixture>[0] = {}) {
  const f = await httpFixture(options);
  cleanups.push(() => f.cleanup());
  return f;
}

function state(storage: StorageFixture) {
  return snapshot(storage, (db) => ({
    clients: db.prepare("SELECT * FROM clients ORDER BY rowid").all(),
    credentials: db
      .prepare(
        "SELECT credential_id, client_id, version, revoked_at FROM credentials ORDER BY rowid",
      )
      .all() as {
      credential_id: string;
      client_id: string;
      version: number;
      revoked_at: number | null;
    }[],
    jobs: db.prepare("SELECT * FROM jobs ORDER BY rowid").all(),
    attempts: db.prepare("SELECT * FROM attempts ORDER BY rowid").all(),
    slot: db.prepare("SELECT * FROM execution_slot").all(),
  }));
}

function unreadBytes(f: ResultHttpFixture) {
  let bytes = 0;
  const observe = (req: IncomingMessage) => {
    const read = req.read.bind(req);
    req.read = (size?: number) => {
      const value = read(size);
      if (value !== null) bytes += Buffer.byteLength(value);
      return value;
    };
  };
  f.server.prependListener("request", observe);
  f.server.prependListener("checkContinue", observe);
  return () => bytes;
}

function error(
  result: HttpResult,
  status: number,
  code: string,
  f: ResultHttpFixture,
  keys: readonly string[] = [],
) {
  expect(result.status).toBe(status);
  expect(result.body.code === code).toBe(true);
  for (const value of [
    f.storage.directory,
    f.storage.initialized.credential.key,
    ...keys,
  ])
    expect(result.raw.includes(value)).toBe(false);
  expect(
    /authorization|key_digest|"stack"|\/v1\/credentials|Bearer /i.test(
      result.raw,
    ),
  ).toBe(false);
}

async function success(
  f: ResultHttpFixture,
  method: string,
  path: string,
  authorization = f.auth(),
) {
  const connection = f.start(method, path, {
    authorization,
    "content-length": 0,
  });
  let cache: unknown;
  connection.req.once("response", (response) => {
    cache = response.headers["cache-control"];
  });
  connection.req.end();
  const result = await connection.result;
  expect(result.status).toBe(200);
  expect(result.body.code === "ok").toBe(true);
  expect(cache === "no-store").toBe(true);
  expect(result.raw.includes(f.storage.initialized.credential.key)).toBe(false);
  expect(result.raw.includes(f.storage.directory)).toBe(false);
  expect(/authorization|key_digest|"stack"|Bearer /i.test(result.raw)).toBe(
    false,
  );
  return result;
}

async function issue(f: ResultHttpFixture, authorization = f.auth()) {
  const result = await success(f, "POST", "/v1/credentials", authorization);
  expect(
    Object.keys(result.body.data).sort().join(",") === "credential,serviceId",
  ).toBe(true);
  expect(
    result.body.data.serviceId === f.storage.store.identity.serviceId,
  ).toBe(true);
  const credential = result.body.data.credential as IssuedCredential;
  expect(credential !== null && typeof credential === "object").toBe(true);
  expect(
    Object.keys(credential).sort().join(",") ===
      "clientId,credentialId,key,version",
  ).toBe(true);
  expect(
    typeof credential.key === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(credential.key),
  ).toBe(true);
  expect(
    Buffer.from(credential.key, "base64url").toString("base64url") ===
      credential.key,
  ).toBe(true);
  expect(
    authenticate(f.storage.store, `Bearer ${credential.key}`).credentialId ===
      credential.credentialId,
  ).toBe(true);
  return credential;
}

function write(
  mode: (typeof writes)[number],
  store: EnhancementStore,
  target: IssuedCredential,
  principal: AuthenticatedClient,
) {
  const options = { clientId: target.clientId };
  if (mode === "store issue")
    return Reflect.apply(store.issueCredential, store, [
      sha256(randomBytes(32)),
      options,
      principal,
    ]);
  if (mode === "store revoke")
    return Reflect.apply(store.revokeCredential, store, [
      target.credentialId,
      principal,
    ]);
  if (mode === "helper issue")
    return Reflect.apply(rotateCredential, undefined, [
      store,
      options,
      principal,
    ]);
  return Reflect.apply(revokeCredential, undefined, [
    store,
    target.credentialId,
    principal,
  ]);
}

function capture(operation: () => unknown) {
  try {
    return { returned: true, value: operation(), code: undefined };
  } catch (failure) {
    return {
      returned: false,
      value: undefined,
      code: failure instanceof EnhancementError ? failure.code : undefined,
    };
  }
}

describe("online maintenance of the authenticated client's credentials", () => {
  it("issues, verifies and then self-revokes across busy jobs and a real restart without changing execution", async () => {
    let wakes = 0;
    const f = await fixture({
      onJobCommitted: () => {
        wakes++;
      },
    });
    const completed = await succeededThroughRunner(f, (cleanup) =>
      cleanups.push(cleanup),
    );
    await completed.runner.close();
    const running = await f.upload(completed.bytes, "credentials-running");
    expect(running.status).toBe(202);
    const attempt = f.storage.store.claimNext("credentials-busy-fixture");
    expect(attempt?.identity.jobId).toBe(jobOf(running).jobId);
    const queued = await f.upload(completed.bytes, "credentials-queued");
    expect(queued.status).toBe(202);
    const jobs = [
      f.storage.store.getOwned(f.storage.principal(), jobOf(running).jobId),
      jobOf(queued),
      completed.succeeded,
    ];
    expect(jobs.map((job) => job.status)).toEqual([
      "running",
      "queued",
      "succeeded",
    ]);
    const other = createClient(f.storage.store);
    const otherAuth = { authorization: `Bearer ${other.key}` };
    const before = state(f.storage);
    const identity = f.storage.store.identity;
    const config = f.config;
    const inputs = await f.inputNames();
    const wakeCount = wakes;
    f.setReady(false);
    expect((await f.call("GET", "/v1/capabilities")).body.data.ready).toBe(
      false,
    );
    const next = await issue(f);
    expect(next.clientId).toBe(f.storage.initialized.credential.clientId);
    expect(next.credentialId).not.toBe(
      f.storage.initialized.credential.credentialId,
    );
    expect(next.version).toBe(f.storage.initialized.credential.version + 1);
    expect(next.key === f.storage.initialized.credential.key).toBe(false);
    const nextAuth = { authorization: `Bearer ${next.key}` };
    expect((await f.call("GET", "/healthz", undefined, nextAuth)).status).toBe(
      200,
    );
    for (const authorization of [f.auth(), nextAuth.authorization]) {
      for (const job of jobs) {
        const result = await f.call(
          "GET",
          `/v1/enhancement-jobs/${job.jobId}`,
          undefined,
          { authorization },
        );
        expect(result.status).toBe(200);
        expect(isDeepStrictEqual(jobOf(result), job)).toBe(true);
      }
      const result = await requestBinary(
        f,
        `/v1/enhancement-jobs/${completed.succeeded.jobId}/result`,
        { authorization },
      );
      expect(result.status).toBe(200);
      expect(result.bytes).toEqual(completed.png);
    }
    const revoked = await success(f, "DELETE", "/v1/credentials/current");
    expect(isDeepStrictEqual(revoked.body.data, { revoked: true })).toBe(true);
    const base = `/v1/enhancement-jobs/${completed.succeeded.jobId}`;
    for (const [method, path] of [
      ["GET", "/healthz"],
      ["GET", "/v1/capabilities"],
      ["POST", "/v1/enhancement-jobs"],
      ["GET", base],
      ["DELETE", base],
      ["GET", `${base}/result`],
      ["POST", `${base}/receipt`],
      ...endpoints,
    ] as const)
      error(await f.call(method, path), 401, "authentication_failed", f, [
        next.key,
        other.key,
      ]);
    expect((await f.call("GET", "/healthz", undefined, nextAuth)).status).toBe(
      200,
    );
    expect((await f.call("GET", "/healthz", undefined, otherAuth)).status).toBe(
      200,
    );
    error(
      await f.call("GET", base, undefined, otherAuth),
      404,
      "job_not_found",
      f,
      [next.key, other.key],
    );
    await f.restart();
    expect(f.storage.store.identity).toEqual(identity);
    for (const job of jobs) {
      const result = await f.call(
        "GET",
        `/v1/enhancement-jobs/${job.jobId}`,
        undefined,
        nextAuth,
      );
      expect(result.status).toBe(200);
      expect(isDeepStrictEqual(jobOf(result), job)).toBe(true);
    }
    error(await f.call("GET", "/healthz"), 401, "authentication_failed", f, [
      next.key,
    ]);
    expect((await f.call("GET", "/healthz", undefined, otherAuth)).status).toBe(
      200,
    );
    const after = state(f.storage);
    expect(after.clients).toEqual(before.clients);
    expect(after.jobs).toEqual(before.jobs);
    expect(after.attempts).toEqual(before.attempts);
    expect(after.slot).toEqual(before.slot);
    expect(after.credentials).toEqual([
      { ...before.credentials[0]!, revoked_at: f.storage.clock() },
      before.credentials[1],
      {
        credential_id: next.credentialId,
        client_id: next.clientId,
        version: next.version,
        revoked_at: null,
      },
    ]);
    expect(await f.original(jobOf(queued))).toEqual(completed.bytes);
    const downloaded = await requestBinary(f, `${base}/result`, nextAuth);
    expect(downloaded.status).toBe(200);
    expect(downloaded.bytes).toEqual(completed.png);
    expect(await f.inputNames()).toEqual(inputs);
    expect(f.config).toBe(config);
    expect(wakes).toBe(wakeCount);
    for (const key of [
      f.storage.initialized.credential.key,
      next.key,
      other.key,
    ])
      expect(await diskContains(f.storage.directory, key)).toBe(false);
  });

  it("keeps the original key usable after a lost issuance response and only issues again on an explicit request", async () => {
    const f = await fixture();
    const before = state(f.storage);
    const connection = f.start("POST", "/v1/credentials", {
      authorization: f.auth(),
      "content-length": 0,
    });
    const lost = new Promise<void>((resolve) => {
      connection.req.once("response", () => {
        connection.req.destroy();
        resolve();
      });
    });
    connection.req.end();
    await lost;
    const afterLoss = state(f.storage);
    expect(afterLoss.credentials.length).toBe(before.credentials.length + 1);
    expect((await f.call("GET", "/healthz")).status).toBe(200);
    const next = await issue(f);
    expect(next.version).toBe(f.storage.initialized.credential.version + 2);
    expect(
      next.credentialId === afterLoss.credentials.at(-1)?.credential_id,
    ).toBe(false);
    expect(state(f.storage).credentials.length).toBe(
      before.credentials.length + 2,
    );
    expect((await f.call("GET", "/healthz")).status).toBe(200);
    expect(
      (
        await f.call("GET", "/healthz", undefined, {
          authorization: `Bearer ${next.key}`,
        })
      ).status,
    ).toBe(200);
    expect(await diskContains(f.storage.directory, next.key)).toBe(false);
  });

  it.each(["missing", "wrong", "revoked", "duplicate", "malformed"] as const)(
    "rejects %s authentication before body, route or method with no writes",
    async (kind) => {
      const f = await fixture();
      const readBytes = unreadBytes(f);
      const wrong = randomBytes(32).toString("base64url");
      if (kind === "revoked")
        revokeCredential(
          f.storage.store,
          f.storage.initialized.credential.credentialId,
        );
      const before = state(f.storage);
      const authorization =
        kind === "wrong"
          ? `Bearer ${wrong}`
          : kind === "malformed"
            ? "Basic invalid"
            : f.auth();
      const headers =
        kind === "missing"
          ? {}
          : kind === "duplicate"
            ? ["Authorization", f.auth(), "authorization", f.auth()]
            : { authorization };
      for (const [method, path] of [
        ...endpoints,
        ["PATCH", "/v1/credentials"],
        ["GET", "/v1/credentials/unknown"],
      ] as const)
        error(
          await f.call(
            method,
            path,
            Buffer.from("unread-credential-body"),
            headers,
          ),
          401,
          "authentication_failed",
          f,
          [wrong],
        );
      expect(readBytes()).toBe(0);
      expect(state(f.storage)).toEqual(before);
      expect(await f.inputNames()).toEqual([]);
    },
  );

  it.each([
    ["GET", "/v1/credentials", 405, "method_not_allowed"],
    ["DELETE", "/v1/credentials", 405, "method_not_allowed"],
    ["POST", "/v1/credentials/current", 405, "method_not_allowed"],
    ["PATCH", "/v1/credentials/current", 405, "method_not_allowed"],
    ["DELETE", "/v1/credentials/unknown", 404, "route_not_found"],
  ] as const)(
    "keeps the authenticated %s %s route contract",
    async (method, path, status, code) => {
      const f = await fixture();
      const before = state(f.storage);
      error(await f.call(method, path), status, code, f);
      expect(state(f.storage)).toEqual(before);
    },
  );

  it.each([
    "body selector",
    "query selector",
    "empty query",
    "chunked",
    "unfinished length",
  ] as const)(
    "rejects %s on both endpoints without consuming bytes or selecting another client",
    async (kind) => {
      const f = await fixture();
      const other = createClient(f.storage.store);
      const before = state(f.storage);
      const readBytes = unreadBytes(f);
      for (const [method, endpoint] of endpoints) {
        const path =
          endpoint +
          (kind === "query selector"
            ? `?clientId=${other.clientId}&credentialId=${other.credentialId}`
            : kind === "empty query"
              ? "?"
              : "");
        let result: HttpResult;
        if (kind === "unfinished length") {
          const connection = f.start(method, path, {
            authorization: f.auth(),
            "content-length": 1,
          });
          connection.req.flushHeaders();
          result = await connection.result;
          connection.req.destroy();
        } else {
          const body =
            kind === "body selector"
              ? Buffer.from(
                  JSON.stringify({
                    clientId: other.clientId,
                    credentialId: other.credentialId,
                  }),
                )
              : undefined;
          result = await f.call(method, path, body, {
            authorization: f.auth(),
            ...(kind === "chunked" ? { "transfer-encoding": "chunked" } : {}),
          });
        }
        error(result, 400, "invalid_request", f, [other.key]);
      }
      expect(readBytes()).toBe(0);
      expect(state(f.storage)).toEqual(before);
      expect((await f.call("GET", "/healthz")).status).toBe(200);
      expect(
        (
          await f.call("GET", "/healthz", undefined, {
            authorization: `Bearer ${other.key}`,
          })
        ).status,
      ).toBe(200);
      expect(await f.inputNames()).toEqual([]);
    },
  );

  it.each(["body", "query"] as const)(
    "does not let a verified new key select the old key through %s",
    async (selector) => {
      const f = await fixture();
      const next = await issue(f);
      const before = state(f.storage);
      const headers = { authorization: `Bearer ${next.key}` };
      const { clientId, credentialId } = f.storage.initialized.credential;
      for (const [method, endpoint] of endpoints) {
        const path =
          endpoint +
          (selector === "query"
            ? `?clientId=${clientId}&credentialId=${credentialId}`
            : "");
        const body =
          selector === "body"
            ? Buffer.from(JSON.stringify({ clientId, credentialId }))
            : undefined;
        error(
          await f.call(method, path, body, headers),
          400,
          "invalid_request",
          f,
          [next.key],
        );
      }
      expect(state(f.storage)).toEqual(before);
      expect((await f.call("GET", "/healthz")).status).toBe(200);
      expect((await f.call("GET", "/healthz", undefined, headers)).status).toBe(
        200,
      );
    },
  );

  it.each([false, true])(
    "rejects Expect bodies with authenticated=%s without 100 Continue",
    async (authenticated) => {
      const f = await fixture();
      const before = state(f.storage);
      const readBytes = unreadBytes(f);
      for (const [method, path] of endpoints) {
        const connection = f.start(method, path, {
          ...(authenticated ? { authorization: f.auth() } : {}),
          expect: "100-continue",
          "content-length": 1,
        });
        let continued = 0;
        let close: unknown;
        connection.req.on("continue", () => {
          continued++;
          connection.req.end("x");
        });
        connection.req.once("response", (response) => {
          close = response.headers.connection;
        });
        connection.req.flushHeaders();
        const result = await connection.result;
        connection.req.destroy();
        error(
          result,
          authenticated ? 400 : 401,
          authenticated ? "invalid_request" : "authentication_failed",
          f,
        );
        expect(continued).toBe(0);
        expect(close === "close").toBe(true);
      }
      expect(readBytes()).toBe(0);
      expect(state(f.storage)).toEqual(before);
    },
  );

  it.each(
    endpoints.flatMap(([method, path]) =>
      ["revoke", "close"].map((fault) => ({ method, path, fault })),
    ),
  )(
    "rechecks $fault after the real clock returns during $method $path",
    async ({ method, path, fault }) => {
      const f = await fixture();
      const now = f.storage.clock;
      let armed = false;
      let calls = 0;
      f.storage.clock = () => {
        const value = now();
        if (armed) {
          armed = false;
          calls++;
          if (fault === "revoke")
            revokeCredential(
              f.storage.store,
              f.storage.initialized.credential.credentialId,
            );
          else f.storage.store.close();
        }
        return value;
      };
      await f.restart();
      const before = state(f.storage);
      armed = true;
      error(
        await f.call(method, path),
        fault === "revoke" ? 401 : 503,
        fault === "revoke" ? "authentication_failed" : "internal_error",
        f,
      );
      expect(calls).toBe(1);
      await f.restart();
      const after = state(f.storage);
      expect(
        after.credentials.map(
          ({ revoked_at: _revoked, ...identity }) => identity,
        ),
      ).toEqual(
        before.credentials.map(
          ({ revoked_at: _revoked, ...identity }) => identity,
        ),
      );
      expect(after.clients).toEqual(before.clients);
      expect(after.jobs).toEqual(before.jobs);
      expect(after.attempts).toEqual(before.attempts);
      expect(after.slot).toEqual(before.slot);
    },
  );
});

describe("authenticated credential writes retain the Store's final authority and commit boundary", () => {
  it.each(
    writes.flatMap((mode) =>
      [
        "forged",
        "foreign",
        "revoked",
        "closed",
        "other client",
        ...(mode.endsWith("revoke") ? ["other credential"] : []),
      ].map((reason) => ({ mode, reason })),
    ),
  )(
    "$mode rejects a $reason principal or target without writing",
    async ({ mode, reason }) => {
      const f = await storageFixture();
      cleanups.push(() => f.cleanup());
      let principal = f.principal();
      let target = f.initialized.credential;
      if (reason === "forged") principal = { ...principal };
      if (reason === "foreign") {
        const other = await storageFixture();
        cleanups.push(() => other.cleanup());
        principal = other.principal();
      }
      if (reason === "revoked") revokeCredential(f.store, target.credentialId);
      if (reason === "closed") f.store.close();
      if (reason === "other client") target = createClient(f.store);
      if (reason === "other credential")
        target = rotateCredential(f.store, { clientId: target.clientId });
      const before = state(f);
      const outcome = capture(() => write(mode, f.store, target, principal));
      expect(outcome.returned).toBe(false);
      expect(
        reason.startsWith("other ")
          ? outcome.code === "authentication_failed" ||
              outcome.code === "invalid_request"
          : outcome.code ===
              (reason === "closed"
                ? "internal_error"
                : "authentication_failed"),
      ).toBe(true);
      expect(state(f)).toEqual(before);
    },
  );

  it.each(writes)(
    "%s cannot report success inside an actual outer Store transaction that rolls back",
    async (mode) => {
      const f = await storageFixture();
      cleanups.push(() => f.cleanup());
      let armed = false;
      let calls = 0;
      let nested: ReturnType<typeof capture> | undefined;
      f.store.close();
      f.setStore(
        openStore({
          directory: f.directory,
          clock() {
            const now = f.clock();
            if (armed) {
              armed = false;
              calls++;
              nested = capture(() =>
                write(mode, f.store, f.initialized.credential, principal),
              );
              throw new Error(
                "fixture outer credential transaction rolls back",
              );
            }
            return now;
          },
        }),
      );
      const principal = f.principal();
      const before = state(f);
      armed = true;
      const outer = capture(() =>
        f.store.issueCredential(sha256(randomBytes(32))),
      );
      expect(outer.returned).toBe(false);
      expect(outer.code === "internal_error").toBe(true);
      expect(calls).toBe(1);
      expect(nested?.returned).toBe(false);
      expect(nested?.code === "internal_error").toBe(true);
      expect(state(f)).toEqual(before);
    },
  );
});
