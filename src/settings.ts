import { isDeepStrictEqual } from 'node:util';
import * as vscode from 'vscode';
import { configuredConnections, Connection, modelConnection, object, parseUrl } from './config';
import { secretName, settingsKey } from './provider';
import { routingStateKey, utilityKeys } from './routing';

export class Settings {
  constructor(readonly secrets: vscode.SecretStorage, private readonly state: vscode.Memento) {}

  get(): Record<string, Connection> {
    return configuredConnections(vscode.workspace.getConfiguration().get(settingsKey));
  }

  routingEnabled(): boolean {
    return this.state.get(routingStateKey, false);
  }

  async setRoutingEnabled(enabled: boolean): Promise<void> {
    await this.state.update(routingStateKey, enabled);
  }

  utilityModels(): string[] {
    const config = vscode.workspace.getConfiguration();
    return utilityKeys.map(key => config.inspect<string>(key)?.globalValue ?? '');
  }

  async saveUtilityModels(models: string[], previous: string[]): Promise<void> {
    if (!isDeepStrictEqual(this.utilityModels(), previous)) {
      throw new Error('Model settings changed in another window. Reload them before saving.');
    }
    const config = vscode.workspace.getConfiguration();
    const changed: number[] = [];
    try {
      for (const [index, key] of utilityKeys.entries()) {
        if (models[index] !== previous[index]) {
          await config.update(key, models[index] || undefined, vscode.ConfigurationTarget.Global);
          changed.push(index);
        }
      }
    } catch (error) {
      for (const index of changed.reverse()) {
        await config.update(utilityKeys[index], previous[index] || undefined, vscode.ConfigurationTarget.Global);
      }
      throw error;
    }
  }

  assertCurrent(id: string, previous: Connection | undefined): void {
    if (!isDeepStrictEqual(this.get()[id], previous)) {
      throw new Error('This provider changed in another window. Reopen Manage Providers and try again.');
    }
  }

  async save(id: string, previous: Connection | undefined, next: Connection | undefined): Promise<void> {
    this.assertCurrent(id, previous);
    const config = vscode.workspace.getConfiguration();
    const entries = { ...object(config.get(settingsKey)) };
    if (next) {
      entries[id] = next;
    } else {
      delete entries[id];
    }
    await config.update(settingsKey, entries, vscode.ConfigurationTarget.Global);
  }

  async setKey(id: string, connection: Connection, value: string | undefined): Promise<void> {
    this.assertCurrent(id, connection);
    const key = secretName(id, connection);
    if (value) {
      await this.secrets.store(key, value);
    } else {
      await this.secrets.delete(key);
    }
  }

  async saveProvider(
    id: string,
    previous: Connection | undefined,
    next: Connection,
    replacementKey?: string,
  ): Promise<void> {
    this.assertCurrent(id, previous);
    const nextOrigins = this.endpointOrigins(next);
    const name = secretName(id, next);
    // Store the replacement first so a failed secret write cannot publish an unusable provider.
    const priorKey = replacementKey ? await this.secrets.get(name) : undefined;
    try {
      if (replacementKey) {
        await this.secrets.store(name, replacementKey);
      }
      await this.save(id, previous, next);
    } catch (error) {
      if (replacementKey) {
        if (priorKey === undefined) {
          await this.secrets.delete(name);
        } else {
          await this.secrets.store(name, priorKey);
        }
      }
      throw error;
    }
    if (previous) {
      for (const origin of this.endpointOrigins(previous)) {
        if (!nextOrigins.has(origin)) {
          await this.secrets.delete(secretName(id, { url: origin }));
        }
      }
    }
  }

  async removeProvider(id: string, previous: Connection): Promise<void> {
    await this.save(id, previous, undefined);
    for (const origin of this.endpointOrigins(previous)) {
      await this.secrets.delete(secretName(id, { url: origin }));
    }
  }

  endpointOrigins(connection: Connection): Set<string> {
    const origins = new Set([parseUrl(connection.url).origin]);
    for (const model of connection.models) {
      try {
        origins.add(parseUrl(modelConnection(connection, model).url).origin);
      } catch {
        // Malformed hand-edited overrides should not prevent provider management.
      }
    }
    return origins;
  }
}
