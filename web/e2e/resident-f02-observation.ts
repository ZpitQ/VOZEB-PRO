import { setTimeout } from "node:timers/promises";

import type { APIRequestContext } from "@playwright/test";

type ReadSample = { startedAt: number; elapsedMs: number; headersElapsedMs?: number; status?: number; runStatus?: string; error?: string };
type StreamFrame = { observedAt: number; event: string; id: string; frame: string };

export async function observeResidentF02(request: APIRequestContext, origin: string, runId: string) {
    const state = await request.storageState();
    const cookie = state.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
    const streamStop = new AbortController();
    const evidence = {
        version: "resident-f02-observation.v1",
        runId,
        startedAt: Date.now(),
        stoppedAt: 0,
        healthRequestTimeoutMs: 5000,
        statusRequestTimeoutMs: 5000,
        health: [] as ReadSample[],
        task: [] as ReadSample[],
        failures: [] as string[],
        sse: { status: 0, contentType: "", requestedAt: 0, openedAt: 0, closedAt: 0, naturalClose: false, frames: [] as StreamFrame[] },
    };
    let stopping = false;
    let streamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    async function read(kind: "health" | "task") {
        const startedAt = Date.now();
        const started = performance.now();
        const path = kind === "health" ? "/api/health/live" : `/api/agent/runs/${encodeURIComponent(runId)}`;
        const sample: ReadSample = { startedAt, elapsedMs: 0 };
        try {
            const response = await fetch(new URL(path, origin), { headers: { cookie }, signal: AbortSignal.timeout(5000), cache: "no-store", redirect: "error" });
            sample.headersElapsedMs = performance.now() - started;
            sample.status = response.status;
            if (kind === "task" && response.ok) {
                const payload: { data: { run: { id: string; status: string } } } = await response.json();
                if (payload.data.run.id !== runId) throw new Error("Task observation returned another Run");
                sample.runStatus = payload.data.run.status;
            } else {
                await response.arrayBuffer();
            }
            if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
        } catch (error) {
            sample.error = error instanceof Error ? error.message : String(error);
            evidence.failures.push(`${kind}: ${sample.error}`);
        } finally {
            sample.elapsedMs = performance.now() - started;
            if (sample.elapsedMs > 5000) evidence.failures.push(`${kind}: read exceeded the frozen 5000ms window`);
            evidence[kind].push(sample);
        }
    }

    const reads = (async () => {
        while (!stopping) {
            await Promise.all([read("health"), read("task")]);
            // Match the existing waitForRun cadence; this is a recorder, not a driver.
            if (!stopping) await setTimeout(500);
        }
    })();
    const stream = (async () => {
        try {
            evidence.sse.requestedAt = Date.now();
            const response = await fetch(new URL(`/api/agent/runs/${encodeURIComponent(runId)}/events`, origin), { headers: { cookie, "Last-Event-ID": "0" }, signal: streamStop.signal, cache: "no-store", redirect: "error" });
            evidence.sse.status = response.status;
            evidence.sse.contentType = response.headers.get("content-type") || "";
            evidence.sse.openedAt = Date.now();
            if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status} or missing body`);
            const reader = response.body.getReader();
            streamReader = reader;
            const decoder = new TextDecoder();
            let pending = "";
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) {
                    evidence.sse.naturalClose = !stopping;
                    break;
                }
                pending += decoder.decode(chunk.value, { stream: true });
                let end = pending.indexOf("\n\n");
                while (end !== -1) {
                    const frame = pending.slice(0, end);
                    const lines = frame.split("\n");
                    evidence.sse.frames.push({ observedAt: Date.now(), event: lines.find((line) => line.startsWith("event: "))?.slice(7) || "", id: lines.find((line) => line.startsWith("id: "))?.slice(4) || "", frame });
                    pending = pending.slice(end + 2);
                    end = pending.indexOf("\n\n");
                }
            }
        } catch (error) {
            if (!(streamStop.signal.aborted && error instanceof Error && error.name === "AbortError")) evidence.failures.push(`sse: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            evidence.sse.closedAt = Date.now();
        }
    })();

    return {
        terminal: stream,
        async close() {
            stopping = true;
            const readerClosed = streamReader?.cancel();
            streamStop.abort();
            await Promise.all([reads, stream, readerClosed]);
            evidence.stoppedAt = Date.now();
            return evidence;
        },
    };
}
