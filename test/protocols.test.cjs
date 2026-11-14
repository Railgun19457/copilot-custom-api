const assert = require('node:assert/strict');
const { test } = require('node:test');
const { endpoint, configuredConnections, requestHeaders } = require('../out/config');
const { post, readEvents } = require('../out/http');
const { chatCompletions, responses } = require('../out/protocols/openai');
const { anthropicMessages } = require('../out/protocols/anthropic');
const { geminiGenerateContent, geminiInteractions } = require('../out/protocols/gemini');
const { answer, args, fixtureServer, mockReply, nonStreamingReply, png, protocolPaths, sse, toolName } = require('./fixture.cjs');

const adapters = {
  'chat-completions': chatCompletions,
  responses,
  messages: anthropicMessages,
  'gemini-generate-content': geminiGenerateContent,
  'gemini-interactions': geminiInteractions,
};
const model = { id: 'sample', name: 'Sample', maxInputTokens: 8192, maxOutputTokens: 128, streaming: true, toolCalling: true, vision: true, options: {} };
const image = { type: 'image', mime: 'image/png', base64: png };
const messages = [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }, image] }];
const tools = [{ name: toolName, description: 'Read an example' }];

test('protocol routing supports custom prefixes, exact URLs, model templates and query parameters', () => {
  for (const [protocol, path] of Object.entries(protocolPaths)) {
    assert.equal(endpoint({ protocol, url: 'https://example.test' }, model).pathname, path);
  }
  assert.equal(endpoint({ protocol: 'responses', url: 'https://example.test/proxy/v2?api-version=preview' }, model).href,
    'https://example.test/proxy/v2/responses?api-version=preview');
  assert.equal(endpoint({ protocol: 'messages', url: 'https://example.test/relay', fullUrl: true }, model).pathname, '/relay');
  assert.equal(endpoint({
    protocol: 'gemini-generate-content',
    url: 'https://example.test/models/{model}:generateContent?gateway=1',
    fullUrl: true,
  }, model).href, 'https://example.test/models/sample:streamGenerateContent?gateway=1&alt=sse');
  assert.throws(() => endpoint({ protocol: 'responses', url: 'https://example.test?key=secret' }, model), /credentials separately/);
  assert.throws(() => endpoint({
    protocol: 'gemini-generate-content', url: 'https://{model}.example.test/v1beta', fullUrl: true,
  }, model), /cannot change the endpoint origin/);
});

test('configuration rejects malformed entries and sends keys through the selected header', () => {
  const connection = { name: 'Claude', url: 'https://example.test', auth: 'default', protocol: 'messages', headers: { 'anthropic-version': 'test-version' }, models: [model, { id: 'bad' }] };
  const result = configuredConnections({ a: connection, b: { ...connection, protocol: 'unsupported' } });
  assert.deepEqual(Object.keys(result), ['a']);
  assert.equal(result.a.models.length, 1);
  const headers = requestHeaders(result.a, 'test-key');
  assert.equal(headers.get('x-api-key'), 'test-key');
  assert.equal(headers.get('anthropic-version'), 'test-version');
  assert.equal(requestHeaders({ ...connection, auth: 'none' }).has('x-api-key'), false);
  assert.throws(() => requestHeaders({ ...connection, headers: { Authorization: 'secret' } }, 'test-key'), /authentication headers/);
});

test('SSE parsing handles split Unicode, split CRLF, comments and multiline events', async () => {
  const bytes = Buffer.from(': keepalive\r\nevent: chunk\r\ndata: {"text":\r\ndata: "例"}\r\n\r\ndata: [DONE]');
  const stream = new ReadableStream({
    start(controller) {
      for (const byte of bytes) {
        controller.enqueue(Uint8Array.of(byte));
      }
      controller.close();
    },
  });
  const received = [];
  for await (const event of readEvents(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }), true)) {
    received.push(event);
  }
  assert.deepEqual(received, [
    { name: 'chunk', data: { text: '例' }, json: false },
    { name: '[DONE]', data: {}, json: false },
  ]);
});

for (const [protocol, adapter] of Object.entries(adapters)) {
  test(`${protocol} parses streaming text and JSON text`, async () => {
    const input = { model, url: new URL('https://example.test'), messages, tools: [], requireTool: false };
    const body = adapter.build(input);
    for (const [data, mime] of [
      [sse(mockReply(protocol, body)), 'text/event-stream'],
      [JSON.stringify(nonStreamingReply(protocol)), 'application/json'],
    ]) {
      const parts = [];
      await adapter.read(readEvents(new Response(data, { headers: { 'Content-Type': mime } }), true), part => parts.push(part));
      assert.equal(parts.map(part => part.text).join(''), answer);
    }
  });

  test(`${protocol} preserves tool arguments, images and provider state in the follow-up`, async () => {
    const input = { model, url: new URL('https://example.test'), messages, tools, requireTool: true };
    const stream = sse(mockReply(protocol, adapter.build(input)));
    const parts = [];
    const native = await adapter.read(
      readEvents(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }), true), part => parts.push(part),
    );
    const call = parts.find(part => part.type === 'call');
    assert.ok(call);
    assert.equal(call.name, toolName);
    assert.deepEqual(call.input, args);
    assert.ok(native);
    assert.deepEqual(native.callIds, [call.id]);
    const next = adapter.build({
      ...input,
      messages: [
        ...messages,
        { role: 'assistant', parts, native },
        { role: 'user', parts: [{ type: 'result', id: call.id, content: [{ type: 'text', text: 'tool-output' }] }] },
      ],
    });
    assert.ok(mockReply(protocol, next).length);
  });
}

test('HTTP requests reject redirects and cancellation stops an in-progress stream', async t => {
  const fixture = await fixtureServer();
  t.after(() => fixture.close());
  const signal = new AbortController();
  const headers = new Headers({ Authorization: 'Bearer test-secret' });
  await assert.rejects(post(new URL('/redirect', fixture.baseUrl), headers, {}, signal.signal), /HTTP 302/);
  assert.equal(fixture.hits.includes('/must-not-follow'), false);
  const response = await post(new URL('/cancel', fixture.baseUrl), headers, {}, signal.signal);
  const iterator = readEvents(response, true);
  assert.equal((await iterator.next()).done, false);
  signal.abort();
  await assert.rejects(iterator.next(), error => error.name === 'AbortError');
});
