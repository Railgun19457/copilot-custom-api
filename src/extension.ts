import * as vscode from 'vscode';
import { Management } from './management';
import { ProviderManager } from './manager';
import { CustomApiProvider, settingsKey, vendor } from './provider';
import { Settings } from './settings';
import { UsageStore } from './usage';

let usage: UsageStore | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const settings = new Settings(context.secrets, context.globalState);
  const usageChanges = new vscode.EventEmitter<void>();
  usage = new UsageStore(vscode.Uri.joinPath(context.globalStorageUri, 'usage').fsPath, () => usageChanges.fire());
  const provider = new CustomApiProvider(() => settings.get(), context.secrets, () => settings.routingEnabled(), usage);
  const management = new Management(settings, provider);
  context.subscriptions.push(
    provider,
    usageChanges,
    new ProviderManager(context.extensionUri, settings, provider, usage, usageChanges.event),
    vscode.lm.registerLanguageModelChatProvider(vendor, provider),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(settingsKey)) {
        provider.refreshRouting();
      }
    }),
    vscode.commands.registerCommand('copilotCustomApi.manage', () => management.run()),
    vscode.commands.registerCommand('copilotCustomApi.addProvider', () => management.run(true)),
  );
}

export function deactivate(): Promise<void> | undefined {
  return usage?.flush();
}
