import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

// A real, controlled synthetic image executor. This is not Native, GPU inference or AI quality evidence.
assert.equal(process.env.VOZEB_PRO_M5_RESTART_REENTRY, "1");
assert.ok(process.send);
let binding;
let sequence = 0;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function durable(file, content) {
    const handle = await open(file, "wx");
    try {
        await handle.writeFile(content);
        await handle.sync();
    } finally {
        await handle.close();
    }
}
process.on("message", async (message) => {
    try {
        if (message.kind === "bind") {
            assert.equal(binding, undefined);
            assert.ok(path.basename(message.root).startsWith("vozeb-m5-business-"));
            assert.equal(path.resolve(message.root), path.resolve(process.env.VOZEB_PRO_M5_BUSINESS_DATA_DIR));
            assert.equal(message.runId, process.env.VOZEB_PRO_M5_BUSINESS_RUN_ID);
            const raw = await readFile(`/proc/${process.pid}/stat`, "utf8");
            const fields = raw
                .slice(raw.lastIndexOf(")") + 2)
                .trim()
                .split(/\s+/);
            binding = { ...message, pid: process.pid, parentPid: process.ppid, startTicks: fields[19], startedAt: Date.now() };
            assert.equal(digest(await readFile(message.nativePath)), message.nativeSha256);
            const started = { kind: "started", pid: binding.pid, parentPid: binding.parentPid, startTicks: binding.startTicks, executionId: binding.executionId, runId: binding.runId, jobId: binding.jobId, key: binding.key, startedAt: binding.startedAt };
            await durable(path.join(binding.directory, "executor-start.json"), JSON.stringify(started));
            process.send(started);
        } else if (message.kind === "probe") {
            assert.ok(binding);
            process.send({ kind: "probe", challenge: message.challenge, pid: process.pid, startTicks: binding.startTicks, executionId: binding.executionId, jobId: binding.jobId, key: binding.key, sequence: ++sequence, observedAt: Date.now() });
        } else if (message.kind === "complete") {
            assert.ok(binding);
            assert.equal(message.executionId, binding.executionId);
            const bytes = await sharp({ create: { width: 5016, height: 5016, channels: 3, background: "#51869d" } })
                .png({ palette: true, colours: 2 })
                .toBuffer();
            const result = { width: 5016, height: 5016, format: "png", byteLength: bytes.length, sha256: digest(bytes) };
            assert.deepEqual(result, binding.expected);
            await durable(path.join(binding.directory, "executor-output.png"), bytes);
            const completed = { kind: "completed", pid: process.pid, startTicks: binding.startTicks, executionId: binding.executionId, jobId: binding.jobId, key: binding.key, completedAt: Date.now(), result, sequence };
            await durable(path.join(binding.directory, "executor-completed.json"), JSON.stringify(completed));
            process.send(completed, () => process.disconnect());
        } else throw new Error("Unknown controlled executor IPC operation");
    } catch (error) {
        process.exitCode = 1;
        if (process.connected) process.send({ kind: "error", error: error.message }, () => process.disconnect());
    }
});
