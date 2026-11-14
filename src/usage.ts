import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isObject, object, string } from './config';
import { TokenUsage, tokenCount } from './protocols/types';

export const usagePeriods = [1, 7, 30, 90] as const;
export type UsagePeriod = typeof usagePeriods[number];

interface UsageSource {
  providerId: string;
  provider: string;
  modelId: string;
  model: string;
}

export type ResponseTiming = { mode: 'stream'; firstTextMs?: number; textSpanMs?: number } |
  { mode: 'json'; durationMs: number };

type UsageResult = { outcome: 'success'; usage?: TokenUsage; timing: ResponseTiming } | { outcome: 'failure' };

interface DailyUsage extends UsageSource {
  day: string;
  requests: number;
  failed: number;
  legacyRequests: number;
  firstTextMs: number;
  firstTextSamples: number;
  nonStreamMs: number;
  nonStreamSamples: number;
  tpsTokens: number;
  tpsMs: number;
  reported: number;
  input: number;
  output: number;
  total: number;
  cached: number;
  cacheInput: number;
  reasoning: number;
  cachedReported: number;
  reasoningReported: number;
}

function dateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export class UsageStore {
  // Each extension host writes its own daily file. Other windows can read it
  // without a shared read-modify-write cycle.
  private readonly writer = randomUUID();
  private pending = Promise.resolve();
  private writeFailed = false;

  constructor(private readonly directory: string, private readonly changed: () => void) {}

  record(source: UsageSource, result: UsageResult): void {
    const day = dateKey(new Date());
    const record = { ...source, ...result };
    const file = join(this.directory, `${day}-${this.writer}.jsonl`);
    this.pending = this.pending.then(async () => {
      try {
        await mkdir(this.directory, { recursive: true });
        await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
      } catch {
        this.writeFailed = true;
      }
      this.changed();
    });
  }

  async read(period: UsagePeriod) {
    await this.pending;
    const end = new Date();
    const days = Array.from({ length: period }, (_, index) => {
      const date = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (period - index - 1));
      return dateKey(date);
    });
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      files = [];
    }
    const accepted = new Set(days);
    const aggregates = new Map<string, DailyUsage>();
    // A reader in another window may see an unfinished last line. It will
    // pick up that record on the next refresh.
    for (const name of files.sort()) {
      const day = name.slice(0, 10);
      if (!accepted.has(day) || !/^\d{4}-\d{2}-\d{2}-[a-f0-9-]{36}\.jsonl$/.test(name)) {
        continue;
      }
      const content = await readFile(join(this.directory, name), 'utf8');
      const lastCompleteLine = content.lastIndexOf('\n');
      if (lastCompleteLine === -1) {
        continue;
      }
      for (const line of content.slice(0, lastCompleteLine).split('\n')) {
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isObject(record)) {
          continue;
        }
        const providerId = string(record.providerId);
        const modelId = string(record.modelId);
        const outcome = record.outcome;
        if (!providerId || !modelId || (outcome !== undefined && outcome !== 'success' && outcome !== 'failure')) {
          continue;
        }
        const provider = string(record.provider) || providerId;
        const model = string(record.model) || modelId;
        const key = JSON.stringify([day, providerId, modelId]);
        const row = aggregates.get(key) ?? {
          day, providerId, provider, modelId, model,
          requests: 0, failed: 0, legacyRequests: 0,
          firstTextMs: 0, firstTextSamples: 0, nonStreamMs: 0, nonStreamSamples: 0,
          tpsTokens: 0, tpsMs: 0,
          reported: 0, input: 0, output: 0, total: 0,
          cached: 0, cacheInput: 0, reasoning: 0, cachedReported: 0, reasoningReported: 0,
        };
        row.provider = provider;
        row.model = model;
        row.requests++;
        aggregates.set(key, row);
        if (outcome === 'failure') {
          row.failed++;
          continue;
        }
        if (outcome === undefined) {
          row.legacyRequests++;
        }
        const usage = object(record.usage);
        const input = tokenCount(usage.prompt_tokens);
        const output = tokenCount(usage.completion_tokens);
        const total = tokenCount(usage.total_tokens);
        const reasoning = tokenCount(object(usage.completion_tokens_details).reasoning_tokens);
        const outputTokens = output === undefined ? undefined : Math.max(0, output - (reasoning ?? 0));
        const timing = object(record.timing);
        if (timing.mode === 'stream') {
          const firstText = tokenCount(timing.firstTextMs);
          const span = tokenCount(timing.textSpanMs);
          if (firstText !== undefined) {
            row.firstTextMs += firstText;
            row.firstTextSamples++;
            // The first output token has already arrived when the measured interval starts.
            if (span && outputTokens !== undefined && outputTokens > 1) {
              row.tpsTokens += outputTokens - 1;
              row.tpsMs += span;
            }
          }
        } else if (timing.mode === 'json') {
          const duration = tokenCount(timing.durationMs);
          if (duration !== undefined) {
            row.nonStreamMs += duration;
            row.nonStreamSamples++;
            if (duration && outputTokens !== undefined) {
              row.tpsTokens += outputTokens;
              row.tpsMs += duration;
            }
          }
        }
        if (input !== undefined && output !== undefined && total !== undefined) {
          const cached = tokenCount(object(usage.prompt_tokens_details).cached_tokens);
          row.reported++;
          row.input += input;
          row.output += output;
          row.total += total;
          if (cached !== undefined && cached <= input) {
            row.cached += cached;
            row.cacheInput += input;
            row.cachedReported++;
          }
          row.reasoning += reasoning ?? 0;
          row.reasoningReported += Number(reasoning !== undefined);
        }
      }
    }
    return { days, rows: [...aggregates.values()], writeFailed: this.writeFailed };
  }

  flush(): Promise<void> {
    return this.pending;
  }
}
