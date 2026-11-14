const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { catalogUrl, fetchCatalog } = require('../out/catalog');
const { readProviderDraft } = require('../out/manager-config');
const { indexMetadata, resolveDefaults } = require('../out/model-metadata');
const { ChannelHealth, channelCooldownMs, groupChannels } = require('../out/routing');

const base = { name: 'Gateway', url: 'https://example.test/proxy/v1', auth: 'bearer', headers: {}, models: [] };

test('model discovery derives protocol routes and supports custom same-origin catalogs', async t => {
  assert.equal(catalogUrl({ ...base, protocol: 'responses' }).pathname, '/proxy/v1/models');
  assert.equal(catalogUrl({
    ...base, protocol: 'gemini-generate-content', fullUrl: true,
    url: 'https://example.test/v1beta/models/{model}:streamGenerateContent?alt=sse',
  }).href, 'https://example.test/v1beta/models');
  assert.throws(() => catalogUrl({ ...base, protocol: 'messages', fullUrl: true }), /Models URL/);
  await assert.rejects(fetchCatalog({ ...base, protocol: 'responses' }, 'secret', 'https://other.test/models'), /same origin/);

  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push([req.url, req.headers.authorization]);
    const page = req.url.includes('pageToken=')
      ? { models: [{ name: 'models/second' }] }
      : { models: [{ name: 'models/first', displayName: 'First', inputTokenLimit: 8192, outputTokenLimit: 512 }], nextPageToken: 'next' };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(page));
  });
  t.after(() => server.close());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const models = await fetchCatalog({ ...base, url, protocol: 'gemini-generate-content' }, 'local-key', url + '/catalog');
  assert.deepEqual(models.map(model => model.id), ['first', 'second']);
  assert.equal(models[0].maxInputTokens, 8192);
  assert.equal(models[1].maxOutputTokens, undefined);
  assert.deepEqual(requests, [['/catalog', 'Bearer local-key'], ['/catalog?pageToken=next', 'Bearer local-key']]);
});

test('manager validates edits without dropping models or saving submitted credentials', () => {
  const model = { id: 'custom', name: 'Custom', maxInputTokens: '8192', maxOutputTokens: '256', options: '{"temperature":0.3}' };
  const draft = {
    ...base, protocol: 'messages', auth: 'custom', authHeader: 'X-Test-Key',
    headers: [{ name: 'anthropic-version', value: '2026-10-21' }],
    models: [model], apiKey: 'test-key',
  };
  const saved = readProviderDraft(draft);
  assert.equal(saved.headers['anthropic-version'], '2026-10-21');
  assert.deepEqual(saved.models[0].options, { temperature: 0.3 });
  assert.equal(saved.models[0].maxInputTokens, 8192);
  assert.ok(!JSON.stringify(saved).includes('test-key'));
  assert.throws(() => readProviderDraft({ ...draft, models: [model, model] }), /unique API model ID/);
  assert.throws(() => readProviderDraft({ ...draft, models: [{ ...model, options: '[]' }] }), /JSON object/);
  assert.throws(() => readProviderDraft({ ...draft, headers: [{ name: 'x-test-key', value: 'test-key' }] }), /separate/);
  assert.equal(readProviderDraft({ ...draft, name: '', models: [{ id: '' }] }, true).models.length, 0);

  const previous = { ...saved, models: [{ ...saved.models[0], url: 'https://legacy.test/v1/messages', fullUrl: true }] };
  const edit = { ...draft, models: [{ ...model, originalId: model.id }] };
  assert.equal(readProviderDraft(edit, false, previous).models[0].url, previous.models[0].url);
  edit.models[0].useProviderUrl = true;
  assert.equal(readProviderDraft(edit, false, previous).models[0].url, undefined);
  edit.models[0].url = 'https://submitted.test';
  assert.equal(readProviderDraft(edit).models[0].url, undefined);
});

test('models.dev defaults prefer the matching endpoint and recognize canonical and namespaced model IDs', () => {
  const registry = indexMetadata({
    direct: { name: 'Direct', api: 'https://direct.test/v1', models: {
      flash: { name: 'Flash', limit: { context: 10000, output: 2000 }, tool_call: true,
        modalities: { input: ['text', 'image'] }, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
    } },
    relay: { name: 'Relay', api: 'https://relay.test', models: {
      'org/flash': { canonical_model_id: 'org/flash', name: 'Relay Flash', limit: { context: 4000, output: 1000 } },
    } },
  });
  const model = resolveDefaults(registry, 'flash', 'https://direct.test/v1/responses');
  assert.equal(model.maxInputTokens, 8000);
  assert.equal(model.maxOutputTokens, 2000);
  assert.equal(model.vision, true);
  assert.equal(model.toolCalling, true);
  assert.deepEqual(model.reasoningEfforts, ['low', 'high']);
  assert.equal(resolveDefaults(registry, 'org/flash', 'https://gateway.test').name, 'Relay Flash');
  assert.equal(resolveDefaults(registry, 'unknown', 'https://gateway.test'), undefined);
});

test('channel priorities use exact model IDs and consecutive failures reset after cooldown or success', () => {
  const channels = groupChannels({
    backup: { models: [{ id: 'api/model', priority: 5 }] },
    primary: { models: [{ id: 'api/model', priority: 20 }, { id: 'model', priority: 30 }] },
  });
  assert.deepEqual([...channels.keys()], ['api/model', 'model']);
  assert.deepEqual(channels.get('api/model').map(channel => channel.connectionId), ['primary', 'backup']);
  const health = new ChannelHealth();
  assert.equal(health.failed('primary', 100), false);
  health.succeeded('primary');
  assert.equal(health.failed('primary', 200), false);
  assert.equal(health.available('primary', 299), true);
  assert.equal(health.failed('primary', 300), true);
  assert.equal(health.available('primary', 300 + channelCooldownMs - 1), false);
  assert.equal(health.available('backup', 300), true);
  assert.equal(health.available('primary', 300 + channelCooldownMs), true);
  assert.equal(health.failed('primary', 301 + channelCooldownMs), false);
});
