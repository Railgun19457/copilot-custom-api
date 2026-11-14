import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { fetchCatalog } from './catalog';
import { array, Connection, object, parseUrl, protocols, requestHeaders, string } from './config';
import { readProviderDraft } from './manager-config';
import { loadMetadata, resolveDefaults } from './model-metadata';
import { CustomApiProvider, secretName, settingsKey, vendor } from './provider';
import { Settings } from './settings';
import { channelSelectionId, groupChannels, utilityKeys } from './routing';

type UtilityOption = { id: string; name: string; modelId: string; provider?: string; sources?: number };

const title = 'Copilot Custom API';
const viewId = 'copilotCustomApi.providers';
const openProvider = 'copilotCustomApi.openProvider';
const languageKey = 'copilotCustomApi.language';

export class ProviderManager implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly tree = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[];
  private connections = new Map<string, Connection>();
  private selection?: string;
  private ready = false;
  private busy = false;
  private revision = 0;
  private readonly chinese: Record<string, string>;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly settings: Settings,
    private readonly provider: CustomApiProvider,
  ) {
    this.chinese = JSON.parse(readFileSync(vscode.Uri.joinPath(extensionUri, 'media', 'zh-cn.json').fsPath, 'utf8'));
    this.disposables = [
      vscode.window.registerTreeDataProvider<string>(viewId, {
        onDidChangeTreeData: this.tree.event,
        getChildren: () => Object.keys(settings.get()),
        getTreeItem: id => {
          const connection = settings.get()[id];
          const item = new vscode.TreeItem(connection?.name ?? id);
          item.id = id;
          item.iconPath = new vscode.ThemeIcon('plug');
          if (connection) {
            item.description = String(connection.models.length);
            const count = vscode.env.language.toLowerCase().startsWith('zh')
              ? `${connection.models.length} 个模型`
              : `${connection.models.length} models`;
            item.tooltip = `${protocols[connection.protocol]} · ${count}`;
            item.command = { title: 'Open Provider', command: openProvider, arguments: [id] };
          }
          return item;
        },
      }),
      vscode.commands.registerCommand(openProvider, (id: unknown) => this.open(string(id))),
      vscode.commands.registerCommand('copilotCustomApi.openManager', () => this.open()),
      vscode.commands.registerCommand('copilotCustomApi.newProvider', () => this.open('')),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(settingsKey)) {
          this.tree.fire();
          this.refresh();
        } else if ([languageKey, ...utilityKeys].some(key => event.affectsConfiguration(key))) {
          this.refresh();
        }
      }),
      settings.secrets.onDidChange(() => this.refresh()),
    ];
  }

  dispose(): void {
    this.panel?.dispose();
    this.tree.dispose();
    this.disposables.forEach(item => item.dispose());
  }

  open(selection?: string): void {
    if (this.panel) {
      this.panel.reveal();
      if (selection !== undefined) {
        if (this.ready) {
          void this.panel.webview.postMessage({ type: 'select', id: selection });
        } else {
          this.selection = selection;
        }
      }
      return;
    }
    this.selection = selection;
    this.ready = false;
    this.connections.clear();
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('copilotCustomApi.manager', title, vscode.ViewColumn.One, {
      enableScripts: true,
      localResourceRoots: [media],
      retainContextWhenHidden: true,
    });
    this.panel = panel;
    const receiver = panel.webview.onDidReceiveMessage(message => void this.receive(panel, message));
    panel.onDidDispose(() => {
      receiver.dispose();
      this.panel = undefined;
      this.ready = false;
    });
    const template = readFileSync(vscode.Uri.joinPath(media, 'manager.html').fsPath, 'utf8');
    panel.webview.html = template
      .replaceAll('{{csp}}', panel.webview.cspSource)
      .replaceAll('{{assets}}', panel.webview.asWebviewUri(media).toString());
  }

  private refresh(): void {
    if (this.panel && this.ready && !this.busy) {
      const panel = this.panel;
      void this.publish(panel).catch(() => {
        void panel.webview.postMessage({ type: 'loadError', status: 'Could not load providers. Reopen the manager to retry.' });
      });
    }
  }

  private async publish(panel: vscode.WebviewPanel): Promise<void> {
    const revision = ++this.revision;
    const configured = this.settings.get();
    const connections = Object.entries(configured);
    const routingEnabled = this.settings.routingEnabled();
    const entries = await Promise.all(connections.map(async ([id, config]) => {
      const keyedOrigins = config.auth === 'none' ? [] : await Promise.all(
        [...this.settings.endpointOrigins(config)].map(async origin =>
          await this.settings.secrets.get(secretName(id, { url: origin })) ? origin : ''),
      );
      return { id, config, keyedOrigins: keyedOrigins.filter(Boolean), hasKey: keyedOrigins.includes(parseUrl(config.url).origin) };
    }));
    if (this.panel !== panel || revision !== this.revision) {
      return;
    }
    this.connections = new Map(connections);
    const selection = this.selection;
    this.selection = undefined;
    await panel.webview.postMessage({
      type: 'state', entries, protocols, selection, chinese: this.chinese, language: vscode.env.language,
      routingEnabled, utility: this.settings.utilityModels(), vendor,
      utilityOptions: this.utilityOptions(configured, routingEnabled),
      preference: vscode.workspace.getConfiguration().get(languageKey, 'auto'),
    });
  }

  private async receive(panel: vscode.WebviewPanel, value: unknown): Promise<void> {
    const message = object(value);
    const type = string(message.type);
    if (type === 'metadata') {
      const id = string(message.model).trim();
      try {
        const defaults = id && resolveDefaults(await loadMetadata(), id, string(message.url));
        await panel.webview.postMessage({ type, requestId: message.requestId, defaults });
      } catch {
        await panel.webview.postMessage({ type, requestId: message.requestId, unavailable: true });
      }
      return;
    }
    if (type === 'ready') {
      this.ready = true;
      this.refresh();
      return;
    }
    if (type === 'language' && ['auto', 'en', 'zh-cn'].includes(string(message.value))) {
      try {
        await vscode.workspace.getConfiguration().update(languageKey, message.value, vscode.ConfigurationTarget.Global);
      } catch (error) {
        await panel.webview.postMessage({ type: 'loadError', status: error instanceof Error ? error.message : 'The operation failed.' });
      }
      return;
    }
    if (!['save', 'remove', 'clearKey', 'test', 'discover', 'saveUtility', 'saveRouting'].includes(type)) {
      return;
    }
    if (this.busy) {
      await panel.webview.postMessage({ type: 'error', status: 'A provider operation is already in progress.' });
      return;
    }
    this.busy = true;
    try {
      if (type === 'saveUtility' || type === 'saveRouting') {
        const status = await this.saveModelSettings(type, message);
        await panel.webview.postMessage({ type: 'done', action: type, status });
        return;
      }
      let id = string(message.id);
      const previous = id ? this.connections.get(id) : undefined;
      if (id && !previous) {
        throw new Error('This provider is no longer available. Select it again.');
      }
      // Compare against the form's original snapshot, including when the page received a newer state.
      if (previous) {
        const baseline = JSON.stringify(previous);
        if (message.baseline !== baseline) {
          throw new Error('This provider changed in another window. Reload it before continuing.');
        }
        this.settings.assertCurrent(id, previous);
      }
      let status = '';
      if (type === 'save' || type === 'discover') {
        const draft = readProviderDraft(message.draft, type === 'discover', previous);
        const key = draft.auth === 'none' ? undefined : string(message.apiKey).trim() || undefined;
        if (key) {
          requestHeaders(draft, key);
        }
        if (type === 'discover') {
          const savedKey = previous && parseUrl(previous.url).origin === parseUrl(draft.url).origin
            ? await this.settings.secrets.get(secretName(id, previous))
            : undefined;
          const [models, metadata] = await Promise.all([
            fetchCatalog(draft, key ?? savedKey, string(message.catalogUrl).trim() || undefined),
            loadMetadata().catch(() => undefined),
          ]);
          await panel.webview.postMessage({
            type: 'catalog',
            models: metadata ? models.map(model => {
              const defaults = resolveDefaults(metadata, model.id, draft.url);
              return {
                ...model, ...defaults,
                name: model.name === model.id ? defaults?.name ?? model.name : model.name,
                maxInputTokens: model.maxInputTokens ?? defaults?.maxInputTokens,
                maxOutputTokens: model.maxOutputTokens ?? defaults?.maxOutputTokens,
              };
            }) : models,
          });
          return;
        }
        id ||= randomUUID();
        await this.settings.saveProvider(id, previous, draft, key);
        this.selection = id;
        status = 'Provider saved.';
      } else {
        if (!previous) {
          throw new Error('Save the provider first.');
        }
        if (type === 'test') {
          const model = previous.models.find(item => item.id === message.model);
          if (!model) {
            throw new Error('Select a saved model to test.');
          }
          const preference = vscode.workspace.getConfiguration().get<string>(languageKey, 'auto');
          const chinese = (preference === 'auto' ? vscode.env.language : preference).toLowerCase().startsWith('zh');
          const testing = chinese ? this.chinese['Testing {0}'] : 'Testing {0}';
          await vscode.window.withProgress({
            title: `${title}: ${testing.replace('{0}', () => model.name)}`,
            location: vscode.ProgressLocation.Notification, cancellable: true,
          }, (_progress, token) => this.provider.test(id, previous, model, token));
          status = `“${model.name}” responded successfully.`;
        } else if (type === 'remove') {
          await this.settings.removeProvider(id, previous);
          this.selection = '';
          status = 'Provider removed.';
        } else {
          await this.settings.setKey(id, previous, undefined);
          status = 'API key cleared.';
        }
      }
      await panel.webview.postMessage({ type: 'done', action: type, status });
    } catch (error) {
      const status = error instanceof vscode.CancellationError ? 'Test cancelled.'
        : error instanceof Error ? error.message : 'The operation failed.';
      await panel.webview.postMessage({ type: 'error', status });
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  private utilityOptions(connections: Record<string, Connection>, enabled: boolean): UtilityOption[] {
    return [...groupChannels(connections).values()].flatMap((channels): UtilityOption[] => {
      if (enabled) {
        const primary = channels[0];
        return [{ id: channelSelectionId(channels, true), name: primary.model.name, modelId: primary.model.id,
          ...(channels.length > 1 ? { sources: channels.length } : { provider: primary.connection.name }) }];
      }
      return channels.map(channel => ({ id: channel.id, name: channel.model.name, modelId: channel.model.id, provider: channel.connection.name }));
    });
  }

  private async saveModelSettings(type: string, message: Record<string, unknown>): Promise<string> {
    const connections = this.settings.get();
    const enabled = this.settings.routingEnabled();
    const previous = this.settings.utilityModels();
    if (type === 'saveUtility') {
      const ids = new Set(this.utilityOptions(connections, enabled).map(option => `${vendor}/${option.id}`));
      if (message.baseline !== JSON.stringify(previous)) {
        throw new Error('Model settings changed in another window. Reload them before saving.');
      }
      const values = array(message.values).map(string);
      if (values.length !== utilityKeys.length || values.some((value, index) => value && value !== previous[index] && !ids.has(value))) {
        throw new Error('Select a model from a saved provider.');
      }
      await this.settings.saveUtilityModels(values, previous);
      return 'Utility models saved.';
    }
    if (message.baseline !== enabled || typeof message.values !== 'boolean') {
      throw new Error('Model settings changed in another window. Reload them before saving.');
    }
    const next = message.values;
    const redirects = new Map<string, string>();
    for (const channels of groupChannels(connections).values()) {
      const merged = `${vendor}/${channelSelectionId(channels, true)}`;
      if (next) {
        channels.forEach(channel => redirects.set(`${vendor}/${channel.id}`, merged));
      } else {
        redirects.set(merged, `${vendor}/${channels[0].id}`);
      }
    }
    const updated = previous.map(value => redirects.get(value) ?? value);
    await this.settings.setRoutingEnabled(next);
    try {
      await this.settings.saveUtilityModels(updated, previous);
    } catch (error) {
      await this.settings.setRoutingEnabled(enabled);
      throw error;
    }
    this.provider.refreshRouting();
    return 'Channel routing saved.';
  }
}
