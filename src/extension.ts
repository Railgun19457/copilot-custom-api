import * as vscode from 'vscode';
import { Management } from './management';
import { ProviderManager } from './manager';
import { CustomApiProvider, settingsKey, vendor } from './provider';
import { Settings } from './settings';

export function activate(context: vscode.ExtensionContext): void {
  const settings = new Settings(context.secrets, context.globalState);
  const provider = new CustomApiProvider(() => settings.get(), context.secrets, () => settings.routingEnabled());
  const management = new Management(settings, provider);
  context.subscriptions.push(
    provider,
    new ProviderManager(context.extensionUri, settings, provider),
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
