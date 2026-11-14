import { Connection, Model } from './config';

export const utilityKeys = ['chat.utilityModel', 'chat.utilitySmallModel'] as const;
export const routingStateKey = 'channelRoutingEnabled';
export const failoverThreshold = 2;
export const channelCooldownMs = 60_000;

export interface Channel {
  id: string;
  connectionId: string;
  connection: Connection;
  model: Model;
}

export function routedModelId(id: string): string {
  return `.routing/${Buffer.from(id).toString('base64url')}`;
}

export function groupChannels(connections: Record<string, Connection>): Map<string, Channel[]> {
  const groups = new Map<string, Channel[]>();
  for (const [connectionId, connection] of Object.entries(connections)) {
    for (const model of connection.models) {
      const group = groups.get(model.id) ?? [];
      group.push({ id: `${connectionId}/${model.id}`, connectionId, connection, model });
      groups.set(model.id, group);
    }
  }
  for (const channels of groups.values()) {
    channels.sort((left, right) => (right.model.priority ?? 0) - (left.model.priority ?? 0));
  }
  return groups;
}

export function channelSelectionId(channels: Channel[], routingEnabled: boolean): string {
  return routingEnabled ? routedModelId(channels[0].model.id) : channels[0].id;
}

export class ChannelHealth {
  private readonly failures = new Map<string, { count: number; retryAt: number }>();

  clear(): void {
    this.failures.clear();
  }

  succeeded(key: string): void {
    this.failures.delete(key);
  }

  failed(key: string, now = Date.now()): boolean {
    const previous = this.failures.get(key);
    if (previous && previous.retryAt > now) {
      return true;
    }
    const count = previous && previous.retryAt === 0 ? previous.count + 1 : 1;
    const cooldown = count >= failoverThreshold;
    this.failures.set(key, { count, retryAt: cooldown ? now + channelCooldownMs : 0 });
    return cooldown;
  }

  available(key: string, now = Date.now()): boolean {
    const retryAt = this.failures.get(key)?.retryAt ?? 0;
    if (retryAt > now) {
      return false;
    }
    if (retryAt) {
      this.failures.delete(key);
    }
    return true;
  }
}
