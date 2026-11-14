const assert = require('node:assert/strict');
const { setTimeout: wait } = require('node:timers/promises');
const { name, publisher } = require('../package.json');

const extensionId = `${publisher}.${name}`.toLowerCase();

async function eventually(fn, description) {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const result = await fn();
    if (result) {
      return result;
    }
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function workbench(port) {
  const target = await eventually(async () => {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return targets.find(item => item.type === 'page' && /workbench\.html/.test(item.url));
    } catch {
      return undefined;
    }
  }, 'the VS Code workbench');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const reply = JSON.parse(event.data);
    const callback = pending.get(reply.id);
    if (callback) {
      pending.delete(reply.id);
      reply.error ? callback.reject(new Error(reply.error.message)) : callback.resolve(reply.result);
    }
  });
  socket.addEventListener('close', () => {
    for (const callback of pending.values()) {
      callback.reject(new Error('The workbench debug connection closed.'));
    }
    pending.clear();
  });
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params, sessionId }));
  });
  const evaluate = async (fn, ...args) => {
    const response = await send('Runtime.evaluate', {
      expression: `(${fn})(...${JSON.stringify(args)})`,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    }
    return response.result.value;
  };
  const key = async (value, code, windowsVirtualKeyCode, modifiers = 0) => {
    const params = { key: value, code, windowsVirtualKeyCode, modifiers };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
  };
  const visiblePrompt = async title => eventually(() => evaluate(expected => {
    const widget = [...document.querySelectorAll('.quick-input-widget')]
      .find(item => item.getBoundingClientRect().width && item.getBoundingClientRect().height);
    if (!widget?.querySelector('.quick-input-title')?.textContent.includes(expected)) {
      return false;
    }
    return widget.contains(document.activeElement);
  }, title), title);

  return {
    evaluate,
    send,
    key,
    async manager() {
      const getManager = await eventually(async () => {
        const { targetInfos } = await send('Target.getTargets');
        return targetInfos.find(item => {
          if (item.type !== 'iframe' || !item.url.includes('/index.html')) {
            return false;
          }
          return new URL(item.url).searchParams.get('extensionId')?.toLowerCase() === extensionId;
        });
      }, 'the Provider Manager webview');
      const { sessionId } = await send('Target.attachToTarget', { targetId: getManager.targetId, flatten: true });
      return async (fn, ...args) => {
        const response = await send('Runtime.evaluate', {
          expression: `(${fn})(...${JSON.stringify(args)})`, returnByValue: true,
        }, sessionId);
        if (response.exceptionDetails) {
          throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
        }
        return response.result.value;
      };
    },
    async fill(title, value) {
      await visiblePrompt(title);
      await key('a', 'KeyA', 65, 2);
      await send('Input.insertText', { text: value });
      await key('Enter', 'Enter', 13);
    },
    async accept(title) {
      await visiblePrompt(title);
      await key('Enter', 'Enter', 13);
    },
    async toggle(title, label) {
      await visiblePrompt(title);
      await eventually(() => evaluate(expected => {
        const options = [...document.querySelectorAll('.quick-input-list label.quick-input-list-label')];
        const option = options.find(item => item.textContent.includes(expected) && item.getBoundingClientRect().width);
        if (option) {
          option.click();
          return true;
        }
        return false;
      }, label), label);
    },
    async choose(title, value) {
      await visiblePrompt(title);
      await send('Input.insertText', { text: value });
      await eventually(() => evaluate(expected => {
        const rows = [...document.querySelectorAll('.quick-input-widget .quick-input-list .monaco-list-row')];
        return rows.some(row => row.textContent.includes(expected) && row.getBoundingClientRect().height > 0);
      }, value), value);
      await key('Enter', 'Enter', 13);
    },
    async closeMenu(title) {
      await visiblePrompt(title);
      await key('Escape', 'Escape', 27);
    },
    close: () => socket.close(),
  };
}

async function createAuthenticatedModel(vscode, baseUrl, port, apiKey) {
  assert.ok(port);
  const ui = await workbench(port);
  try {
    const command = Promise.resolve(vscode.commands.executeCommand('copilotCustomApi.addProvider'));
    void command.catch(() => undefined);
    await ui.fill('Provider name', 'Authenticated fixture');
    await ui.choose('API protocol', 'OpenAI Chat Completions');
    await ui.fill('Endpoint address', baseUrl + '/auth');
    await ui.choose('Endpoint type', 'Base URL or standard endpoint');
    await ui.choose('Authentication', 'Protocol default');
    await ui.fill('API key', apiKey);
    await ui.choose('Authenticated fixture', 'Add model');
    await ui.fill('Model ID', 'sample');
    await ui.fill('Model display name', 'Authenticated sample');
    await ui.fill('Input token limit', '8192');
    await ui.fill('Output token limit', '128');
    await ui.toggle('Model capabilities', 'Tool calling');
    await ui.accept('Model capabilities');
    await ui.closeMenu('Authenticated fixture');
    await command;
  } finally {
    ui.close();
  }
}

async function editProviderInManager(vscode, port, utilityModelId) {
  const ui = await workbench(port);
  try {
    await vscode.commands.executeCommand('copilotCustomApi.providers.focus');
    await vscode.commands.executeCommand('copilotCustomApi.openManager');
    const inspect = await ui.manager();
    const act = (script, description, ...args) => eventually(() => inspect(
      `() => {
        const doc = document.getElementById('editor') ? document : document.querySelector('iframe')?.contentDocument;
        return doc && (${script})(doc, ...${JSON.stringify(args)});
      }`,
    ), description);
    await act(doc => {
      const button = [...doc.querySelectorAll('#provider-list button')].find(item => item.textContent.includes('Authenticated fixture'));
      if (!button) {
        return false;
      }
      button.click();
      return true;
    }, 'the saved provider');
    await act(doc => {
      if (doc.getElementById('provider-title')?.textContent !== 'Authenticated fixture') {
        return false;
      }
      if (doc.getElementById('api-key').value !== '' || !doc.getElementById('key-status').textContent.includes('Key saved')) {
        throw new Error('The page should display credential status without exposing the API key.');
      }
      doc.getElementById('models-tab').click();
      doc.getElementById('discover').click();
      return true;
    }, 'the Fetch models action');
    await act(doc => {
      if (doc.getElementById('catalog-count').textContent !== '2 returned') {
        return false;
      }
      doc.getElementById('close-catalog').click();
      const set = (input, value) => {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(doc.getElementById('name'), 'Edited in Provider Manager');
      set(doc.querySelector('[name="sessionId"]'), 'fixed-session');
      doc.getElementById('add-header').click();
      set(doc.querySelector('#headers [data-field="name"]'), 'X-Provider-Only');
      set(doc.querySelector('#headers [data-field="value"]'), 'provider');
      const model = doc.querySelector('#models > details');
      const field = name => model.querySelector(`[data-field="${name}"]`);
      const efforts = model.querySelector('[data-effort-list]');
      if (field('url') || field('endpointKey') || efforts.closest('.model-advanced') || !field('protocol').closest('.model-advanced')) {
        throw new Error('The model form should expose reasoning controls and group protocol settings under Advanced.');
      }
      set(field('protocol'), 'responses');
      set(field('priority'), '30');
      field('vision').checked = true;
      field('vision').dispatchEvent(new Event('input', { bubbles: true }));
      efforts.querySelector('input[value="low"]').click();
      efforts.querySelector('input[value="high"]').click();
      set(field('reasoningEffort'), 'high');
      efforts.querySelector('input[value="high"]').click();
      if (field('reasoningEffort').value !== '' || [...field('reasoningEffort').options].some(option => option.value === 'high')) {
        throw new Error('Unchecking the default should reset it to the API default.');
      }
      efforts.querySelector('input[value="high"]').click();
      set(model.querySelector('[data-custom-effort]'), 'provider_level');
      model.querySelector('[data-add-effort]').click();
      set(field('reasoningEffort'), 'low');
      model.querySelector('[data-add-model-header]').click();
      set(model.querySelector('[data-model-headers] [data-field="name"]'), 'X-Model-Session');
      set(model.querySelector('[data-model-headers] [data-field="value"]'), 'conversation-${sessionId}');
      doc.getElementById('save').click();
      return true;
    }, 'the model catalog and Save provider action');
    await act(doc => {
      const test = doc.querySelector('#models [data-test]');
      if (doc.getElementById('status')?.textContent !== 'Provider saved.' || !test || test.disabled) {
        return false;
      }
      const model = test.closest('.model');
      model.open = true;
      if (!model.querySelector('[data-effort-list] input[value="provider_level"]').checked ||
        model.querySelector('[data-field="reasoningEffort"]').value !== 'low') {
        throw new Error('Saved custom reasoning efforts and the default should reload into the form.');
      }
      test.click();
      return true;
    }, 'the saved model test action');
    await act(doc => doc.getElementById('status')?.textContent.includes('responded successfully.'), 'the model test result');
    await act(doc => {
      const name = doc.getElementById('name');
      name.value = 'Unsaved form edit';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      const language = doc.getElementById('language');
      language.value = 'zh-cn';
      language.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, 'the language switch');
    await act(doc => {
      if (doc.documentElement.lang !== 'zh-CN' || doc.getElementById('save').textContent !== '保存供应商') {
        return false;
      }
      if (doc.getElementById('name').value !== 'Unsaved form edit') {
        throw new Error('Switching languages discarded the unsaved edit.');
      }
      if (doc.querySelector('[data-field="reasoningEffort"] option').textContent !== '使用 API 默认值') {
        throw new Error('The API default option should follow the selected language.');
      }
      doc.getElementById('revert').click();
      return true;
    }, 'Simplified Chinese with the unsaved edit retained');
    await act(doc => {
      if (doc.getElementById('name').value !== 'Edited in Provider Manager') {
        return false;
      }
      doc.getElementById('open-model-settings').click();
      return !doc.getElementById('model-settings').hidden;
    }, 'the Model settings page');
    await act(doc => {
      const fields = doc.getElementById('utility-fields');
      const [first, second] = [...fields.querySelectorAll('select')].map(field => field.getBoundingClientRect());
      if (second.left > first.left && (Math.abs(first.top - second.top) > 1 || Math.abs(first.height - second.height) > 1 ||
        Math.abs(first.width - second.width) > 1)) {
        throw new Error('Utility model dropdowns should align when displayed side by side.');
      }
      if (['save-utility', 'save-routing'].some(id => doc.getElementById(id).textContent.trim() !== '保存')) {
        throw new Error('Both save buttons should be localized.');
      }
      return true;
    }, 'aligned auxiliary fields and Chinese save buttons');
    await act((doc, id) => {
      const field = doc.getElementById('utility-small-model');
      field.value = id;
      if (field.value !== id || field.selectedOptions[0]?.parentElement.label !== 'Edited in Provider Manager') {
        throw new Error('The auxiliary model selector should use saved provider models.');
      }
      field.dispatchEvent(new Event('input', { bubbles: true }));
      doc.getElementById('save-utility').click();
      return true;
    }, 'the Save utility models action', utilityModelId);
    await act(doc => doc.getElementById('utility-status').textContent === '已保存辅助模型。', 'utility model settings saved');
    await act(doc => {
      const enable = doc.getElementById('routing-enabled');
      enable.click();
      doc.getElementById('save-routing').click();
      return true;
    }, 'the Save channel routing action');
    await act(doc => {
      const field = doc.getElementById('utility-small-model');
      return doc.getElementById('routing-status').textContent === '已保存跨渠道路由设置。' &&
        field.selectedOptions[0]?.textContent.includes('个渠道');
    }, 'channel routing saved with the merged auxiliary model selected');
  } finally {
    ui.close();
  }
}

module.exports = { createAuthenticatedModel, editProviderInManager };
