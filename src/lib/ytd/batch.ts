/**
 * ZIP batch registry — one playlist download = ONE prepared batch = ONE zip.
 * ... (see download-zip route)
 */

import { getJob } from "./jobs";

export type BatchItemStatus = "queued" | "running" | "done" | "failed" | "skipped";

export type BatchItem = {
  videoId: string;
  title: string;
  author: string;
  index: number;
  status: BatchItemStatus;
  pct?: number;
  speed?: string;
  eta?: string;
  sizeBytes?: number;
  fileName?: string;
  error?: string;
  jobKey?: string;
};

export type BatchStatus = "prepared" | "running" | "complete" | "cancelled" | "abandoned";

export type Batch = {
  id: string;
  status: BatchStatus;
  bitrate: number;
  title: string;
  items: BatchItem[];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** true once the whole zip body reached the browser (honest "Sent ✓") */
  delivered?: boolean;
  zipBytes?: number;
  zipFileName?: string;
  controller: AbortController;
};

const TTL_MS = 60 * 60_000; // 60 min, like a big batch deserves
const MAX_ITEMS = 500;

const g = globalThis as unknown as { __tlBatches?: Map<string, Batch> };
const batches: Map<string, Batch> = g.__tlBatches ?? (g.__tlBatches = new Map<string, Batch>());

let sweepTimer: ReturnType<typeof setInterval> | null = null;
function ensureSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const cut = Date.now() - TTL_MS;
    for (const [id, b] of batches) {
      if (b.createdAt < cut && (b.status !== "running" || Date.now() - (b.startedAt ?? 0) > TTL_MS)) {
        batches.delete(id);
      }
    }
  }, 60_000);
  sweepTimer.unref?.();
}

function newId(): string {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export type CreateBatchInput = {
  bitrate: number;
  title: string;
  items: Array<{ videoId: string; title: string; author: string }>;
};

export function createBatch(input: CreateBatchInput): Batch {
  ensureSweep();
  const batch: Batch = {
    id: newId(),
    status: "prepared",
    bitrate: input.bitrate,
    title: input.title.slice(0, 150) || "Playlist",
    items: input.items.slice(0, MAX_ITEMS).map((t, i) => ({
      videoId: t.videoId,
      title: t.title,
      author: t.author,
      index: i,
      status: "queued" as BatchItemStatus,
    })),
    createdAt: Date.now(),
    controller: new AbortController(),
  };
  batches.set(batch.id, batch);
  // keep the registry small: drop oldest non-running batches beyond 20
  if (batches.size > 20) {
    const olds = [...batches.entries()]
      .filter(([, b]) => b.status !== "running")
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [id] of olds.slice(0, batches.size - 20)) batches.delete(id);
  }
  return batch;
}

export function getBatch(id: string): Batch | null {
  return batches.get(id) ?? null;
}

export function markRunning(batch: Batch) {
  if (batch.status === "prepared") {
    batch.status = "running";
    batch.startedAt = Date.now();
  }
}

export function markDelivered(batch: Batch, bytes: number, fileName: string) {
  batch.delivered = true;
  batch.zipBytes = bytes;
  batch.zipFileName = fileName;
  if (batch.status === "running") {
    batch.status = "complete";
    batch.finishedAt = Date.now();
  }
}

export function cancelBatch(batch: Batch): boolean {
  if (batch.status === "running" || batch.status === "prepared") {
    batch.status = "cancelled";
    batch.finishedAt = Date.now();
    batch.controller.abort();
    return true;
  }
  return false;
}

/** a client walked away from the zip stream → the batch is abandoned */
export function markAbandoned(batch: Batch) {
  if (batch.status === "running") {
    batch.status = "abandoned";
    batch.finishedAt = Date.now();
  }
}

/** public view of a batch (controller stripped out) */
export function batchView(batch: Batch) {
  return {
    id: batch.id,
    status: batch.status,
    bitrate: batch.bitrate,
    title: batch.title,
    delivered: batch.delivered === true,
    zipBytes: batch.zipBytes,
    zipFileName: batch.zipFileName,
    createdAt: batch.createdAt,
    items: batch.items.map((it) => {
      let status = it.status;
      let pct = it.pct;
      let speed = it.speed;
      let eta = it.eta;
      // live engine job → row shows real progress while the zip is building
      const j = it.jobKey ? getJob(it.jobKey) : null;
      if (j && status !== "done" && status !== "failed" && status !== "skipped") {
        if (j.phase === "downloading" || j.phase === "encoding" || j.phase === "starting") {
          status = "running";
          pct = j.pct;
          speed = j.speed;
          eta = j.eta;
        } else if (j.phase === "queued") {
          status = "queued";
        }
      }
      return {
        videoId: it.videoId,
        index: it.index,
        status,
        pct,
        speed,
        eta,
        sizeBytes: it.sizeBytes,
        fileName: it.fileName,
        error: it.error,
      };
    }),
  };
}
