import type { AdapterOutput } from './types.js';

export interface MessageBatch {
  key: string;
  channel: string | undefined;
  messages: AdapterOutput[];
  windowStart: Date;
}

const BATCH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

const batches = new Map<string, {
  messages: AdapterOutput[];
  windowStart: Date;
}>();

export function addToBatch(output: AdapterOutput): void {
  const key = `${output.source.platform}:${output.source.channel || 'default'}`;
  const existing = batches.get(key);

  if (existing) {
    existing.messages.push(output);
  } else {
    batches.set(key, {
      messages: [output],
      windowStart: new Date(),
    });
  }
}

export function flushReadyBatches(): MessageBatch[] {
  const now = Date.now();
  const ready: MessageBatch[] = [];

  for (const [key, batch] of batches.entries()) {
    if (now - batch.windowStart.getTime() >= BATCH_WINDOW_MS) {
      ready.push({
        key,
        channel: key.split(':').slice(1).join(':') || undefined,
        messages: batch.messages,
        windowStart: batch.windowStart,
      });
      batches.delete(key);
    }
  }

  return ready;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startBatchTimer(
  onFlush: (batches: MessageBatch[]) => Promise<void>,
  intervalMs: number = 30000
): void {
  if (timer) return;

  timer = setInterval(async () => {
    const ready = flushReadyBatches();
    if (ready.length > 0) {
      await onFlush(ready);
    }
  }, intervalMs);
}

export function stopBatchTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function flushAll(): MessageBatch[] {
  const all: MessageBatch[] = [];
  for (const [key, batch] of batches.entries()) {
    all.push({
      key,
      channel: key.split(':').slice(1).join(':') || undefined,
      messages: batch.messages,
      windowStart: batch.windowStart,
    });
  }
  batches.clear();
  return all;
}
