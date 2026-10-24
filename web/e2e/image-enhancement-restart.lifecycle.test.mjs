import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeRestartEvidence } from "./image-enhancement-restart.lifecycle.mjs";

test("restart evidence preserves facts and hashes structured credentials", () => {
    const value = sanitizeRestartEvidence({ pid: 123, status: "running", token: "fixture-structured", url: "http://127.0.0.1:123/test" });
    assert.equal(value.pid, 123);
    assert.equal(value.status, "running");
    assert.equal(value.token.sha256.length, 64);
    assert.doesNotMatch(value.url, /127/);
});

test("restart request errors remove embedded headers and retain failure meaning", () => {
    const value = sanitizeRestartEvidence({
        message: "apiRequestContext.post: socket hang up\nCall log:\n - POST http://127.0.0.1/test\n - Authorization: Bearer fixture-auth-secret\n - Cookie: session=fixture-session-secret\n",
        stack: "Error: socket hang up\n - cOoKiE: session=fixture-stack-secret\n",
        phase: "submit",
    });
    assert.doesNotMatch(JSON.stringify(value), /fixture-auth-secret|fixture-session-secret|fixture-stack-secret/);
    assert.match(value.message, /socket hang up/);
    assert.equal(value.phase, "submit");
});

test("restart structured headers are redacted regardless of capitalization", () => {
    const value = sanitizeRestartEvidence({ headers: { Authorization: "fixture-mixed-auth", Cookie: "fixture-mixed-cookie", "Set-Cookie": "fixture-set-cookie" } });
    assert.doesNotMatch(JSON.stringify(value), /fixture-mixed-auth|fixture-mixed-cookie|fixture-set-cookie/);
});
