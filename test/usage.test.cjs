const assert = require('node:assert/strict');
const { mkdtemp, realpath, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { basename, dirname, join } = require('node:path');
const { test } = require('node:test');
const { UsageStore } = require('../out/usage');
const { expectedUsage } = require('./fixture.cjs');

test('usage history combines outcomes, response timing and token samples across hosts and versions', async t => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, 'custom-api-usage-'));
  t.after(async () => {
    const resolved = await realpath(directory);
    if (dirname(resolved) === root && basename(resolved).startsWith('custom-api-usage-')) {
      await rm(resolved, { recursive: true, force: true });
    }
  });
  const first = new UsageStore(directory, () => {});
  const second = new UsageStore(directory, () => {});
  const source = { providerId: 'a', provider: 'A', modelId: 'sample', model: 'Sample' };
  const counts = expectedUsage('responses');
  first.record(source, { outcome: 'success', usage: counts, timing: { mode: 'stream', firstTextMs: 650, textSpanMs: 250 } });
  first.record(source, { outcome: 'success', timing: { mode: 'stream', firstTextMs: 450, textSpanMs: 200 } });
  second.record(source, {
    outcome: 'success', timing: { mode: 'json', durationMs: 800 }, usage: { ...counts, prompt_tokens_details: undefined },
  });
  second.record(source, { outcome: 'failure' });
  second.record({ ...source, providerId: 'b', provider: 'B' }, { outcome: 'failure' });
  second.record({ ...source, providerId: 'c', provider: 'C' }, {
    outcome: 'success', timing: { mode: 'stream', firstTextMs: 100, textSpanMs: 0 },
    usage: { ...counts, prompt_tokens_details: { cached_tokens: 0 } },
  });
  await Promise.all([first.flush(), second.flush()]);

  const reopened = new UsageStore(directory, () => {});
  const { days } = await reopened.read(7);
  const filename = '00000000-0000-4000-8000-000000000000.jsonl';
  const record = JSON.stringify({ ...source, usage: counts });
  const oldTiming = JSON.stringify({ ...source, outcome: 'success', durationMs: 2000 });
  await writeFile(join(directory, `${days.at(-1)}-${filename}`), `${record}\n${oldTiming}\nnull\ninvalid\n${record}`);
  await writeFile(join(directory, `2000-01-01-${filename}`), `${record}\n`);

  const { rows, writeFailed } = await reopened.read(90);
  assert.equal(writeFailed, false);
  const noTiming = { firstTextMs: 0, firstTextSamples: 0, nonStreamMs: 0, nonStreamSamples: 0,
    tpsTokens: 0, tpsMs: 0 };
  assert.deepEqual(rows.sort((a, b) => a.providerId.localeCompare(b.providerId)), [
    { ...source, day: days.at(-1), requests: 6, failed: 1, legacyRequests: 1,
      firstTextMs: 1100, firstTextSamples: 2, nonStreamMs: 800, nonStreamSamples: 1,
      tpsTokens: 199, tpsMs: 1050,
      reported: 3, input: 1260, output: 390, total: 1650, cached: 160, cacheInput: 840, reasoning: 90,
      cachedReported: 2, reasoningReported: 3 },
    { ...source, providerId: 'b', provider: 'B', day: days.at(-1), requests: 1, failed: 1, legacyRequests: 0,
      ...noTiming, reported: 0, input: 0, output: 0, total: 0, cached: 0, cacheInput: 0, reasoning: 0,
      cachedReported: 0, reasoningReported: 0 },
    { ...source, providerId: 'c', provider: 'C', day: days.at(-1), requests: 1, failed: 0, legacyRequests: 0,
      ...noTiming, firstTextMs: 100, firstTextSamples: 1, reported: 1,
      input: 420, output: 130, total: 550, cached: 0, cacheInput: 420, reasoning: 30,
      cachedReported: 1, reasoningReported: 1 },
  ]);
});
