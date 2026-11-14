const assert = require('node:assert/strict');
const http = require('node:http');
const { setTimeout: wait } = require('node:timers/promises');

const protocolPaths = {
  'chat-completions': '/v1/chat/completions',
  responses: '/v1/responses',
  messages: '/v1/messages',
  'gemini-interactions': '/v1/interactions',
  'gemini-generate-content': '/v1beta/models/sample:streamGenerateContent',
};

const apiKey = 'local-test-secret';
const toolName = 'read_example';
const args = { filename: '例子.txt' };
const callId = 'provider-call';
const answer = '模拟回复';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGMQKDgARwzEcQD9QxQBa3LPDgAAAABJRU5ErkJggg==';
const usage = {
  prompt_tokens: 420,
  completion_tokens: 130,
  total_tokens: 550,
  prompt_tokens_details: { cached_tokens: 80, cache_creation_input_tokens: 20 },
  completion_tokens_details: { reasoning_tokens: 30 },
};
const responseUsage = {
  input_tokens: 420, output_tokens: 130, total_tokens: 550,
  input_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 },
  output_tokens_details: { reasoning_tokens: 30 },
};
const messageUsage = {
  input_tokens: 320, output_tokens: 130, cache_read_input_tokens: 80, cache_creation_input_tokens: 20,
  output_tokens_details: { thinking_tokens: 30 },
};
const generateUsage = {
  promptTokenCount: 400, toolUsePromptTokenCount: 20, cachedContentTokenCount: 80,
  candidatesTokenCount: 100, thoughtsTokenCount: 30, totalTokenCount: 550,
};
const interactionUsage = {
  total_input_tokens: 400, total_tool_use_tokens: 20, total_cached_tokens: 80,
  total_output_tokens: 100, total_thought_tokens: 30, total_tokens: 550,
};
const expectedUsage = protocol => protocol.startsWith('gemini-')
  ? { ...usage, prompt_tokens_details: { cached_tokens: 80 } } : usage;

function mockReply(protocol, body) {
  const input = body.messages ?? body.input ?? body.contents;
  assert.ok(Array.isArray(input) && input.length);
  const followUp = JSON.stringify(input).includes('tool-output');
  if (followUp) {
    const serialized = JSON.stringify(input);
    assert.match(serialized, /signed-state/);
    if (protocol !== 'gemini-generate-content') {
      assert.match(serialized, /provider-call/);
      assert.doesNotMatch(serialized, /cca_[a-f0-9]{32}_/);
    } else {
      assert.doesNotMatch(serialized, /copilot-custom-api-|cca_[a-f0-9]{32}_/);
    }
  }
  const withTool = Array.isArray(body.tools) && JSON.stringify(body.tools).includes(toolName) && !followUp;
  if (withTool) {
    assert.match(JSON.stringify(input), /iVBORw0KGgo/);
    assert.match(JSON.stringify(body.tools), /read_example/);
  }
  const data = {
    'chat-completions': () => withTool ? [
      { choices: [{ delta: { reasoning_content: 'signed-state' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: callId, function: { name: toolName, arguments: '{"filename":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"例子.txt"}' } }] }, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ] : [
      { choices: [{ delta: { content: '模拟' } }] },
      { choices: [{ delta: { content: '回复' }, finish_reason: 'stop' }] },
      '[DONE]',
    ],
    responses: () => withTool ? [
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: JSON.stringify(args) },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: callId, name: toolName, arguments: JSON.stringify(args) } },
      { type: 'response.completed', response: { status: 'completed', output: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'signed-state', summary: [] },
        { type: 'function_call', call_id: callId, name: toolName, arguments: JSON.stringify(args) },
      ] } },
    ] : [
      { type: 'response.output_text.delta', delta: '模拟' },
      { type: 'response.output_text.delta', delta: '回复' },
      { type: 'response.completed', response: { status: 'completed' } },
    ],
    messages: () => withTool ? [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'test reasoning' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-state' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: callId, name: toolName, input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_stop' },
    ] : [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } },
      { type: 'message_stop' },
    ],
    'gemini-interactions': () => withTool ? [
      { event_type: 'step.start', index: 0, step: { type: 'thought' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'signed-state' } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'step.start', index: 1, step: { type: 'function_call', id: callId, name: toolName, arguments: {} } },
      { event_type: 'step.delta', index: 1, delta: { type: 'arguments_delta', arguments: JSON.stringify(args) } },
      { event_type: 'step.stop', index: 1 },
      { event_type: 'interaction.completed', interaction: { status: 'requires_action' } },
    ] : [
      { event_type: 'step.start', index: 0, step: { type: 'model_output' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: answer } },
      { event_type: 'interaction.completed', interaction: { status: 'completed' } },
    ],
    'gemini-generate-content': () => withTool ? [
      { candidates: [{ content: { parts: [{ functionCall: { name: toolName, args }, thoughtSignature: 'signed-state' }] } }] },
      { candidates: [{ finishReason: 'STOP' }] },
    ] : [{ candidates: [{ content: { parts: [{ text: answer }] }, finishReason: 'STOP' }] }],
  };
  const events = data[protocol]();
  const last = events.at(-1);
  if (protocol === 'chat-completions') {
    if (body.stream_options?.include_usage) {
      events.splice(-1, 0, { choices: [], usage: {
        ...usage, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 },
      } });
    }
  } else if (protocol === 'responses') {
    last.response.usage = responseUsage;
  } else if (protocol === 'messages') {
    events.unshift({ type: 'message_start', message: { usage: { input_tokens: 320, output_tokens: 1, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 } } });
    events.splice(-1, 0,
      { type: 'message_delta', usage: { output_tokens: 50 } },
      { type: 'message_delta', usage: { input_tokens: null, output_tokens: 130, output_tokens_details: { thinking_tokens: 30 } } },
    );
  } else if (protocol === 'gemini-generate-content') {
    events.unshift({ usageMetadata: { promptTokenCount: 400, cachedContentTokenCount: 80 } });
    events.push({ usageMetadata: generateUsage });
  } else {
    last.interaction.usage = interactionUsage;
  }
  return events;
}

function nonStreamingReply(protocol) {
  return {
    'chat-completions': {
      choices: [{ message: { content: answer }, finish_reason: 'stop' }],
      usage: { ...usage, prompt_cache_hit_tokens: 80, prompt_tokens_details: { cache_write_tokens: 20 } },
    },
    responses: { status: 'completed', usage: responseUsage, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] }] },
    messages: { usage: messageUsage, content: [{ type: 'text', text: answer }] },
    'gemini-interactions': { status: 'completed', usage: interactionUsage, steps: [{ type: 'model_output', content: [{ type: 'text', text: answer }] }] },
    'gemini-generate-content': { usageMetadata: generateUsage, candidates: [{ content: { parts: [{ text: answer }] }, finishReason: 'STOP' }] },
  }[protocol];
}

function sse(data) {
  return data.map(item => `data: ${typeof item === 'string' ? item : JSON.stringify(item)}\r\n\r\n`).join('');
}

async function fixtureServer() {
  const hits = [];
  const routed = [];
  const chatSessions = new Map();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/auth/v1/models') {
      hits.push(url.pathname);
      if (request.headers.authorization !== `Bearer ${apiKey}`) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'sample' }, { id: 'other' }] }));
      return;
    }
    const path = url.pathname.replace(/^\/(?:auth|legacy)/, '');
    const protocol = Object.keys(protocolPaths).find(key => protocolPaths[key] === path
      .replace(/:generateContent$/, ':streamGenerateContent'));
    if (url.pathname === '/redirect') {
      response.writeHead(302, { Location: '/must-not-follow' }).end();
      return;
    }
    if (url.pathname === '/cancel') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(sse([{ choices: [{ delta: { content: 'first chunk' } }] }]));
      return;
    }
    hits.push(url.pathname);
    if (!protocol) {
      response.writeHead(404).end();
      return;
    }
    try {
      if (url.pathname.startsWith('/auth/')) {
        assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
      }
      if (protocol === 'messages') {
        assert.equal(request.headers['anthropic-version'], '2023-06-01');
      }
      let text = '';
      request.setEncoding('utf8');
      for await (const chunk of request) {
        text += chunk;
      }
      const body = JSON.parse(text);
      if (url.pathname.startsWith('/legacy/') && body.stream_options) {
        response.writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: { message: 'Unrecognized request argument: stream_options' } }));
        return;
      }
      const sessionPrompt = protocol === 'chat-completions' && body.messages.at(-1)?.content;
      if (typeof sessionPrompt === 'string' && sessionPrompt.startsWith('Session header check ')) {
        assert.equal(request.headers['x-session-id'], sessionPrompt.endsWith('separate chat') ? 'session-b' : 'session-a');
      }
      const routePrompt = protocol === 'chat-completions' ? sessionPrompt : body.input?.at(-1)?.content?.at(-1)?.text;
      if (typeof routePrompt === 'string' && routePrompt.startsWith('Routing check ')) {
        routed.push({ prompt: routePrompt, path: url.pathname, model: body.model });
      }
      if (url.pathname === '/auth/v1/responses') {
        assert.equal(request.headers['x-session-id'], 'fixed-session');
        assert.equal(request.headers['x-model-session'], 'conversation-fixed-session');
        assert.equal(request.headers['x-provider-only'], 'provider');
        assert.equal(request.headers['copilot-integration-id'], 'vscode-chat');
        assert.ok(request.headers['x-request-id']);
        assert.equal(body.reasoning?.effort, JSON.stringify(body.input).includes('selected reasoning effort') ? 'high' : 'low');
        if (routePrompt === 'Utility budget check') {
          assert.equal(body.max_output_tokens, 32);
        }
        if (routePrompt?.startsWith('Routing check fail')) {
          response.writeHead(503).end();
          return;
        }
      } else if (protocol === 'chat-completions' && body.tools?.length) {
        const session = request.headers['x-session-id'];
        assert.ok(session);
        const input = JSON.stringify(body.messages);
        if (input.includes('tool-output')) {
          assert.equal(session, chatSessions.get(protocol));
        } else {
          chatSessions.set(protocol, session);
        }
      }
      const streaming = protocol === 'gemini-generate-content' ? url.searchParams.get('alt') === 'sse' : body.stream;
      if (!streaming || sessionPrompt === 'Usage JSON fallback') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(nonStreamingReply(protocol)));
        return;
      }
      let events = mockReply(protocol, body);
      if (sessionPrompt === 'Usage without token counts') {
        events = events.filter(event => !event.usage);
      } else if (sessionPrompt === 'Usage without cache counts') {
        delete events.find(event => event.usage).usage.prompt_tokens_details;
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        response.write(sse([{ choices: [{ delta: { reasoning_content: 'hidden reasoning' } }] }]));
        await wait(100);
        response.write(sse(events.slice(0, 1)));
        await wait(150);
        response.write(sse(events.slice(1, 2)));
        await wait(300);
        response.end(sse(events.slice(2)));
        return;
      }
      const chunks = Buffer.from(sse(events));
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      for (let offset = 0; offset < chunks.length; offset += 23) {
        response.write(chunks.subarray(offset, offset + 23));
      }
      response.end();
    } catch (error) {
      console.error('Fixture received an invalid request:', error);
      response.writeHead(400).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    hits,
    routed,
    close() {
      return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

module.exports = { answer, apiKey, args, callId, expectedUsage, fixtureServer, mockReply, nonStreamingReply, png, protocolPaths, sse, toolName };
