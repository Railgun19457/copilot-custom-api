const assert = require('node:assert/strict');
const vscode = require('vscode');
const { name, publisher } = require('../package.json');
const { answer, apiKey, args, expectedUsage, png, protocolPaths, toolName } = require('./fixture.cjs');
const { createAuthenticatedModel, editProviderInManager, verifyUsageInManager } = require('./quick-input.cjs');
const { routedModelId } = require('../out/routing');

const vendor = 'copilot-custom-api';
const settingsKey = 'copilotCustomApi.providers';
const sample = {
  id: 'sample', name: 'Sample', maxInputTokens: 8192, maxOutputTokens: 128,
  toolCalling: true, vision: true, streaming: true, options: {},
};

async function eventually(operation, predicate) {
  const deadline = Date.now() + 15_000;
  do {
    const value = await operation();
    if (predicate(value)) {
      return value;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for the provider models.');
}

async function read(response) {
  const parts = [];
  for await (const part of response.stream) {
    parts.push(part);
  }
  return parts;
}

async function chat(model, messages, options, token) {
  const parts = await read(await model.sendRequest(messages, options, token));
  return parts.filter(part => part instanceof vscode.LanguageModelTextPart).map(part => part.value).join('');
}

async function run() {
  const profile = process.env.CUSTOM_API_TEST_PROFILE;
  const baseUrl = process.env.CUSTOM_API_TEST_URL;
  assert.ok(baseUrl);
  const ext = vscode.extensions.getExtension(`${publisher}.${name}`);
  assert.ok(ext, 'The development extension should be installed');

  const makeProvider = (protocol, url = baseUrl) => ({
    name: protocol,
    protocol,
    url,
    fullUrl: url !== baseUrl,
    auth: 'none',
    headers: {},
    models: [{ ...sample, name: `Test ${protocol}` }, { ...sample, id: 'plain', name: `Plain ${protocol}`, streaming: false }],
  });
  const expected = Object.fromEntries(Object.keys(protocolPaths).map(protocol => [protocol, makeProvider(protocol)]));
  expected['chat-completions'].models[1].vision = false;
  expected['chat-completions'].models[1].toolCalling = false;
  const jsonGemini = expected['gemini-generate-content'];
  jsonGemini.models[1].id = 'sample-json';
  // The exact URL fixes the upstream route while the two VS Code model IDs stay distinct.
  jsonGemini.url = baseUrl + protocolPaths['gemini-generate-content'];
  jsonGemini.fullUrl = true;

  if (profile === 'default') {
    await vscode.workspace.getConfiguration().update(settingsKey, expected, vscode.ConfigurationTarget.Global);
  }
  const models = await eventually(() => vscode.lm.selectChatModels({ vendor }), value =>
    value.length === (profile === 'default' ? 10 : 11));
  assert.ok(ext.isActive, 'Model discovery activates the extension');
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('copilotCustomApi.manage'));
  assert.ok(commands.includes('copilotCustomApi.addProvider'));
  console.log(`[Copilot Custom API test] ${profile} profile lists all ${models.length} models.`);

  if (profile === 'secondary') {
    assert.equal(await chat(models.find(model => model.name === 'Test responses'), [
      vscode.LanguageModelChatMessage.User('Cross-profile test'),
    ]), answer);
    return;
  }

  for (const protocol of Object.keys(protocolPaths)) {
    const model = models.find(item => item.name === `Test ${protocol}`);
    assert.ok(model);
    assert.equal(model.maxInputTokens, 8192);
    assert.ok(await model.countTokens('Count these tokens 例子') > 0);
    const tools = [{ name: toolName, description: 'Read an example' }];
    const input = vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelTextPart('Read an example'),
      vscode.LanguageModelDataPart.image(Buffer.from(png, 'base64'), 'image/png'),
    ]);
    const first = await read(await model.sendRequest([input], { tools, toolMode: vscode.LanguageModelChatToolMode.Required }));
    const call = first.find(part => part instanceof vscode.LanguageModelToolCallPart);
    assert.ok(call, `${protocol} returned a tool call`);
    assert.equal(call.name, toolName);
    assert.deepEqual(call.input, args);
    function checkUsage(parts) {
      const recorded = parts.filter(part => part instanceof vscode.LanguageModelDataPart && part.mimeType === 'usage');
      assert.equal(recorded.length, 1, `${protocol} should report usage once`);
      assert.deepEqual(JSON.parse(Buffer.from(recorded[0].data).toString('utf8')), expectedUsage(protocol));
    }
    checkUsage(first);
    const result = vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart('tool-output')]),
    ]);
    // Exercise the Agent Host case where only the tool call ID makes it back.
    assert.equal(await chat(model, [input, vscode.LanguageModelChatMessage.Assistant([call]), result], { tools }), answer);
    const plain = models.find(item => item.name === `Plain ${protocol}`);
    assert.ok(plain, `Missing the JSON model for ${protocol}`);
    const jsonParts = await read(await plain.sendRequest([vscode.LanguageModelChatMessage.User('Nonstreaming test')]));
    assert.equal(jsonParts.filter(part => part instanceof vscode.LanguageModelTextPart).map(part => part.value).join(''), answer);
    checkUsage(jsonParts);
    console.log(`[Copilot Custom API test] ${protocol} sent an image, round-tripped a tool call and reported streaming and JSON usage.`);
  }

  const sessionModel = models.find(model => model.name === 'Plain chat-completions');
  for (const [prompt, conversationId] of [
    ['Session header check first turn', 'session-a'],
    ['Session header check second turn', 'session-a'],
    ['Session header check separate chat', 'session-b'],
  ]) {
    assert.equal(await chat(sessionModel, [vscode.LanguageModelChatMessage.User(prompt)], {
      modelOptions: { _conversationId: conversationId },
    }), answer);
  }
  console.log('[Copilot Custom API test] Main chat requests use the stable conversation ID from the caller.');

  const config = vscode.workspace.getConfiguration();
  const extra = makeProvider('chat-completions', baseUrl + '/cancel');
  extra.name = 'Other source';
  extra.models = [{ ...sample, name: 'Test chat-completions' }];
  await config.update(settingsKey, { ...expected, extra }, vscode.ConfigurationTarget.Global);
  const withExtra = await eventually(() => vscode.lm.selectChatModels({ vendor }), value => value.length === 11);
  const cancellation = new vscode.CancellationTokenSource();
  try {
    assert.ok(withExtra.some(item => item.name === 'Test chat-completions · chat-completions'));
    const cancelModel = withExtra.find(item => item.name === 'Test chat-completions · Other source');
    assert.ok(cancelModel);
    const response = await cancelModel.sendRequest([vscode.LanguageModelChatMessage.User('Cancel this')], {}, cancellation.token);
    const iterator = response.text[Symbol.asyncIterator]();
    assert.deepEqual(await iterator.next(), { value: 'first chunk', done: false });
    cancellation.cancel();
    await assert.rejects(iterator.next(), /cancel/i);
  } finally {
    cancellation.dispose();
    await vscode.workspace.getConfiguration().update(settingsKey, expected, vscode.ConfigurationTarget.Global);
  }
  await eventually(() => vscode.lm.selectChatModels({ vendor }), value => value.length === 10);
  await createAuthenticatedModel(vscode, baseUrl, process.env.CUSTOM_API_TEST_CDP_PORT, apiKey);
  const withAuth = await eventually(() => vscode.lm.selectChatModels({ vendor }), value => value.length === 11);
  assert.equal(await chat(withAuth.find(model => model.name === 'Authenticated sample'), [
    vscode.LanguageModelChatMessage.User('Test the configured API key'),
  ]), answer);
  assert.ok(!JSON.stringify(vscode.workspace.getConfiguration().get(settingsKey)).includes(apiKey));
  console.log('[Copilot Custom API test] Add Provider saved credentials and registered the model.');
  const authId = withAuth.find(model => model.name === 'Authenticated sample').id;
  const withoutVision = expected['chat-completions'].models[0];
  withoutVision.vision = false;
  withoutVision.priority = 20;
  await vscode.workspace.getConfiguration().update(settingsKey, {
    ...vscode.workspace.getConfiguration().get(settingsKey), ...expected,
  }, vscode.ConfigurationTarget.Global);
  await editProviderInManager(vscode, process.env.CUSTOM_API_TEST_CDP_PORT, `${vendor}/${authId}`);
  const saved = Object.values(vscode.workspace.getConfiguration().get(settingsKey))
    .find(connection => connection.name === 'Edited in Provider Manager');
  assert.deepEqual(saved.models[0].reasoningEfforts, ['low', 'high', 'provider_level']);
  assert.ok(!JSON.stringify(saved).includes(apiKey));
  assert.equal(saved.models[0].url, undefined);
  assert.equal(saved.models[0].priority, 30);
  const updated = vscode.workspace.getConfiguration();
  const mergedId = routedModelId('sample');
  assert.equal(updated.inspect('chat.utilitySmallModel').globalValue, `${vendor}/${mergedId}`);
  assert.equal(updated.inspect('copilotCustomApi.routing')?.globalValue, undefined);
  const available = await eventually(() => vscode.lm.selectChatModels({ vendor }), value => value.length === 3);
  const routed = available.find(model => model.id === mergedId);
  assert.equal(routed.name, 'Authenticated sample');
  assert.deepEqual(available.map(model => model.family).sort(), ['plain', 'sample', 'sample-json']);
  assert.equal(await chat(routed, [
    vscode.LanguageModelChatMessage.User('Test selected reasoning effort'),
  ], { modelOptions: { reasoningEffort: 'high' } }), answer);
  assert.equal(await chat(routed, [vscode.LanguageModelChatMessage.User('Utility budget check')], {
    modelOptions: { max_tokens: 32 },
  }), answer);
  const request = (name, session) => chat(routed, [vscode.LanguageModelChatMessage.User(`Routing check ${name}`)],
    { modelOptions: { _conversationId: session } });
  assert.equal(await request('primary', 'session-1'), answer);
  await assert.rejects(request('fail once', 'session-1'), /HTTP 503/);
  assert.equal(await request('primary recovers', 'session-2'), answer);
  await assert.rejects(request('fail after recovery', 'session-2'), /HTTP 503/);
  assert.equal(await request('fail twice', 'session-3'), answer);
  assert.equal(await request('fallback in another session', 'session-4'), answer);
  console.log('[Copilot Custom API test] Same-ID channels prefer the highest priority and fail over across sessions.');
  const authProviderId = authId.slice(0, -'/sample'.length);
  await verifyUsageInManager(vscode, process.env.CUSTOM_API_TEST_CDP_PORT, authProviderId, async prompt => {
    assert.equal(await chat(routed, [vscode.LanguageModelChatMessage.User(prompt)]), answer);
  });
  console.log('[Copilot Custom API test] Usage statistics show actual channel totals, filters, and live updates.');
}

exports.run = async () => {
  try {
    await run();
  } catch (error) {
    console.error('[Copilot Custom API test] Failed:', require('node:util').inspect(error, { depth: 6 }));
    throw new Error(error?.message ?? String(error));
  }
};
