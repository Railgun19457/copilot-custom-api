import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  Connection, isObject, JsonObject, Model, parseUrl, Protocol, protocols, requestHeaders, validateHeader,
} from './config';
import { CustomApiProvider, secretName } from './provider';
import { Settings } from './settings';

const title = 'Copilot Custom API';
type Choice<T> = vscode.QuickPickItem & { value: T };
type ProviderAction = 'add' | 'edit' | 'set-key' | 'clear-key' | 'headers' | 'test' | 'delete';

function pick<T>(label: string, items: readonly Choice<T>[]): Thenable<Choice<T> | undefined> {
  return vscode.window.showQuickPick(items, { title: `${title}: ${label}`, matchOnDescription: true });
}

function input(label: string, options: vscode.InputBoxOptions = {}): Thenable<string | undefined> {
  return vscode.window.showInputBox({ title: `${title}: ${label}`, ignoreFocusOut: true, ...options });
}

function nonempty(value: string): string | undefined {
  return value.trim() ? undefined : 'Enter a value.';
}

function tokenLimit(value: string): string | undefined {
  const number = Number(value);
  return /^\d+$/.test(value.trim()) && Number.isSafeInteger(number) && number > 0
    ? undefined : 'Enter a positive whole number.';
}

function validateUrl(value: string): string | undefined {
  try {
    parseUrl(value.trim());
    return undefined;
  } catch (error) {
    return error instanceof TypeError ? 'Enter an HTTP(S) address.' : error instanceof Error ? error.message : 'Invalid endpoint address.';
  }
}

function prioritize<T>(items: Choice<T>[], selected: T | undefined): Choice<T>[] {
  const current = items.find(item => item.value === selected);
  return current ? [current, ...items.filter(item => item !== current)] : items;
}

async function jsonInput(
  label: string, prompt: string, current: JsonObject, check?: (value: JsonObject) => void,
): Promise<JsonObject | undefined> {
  const value = await input(label, {
    prompt,
    value: JSON.stringify(current),
    validateInput(text) {
      try {
        const candidate: unknown = JSON.parse(text);
        if (!isObject(candidate)) {
          return 'Enter a JSON object.';
        }
        check?.(candidate);
        return undefined;
      } catch (error) {
        return error instanceof SyntaxError ? 'Enter a valid JSON object.' : error instanceof Error ? error.message : 'Invalid value.';
      }
    },
  });
  return value === undefined ? undefined : JSON.parse(value);
}

async function connectionForm(current?: Connection): Promise<Connection | undefined> {
  const name = await input('Provider name', {
    prompt: 'Enter a name for this connection.',
    value: current?.name,
    validateInput: nonempty,
  });
  if (name === undefined) {
    return undefined;
  }
  const protocol = await pick('API protocol', prioritize(
    Object.entries(protocols).map(([value, label]) => ({ label, value: value as Protocol })), current?.protocol,
  ));
  if (!protocol) {
    return undefined;
  }
  const url = await input('Endpoint address', {
    prompt: 'Enter your API base URL or full endpoint URL.',
    placeHolder: 'https://your-endpoint.example/v1',
    value: current?.url,
    validateInput: validateUrl,
  });
  if (url === undefined) {
    return undefined;
  }
  const urlMode = await pick('Endpoint type', prioritize([
    { label: 'Base URL or standard endpoint', description: 'Append the API route if needed', value: false },
    { label: 'Exact endpoint URL', description: 'Use a custom route as entered', value: true },
  ], current?.fullUrl));
  if (!urlMode) {
    return undefined;
  }
  const auth = await pick('Authentication', prioritize<Connection['auth']>([
    { label: 'Protocol default', value: 'default' },
    { label: 'Bearer token', value: 'bearer' },
    { label: 'Custom API key header', value: 'custom' },
    { label: 'No authentication', value: 'none' },
  ], current?.auth));
  if (!auth) {
    return undefined;
  }
  let authHeader: string | undefined;
  if (auth.value === 'custom') {
    authHeader = await input('API key header', {
      value: current?.authHeader,
      placeHolder: 'api-key',
      validateInput(value) {
        try {
          validateHeader(value.trim(), '');
          return undefined;
        } catch {
          return 'Enter a valid HTTP header name.';
        }
      },
    });
    if (authHeader === undefined) {
      return undefined;
    }
  }
  return {
    ...current,
    name: name.trim(),
    protocol: protocol.value,
    url: url.trim(),
    fullUrl: urlMode.value,
    auth: auth.value,
    authHeader: authHeader?.trim(),
    headers: current?.headers ?? {},
    models: current?.models ?? [],
  };
}

async function keyInput(connection: Connection, optional: boolean): Promise<string | undefined> {
  const result = await input('API key', {
    prompt: optional ? 'Enter the API key, or leave blank to set it later.' : 'Enter the API key for this endpoint.',
    password: true,
    validateInput(value) {
      if (!value.trim() && optional) {
        return undefined;
      }
      if (!value.trim()) {
        return 'Enter an API key.';
      }
      try {
        requestHeaders(connection, value.trim());
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : 'Invalid key.';
      }
    },
  });
  return result?.trim();
}

async function modelForm(connection: Connection, current?: Model): Promise<Model | undefined> {
  const id = await input('Model ID', {
    prompt: 'Enter the exact model ID accepted by the API.',
    value: current?.id,
    validateInput(value) {
      if (connection.models.some(model => model !== current && model.id === value.trim())) {
        return 'This provider already has that model ID.';
      }
      return nonempty(value);
    },
  });
  if (id === undefined) {
    return undefined;
  }
  const name = await input('Model display name', {
    prompt: 'This name appears in the Copilot Chat model picker.',
    value: current?.name ?? id.trim(),
    validateInput: nonempty,
  });
  if (name === undefined) {
    return undefined;
  }
  const maxInput = await input('Input token limit', {
    prompt: 'Enter the maximum input tokens supported by this model.',
    value: current?.maxInputTokens.toString(),
    placeHolder: '128000',
    validateInput: tokenLimit,
  });
  if (maxInput === undefined) {
    return undefined;
  }
  const maxOutput = await input('Output token limit', {
    prompt: 'Enter the maximum output tokens supported by this model.',
    value: current?.maxOutputTokens.toString(),
    placeHolder: '8192',
    validateInput: tokenLimit,
  });
  if (maxOutput === undefined) {
    return undefined;
  }
  const capabilities = await vscode.window.showQuickPick<Choice<string>>([
    { label: 'Streaming responses', value: 'stream', picked: current?.streaming ?? true },
    { label: 'Tool calling', description: 'Required for Agent workflows', value: 'tools', picked: current?.toolCalling },
    { label: 'Image input', value: 'vision', picked: current?.vision },
  ], { title: `${title}: Model capabilities`, canPickMany: true });
  if (!capabilities) {
    return undefined;
  }
  const selected = new Set(capabilities.map(item => item.value));
  return {
    ...current,
    id: id.trim(),
    name: name.trim(),
    maxInputTokens: Number(maxInput),
    maxOutputTokens: Number(maxOutput),
    streaming: selected.has('stream'),
    toolCalling: selected.has('tools'),
    vision: selected.has('vision'),
    reasoningEffort: current?.reasoningEffort,
    options: current?.options ?? {},
  };
}

export class Management {
  private open = false;

  constructor(private readonly settings: Settings, private readonly provider: CustomApiProvider) {}

  async run(add = false): Promise<void> {
    if (this.open) {
      return;
    }
    this.open = true;
    try {
      if (add) {
        const id = await this.add();
        if (id) {
          await this.manageProvider(id);
        }
        return;
      }
      for (;;) {
        const connections = Object.entries(this.settings.get()).map(([value, entry]) => ({
          label: entry.name, description: protocols[entry.protocol], value,
        }));
        const selected = await pick('Manage providers', [
          { label: '$(add) Add provider', value: '' },
          ...connections,
        ]);
        if (!selected) {
          return;
        }
        const id = selected.value || await this.add();
        if (id) {
          await this.manageProvider(id);
        }
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`${title}: ${error instanceof Error ? error.message : 'The operation failed.'}`);
    } finally {
      this.open = false;
    }
  }

  private async add(): Promise<string | undefined> {
    const connection = await connectionForm();
    if (!connection) {
      return undefined;
    }
    const key = connection.auth === 'none' ? '' : await keyInput(connection, true);
    if (key === undefined) {
      return undefined;
    }
    const id = randomUUID();
    await this.settings.saveProvider(id, undefined, connection, key || undefined);
    return id;
  }

  private async manageProvider(id: string): Promise<void> {
    for (;;) {
      const connection = this.settings.get()[id];
      if (!connection) {
        return;
      }
      const actions: Choice<ProviderAction | Model>[] = [
        { label: '$(add) Add model', value: 'add' },
        { label: '$(edit) Edit connection', value: 'edit' },
        { label: '$(list-unordered) Edit extra HTTP headers', value: 'headers' },
        { label: '$(pulse) Test connection', value: 'test' },
        { label: '$(trash) Remove provider', value: 'delete' },
      ];
      if (connection.auth !== 'none') {
        const keySet = Boolean(await this.settings.secrets.get(secretName(id, connection)));
        actions.splice(2, 0, { label: '$(key) Set API key', description: keySet ? 'Configured' : 'Missing', value: 'set-key' });
        if (keySet) {
          actions.splice(3, 0, { label: '$(clear-all) Clear API key', value: 'clear-key' });
        }
      }
      const selected = await pick(connection.name, [
        ...actions,
        ...connection.models.map(model => ({ label: `$(symbol-misc) ${model.name}`, description: model.id, value: model })),
      ]);
      if (!selected) {
        return;
      }
      if (typeof selected.value !== 'string') {
        await this.manageModel(id, connection, selected.value);
        continue;
      }
      if (selected.value === 'add') {
        const model = await modelForm(connection);
        if (model) {
          await this.settings.save(id, connection, { ...connection, models: [...connection.models, model] });
        }
      } else if (selected.value === 'edit') {
        const next = await connectionForm(connection);
        if (next) {
          await this.settings.saveProvider(id, connection, next);
        }
      } else if (selected.value === 'set-key') {
        const key = await keyInput(connection, false);
        if (key !== undefined) {
          await this.settings.setKey(id, connection, key);
        }
      } else if (selected.value === 'clear-key') {
        await this.settings.setKey(id, connection, undefined);
      } else if (selected.value === 'headers') {
        const headers = await jsonInput('Extra HTTP headers', 'Enter a JSON object containing non-secret headers.',
          connection.headers, value => {
            if (Object.values(value).some(item => typeof item !== 'string')) {
              throw new Error('All header values must be strings.');
            }
            requestHeaders({ ...connection, headers: value as Record<string, string> }, 'validation');
          });
        if (headers) {
          await this.settings.save(id, connection, { ...connection, headers: headers as Record<string, string> });
        }
      } else if (selected.value === 'test') {
        if (!connection.models.length) {
          void vscode.window.showInformationMessage(`${title}: Add a model before testing the connection.`);
        } else {
          const model = await pick('Send a test message using', connection.models.map(value => ({ label: value.name, value })));
          if (model) {
            await this.test(id, connection, model.value);
          }
        }
      } else {
        const confirmed = await vscode.window.showWarningMessage(
          `Remove “${connection.name}” and its models?`, { modal: true }, 'Remove',
        );
        if (confirmed === 'Remove') {
          await this.settings.removeProvider(id, connection);
          return;
        }
      }
    }
  }

  private async manageModel(id: string, connection: Connection, model: Model): Promise<void> {
    const action = await pick(model.name, [
      { label: '$(edit) Edit model', value: 'edit' },
      { label: '$(settings-gear) Set reasoning effort', value: 'reasoning' },
      { label: '$(json) Edit API request options', value: 'options' },
      { label: '$(pulse) Test model', value: 'test' },
      { label: '$(trash) Remove model', value: 'delete' },
    ]);
    let next: Model | undefined;
    switch (action?.value) {
      case 'edit':
        next = await modelForm(connection, model);
        break;
      case 'reasoning': {
        const value = await input('Reasoning effort', {
          value: model.reasoningEffort ?? '',
          prompt: 'Enter a level accepted by this model, such as low, medium, or high. Leave blank for the API default.',
        });
        if (value !== undefined) {
          next = { ...model, reasoningEffort: value.trim() || undefined };
        }
        break;
      }
      case 'options': {
        const options = await jsonInput('API request options', 'Enter a JSON object using fields from the selected API.', model.options);
        if (options) {
          next = { ...model, options };
        }
        break;
      }
      case 'test':
        await this.test(id, connection, model);
        return;
      case 'delete': {
        const confirmed = await vscode.window.showWarningMessage(`Remove “${model.name}”?`, { modal: true }, 'Remove');
        if (confirmed === 'Remove') {
          await this.settings.saveProvider(id, connection, { ...connection, models: connection.models.filter(item => item !== model) });
        }
        return;
      }
    }
    if (next) {
      await this.settings.save(id, connection, { ...connection, models: connection.models.map(item => item === model ? next : item) });
    }
  }

  private async test(id: string, connection: Connection, model: Model): Promise<void> {
    try {
      await vscode.window.withProgress({
        title: `${title}: Testing ${model.name}`,
        location: vscode.ProgressLocation.Notification,
        cancellable: true,
      }, (_progress, token) => this.provider.test(id, connection, model, token));
      void vscode.window.showInformationMessage(`${title}: “${model.name}” responded successfully.`);
    } catch (error) {
      if (!(error instanceof vscode.CancellationError)) {
        void vscode.window.showErrorMessage(`${title}: ${error instanceof Error ? error.message : 'The test failed.'}`);
      }
    }
  }
}
