import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { Connection, effectiveReasoningEffort, endpoint, Model, modelConnection, object, parseUrl, requestHeaders, string, validateHeader } from './config';
import { post, readEvents } from './http';
import { anthropicMessages } from './protocols/anthropic';
import { geminiGenerateContent, geminiInteractions } from './protocols/gemini';
import { chatCompletions, responses } from './protocols/openai';
import { Adapter, Image, Message, NativeTurn, Part, Request, Text, ToolCall } from './protocols/types';
import { Channel, ChannelHealth, channelSelectionId, groupChannels, routedModelId } from './routing';

export const vendor = 'copilot-custom-api';
export const settingsKey = 'copilotCustomApi.providers';
const turnMime = 'application/vnd.copilot-custom-api.turn+json';
const sessionMime = 'application/vnd.copilot-custom-api.session+json';
const timeoutMs = 300_000;
const adapters = {
  'chat-completions': chatCompletions,
  responses,
  messages: anthropicMessages,
  'gemini-generate-content': geminiGenerateContent,
  'gemini-interactions': geminiInteractions,
} satisfies Record<Connection['protocol'], Adapter>;

type RegisteredModel = vscode.LanguageModelChatInformation & {
  isBYOK: true;
  connectionId?: string;
  upstreamId: string;
};

type CachedTurn = { scope: string; created: number; value: NativeTurn; aliases: string[] };

export function secretName(connectionId: string, connection: Pick<Connection, 'url'>): string {
  const origin = parseUrl(connection.url).origin;
  return `apiKey.${connectionId}.${createHash('sha256').update(origin).digest('hex')}`;
}

function exposedCallId(id: string): string {
  return `cca_${randomUUID().replaceAll('-', '')}_${Buffer.from(id).toString('base64url')}`;
}

function upstreamCallId(id: string): string {
  const match = /^cca_[a-f0-9]{32}_([a-zA-Z0-9_-]+)$/.exec(id);
  return match ? Buffer.from(match[1], 'base64url').toString('utf8') : id;
}

function toContent(part: unknown): Text | Image | undefined {
  if (part instanceof vscode.LanguageModelTextPart) {
    return { type: 'text', text: part.value };
  }
  if (part instanceof vscode.LanguageModelDataPart) {
    if (part.mimeType.startsWith('image/')) {
      return { type: 'image', mime: part.mimeType, base64: Buffer.from(part.data).toString('base64') };
    }
    if (part.mimeType.startsWith('text/') || part.mimeType === 'application/json') {
      return { type: 'text', text: Buffer.from(part.data).toString('utf8') };
    }
  }
  return undefined;
}

function toPart(part: unknown): Part | undefined {
  if (part instanceof vscode.LanguageModelToolCallPart) {
    return { type: 'call', id: upstreamCallId(part.callId), name: part.name, input: object(part.input) };
  }
  if (part instanceof vscode.LanguageModelToolResultPart) {
    const content = part.content.map(toContent).filter((item): item is Text | Image => item !== undefined);
    return { type: 'result', id: upstreamCallId(part.callId), content };
  }
  return toContent(part);
}

function estimateTokens(text: string): number {
  const ascii = text.replace(/[^\x00-\x7F]/gu, '').length;
  const bytes = Buffer.byteLength(text);
  return Math.ceil(ascii / 4 + (bytes - ascii) / 2);
}

function compatibleChannels(
  channels: Channel[], messages: readonly vscode.LanguageModelChatRequestMessage[], toolsOffered: boolean, requestedEffort: string,
): Channel[] {
  const parts = messages.flatMap(message => message.content.map(toPart));
  const needsImage = parts.some(part => part?.type === 'image' || (part?.type === 'result' && part.content.some(item => item.type === 'image')));
  const needsToolHistory = parts.some(part => part?.type === 'call' || part?.type === 'result');
  const needsTools = needsToolHistory || (toolsOffered && channels.some(channel => channel.model.toolCalling));
  const useEffort = requestedEffort && channels.some(channel => channel.model.reasoningEfforts?.includes(requestedEffort));
  return channels.filter(({ model }) => (!needsImage || model.vision) && (!needsTools || model.toolCalling) &&
    (!useEffort || model.reasoningEfforts?.includes(requestedEffort)));
}

export class CustomApiProvider implements vscode.LanguageModelChatProvider<RegisteredModel>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  private readonly turns = new Map<string, CachedTurn>();
  private readonly turnByCall = new Map<string, string>();
  private readonly callSessions = new Map<string, { id: string; scope: string; created: number }>();
  private readonly sessions = new Map<string, { id: string; scope: string; created: number }>();
  private readonly channelHealth = new ChannelHealth();
  readonly onDidChangeLanguageModelChatInformation = this.changes.event;

  constructor(
    private readonly connections: () => Record<string, Connection>,
    private readonly secrets: vscode.SecretStorage,
    private readonly routingEnabled: () => boolean,
  ) {}

  refresh(): void {
    this.changes.fire();
  }

  refreshRouting(): void {
    this.channelHealth.clear();
    this.refresh();
  }

  dispose(): void {
    this.changes.dispose();
    this.turns.clear();
    this.turnByCall.clear();
    this.callSessions.clear();
    this.sessions.clear();
    this.channelHealth.clear();
  }

  provideLanguageModelChatInformation(): RegisteredModel[] {
    const routed = this.routingEnabled();
    const groups = [...groupChannels(this.connections()).values()];
    const listings = routed ? groups : groups.flatMap(group => group.map(channel => [channel]));
    const nameCounts = new Map<string, number>();
    for (const [{ model }] of listings) {
      const name = model.name.toLowerCase();
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    const chinese = vscode.env.language.toLowerCase().startsWith('zh');
    return listings.map(channels => {
      const [{ connectionId, connection, model }] = channels;
      const merged = channels.length > 1;
      const reasoningEfforts = [...new Set(channels.flatMap(channel => channel.model.reasoningEfforts ?? []))];
      const defaultEffort = model.reasoningEffort;
      return {
        id: channelSelectionId(channels, routed),
        name: (nameCounts.get(model.name.toLowerCase()) ?? 0) > 1 ? `${model.name} · ${merged ? model.id : connection.name}` : model.name,
        family: model.id,
        version: '1',
        detail: merged ? (chinese ? `${channels.length} 个渠道` : `${channels.length} channels`) : connection.name,
        isBYOK: true,
        maxInputTokens: Math.min(...channels.map(channel => channel.model.maxInputTokens)),
        maxOutputTokens: Math.min(...channels.map(channel => channel.model.maxOutputTokens)),
        capabilities: {
          toolCalling: channels.some(channel => channel.model.toolCalling),
          imageInput: channels.some(channel => channel.model.vision),
        },
        // VS Code 1.145 forwards this metadata and the selected value through its BYOK bridge.
        ...(reasoningEfforts.length ? {
          configurationSchema: {
            type: 'object',
            properties: {
              reasoningEffort: {
                type: 'string', group: 'navigation',
                title: chinese ? '推理强度' : 'Reasoning Effort',
                enum: reasoningEfforts,
                ...(defaultEffort && channels.every(channel => channel.model.reasoningEfforts?.includes(defaultEffort))
                  ? { default: defaultEffort } : {}),
              },
            },
          },
        } : {}),
        connectionId: routed ? undefined : connectionId,
        upstreamId: model.id,
      };
    });
  }

  async provideTokenCount(
    _model: RegisteredModel,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Promise<number> {
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    if (typeof text === 'string') {
      return estimateTokens(text);
    }
    let total = 3;
    for (const raw of text.content) {
      const part = toPart(raw);
      if (part?.type === 'text') {
        total += estimateTokens(part.text);
      } else if (part?.type === 'image') {
        total += 1_024;
      } else if (part?.type === 'call') {
        total += estimateTokens(part.name + JSON.stringify(part.input));
      } else if (part?.type === 'result') {
        for (const item of part.content) {
          total += item.type === 'image' ? 1_024 : estimateTokens(item.text);
        }
      }
    }
    return total;
  }

  async provideLanguageModelChatResponse(
    selected: RegisteredModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const connections = this.connections();
    const extended = object(options);
    const requestedOptions = object(options.modelOptions);
    const requireTool = options.toolMode === vscode.LanguageModelChatToolMode.Required;
    const tools = options.tools ?? [];
    const group = groupChannels(connections).get(selected.upstreamId) ?? [];
    const routed = this.routingEnabled();
    const channels = routed ? group : selected.connectionId
      ? group.filter(channel => channel.connectionId === selected.connectionId) : group.slice(0, 1);
    if (!channels.length) {
      throw vscode.LanguageModelError.NotFound('The configured model was removed.');
    }
    const explicitEffort = string(requestedOptions.reasoningEffort);
    const requestedEffort = channels.some(channel => channel.model.reasoningEfforts?.includes(explicitEffort))
      ? explicitEffort : string(object(extended.modelConfiguration).reasoningEffort);
    const eligible = routed ? compatibleChannels(channels, messages, tools.length > 0, requestedEffort)
      .filter(channel => !requireTool || channel.model.toolCalling) : channels;
    if (!eligible.length) {
      const chinese = vscode.env.language.toLowerCase().startsWith('zh');
      throw new Error(chinese ? '该模型没有支持本次请求的渠道，请检查图片、工具和推理强度配置。'
        : 'No channel for this model supports the requested images, tools, or reasoning effort.');
    }
    const routedSession = routed ? this.resolveSession(undefined, channelSelectionId(channels, true), messages, extended) : undefined;
    let lastError: unknown;
    for (const channel of eligible) {
      const key = channel.id;
      if (routed && eligible.length > 1 && !this.channelHealth.available(key)) {
        continue;
      }
      let emitted = false;
      try {
        await this.sendChat(channel, messages, options, routedSession, {
          report: part => { emitted = true; progress.report(part); },
        }, token);
        if (routed) {
          this.channelHealth.succeeded(key);
        }
        return;
      } catch (error) {
        lastError = error;
        if (!routed || eligible.length === 1 || token.isCancellationRequested || error instanceof vscode.CancellationError) {
          throw error;
        }
        const failover = this.channelHealth.failed(key);
        if (!failover || emitted) {
          throw error;
        }
      }
    }
    if (lastError) {
      throw lastError;
    }
    const chinese = vscode.env.language.toLowerCase().startsWith('zh');
    throw new Error(chinese ? '该模型的可用渠道均处于冷却期，请稍后重试。' : 'All eligible channels for this model are cooling down. Try again shortly.');
  }

  private async sendChat(
    { id, connectionId, connection, model }: Channel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    routedSession: string | undefined,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const route = modelConnection(connection, model);
    const url = endpoint(route, model);
    const scope = JSON.stringify([id, route.protocol, url.href]);
    const sessionScope = routedSession ? routedModelId(model.id) : scope;
    const converted = messages.map(message => this.toMessage(message, scope));
    const extended = object(options);
    const requestedOptions = object(options.modelOptions);
    const requestedEffort = string(requestedOptions.reasoningEffort);
    const reasoningEffort = effectiveReasoningEffort(model, model.reasoningEfforts?.includes(requestedEffort)
      ? requestedEffort : object(extended.modelConfiguration).reasoningEffort);
    const sessionId = route.sessionId || routedSession || this.resolveSession(route, scope, messages, extended);
    const requestedMax = requestedOptions.max_tokens;
    const maxOutputTokens = typeof requestedMax === 'number' && Number.isSafeInteger(requestedMax) && requestedMax > 0
      ? Math.min(requestedMax, model.maxOutputTokens) : undefined;
    const calls: ToolCall[] = [];
    const native = await this.send(connectionId, route, {
      model: { ...model, reasoningEffort },
      url,
      messages: converted,
      tools: model.toolCalling ? options.tools ?? [] : [],
      requireTool: options.toolMode === vscode.LanguageModelChatToolMode.Required,
      maxOutputTokens,
    }, sessionId, token, part => {
      if (part.type === 'text') {
        progress.report(new vscode.LanguageModelTextPart(part.text));
      } else if (part.type === 'image') {
        progress.report(vscode.LanguageModelDataPart.image(Buffer.from(part.base64, 'base64'), part.mime));
      } else {
        calls.push(part);
      }
    });
    const ids = calls.map(call => exposedCallId(call.id));
    if (native) {
      const ref = this.rememberTurn(scope, native, ids);
      if (ref) {
        progress.report(vscode.LanguageModelDataPart.json({ ref }, turnMime));
      }
    }
    const rememberedSessionId = routedSession ?? sessionId;
    if (routedSession || route.headerPreset !== 'none' || Object.values(route.headers).some(value => value.includes('${sessionId}'))) {
      const ref = randomUUID();
      if (this.sessions.size >= 128) {
        const oldest = this.sessions.keys().next().value;
        if (oldest) {
          this.sessions.delete(oldest);
        }
      }
      this.sessions.set(ref, { id: rememberedSessionId, scope: sessionScope, created: Date.now() });
      progress.report(vscode.LanguageModelDataPart.json({ ref }, sessionMime));
    }
    for (const [index, call] of calls.entries()) {
      if (this.callSessions.size >= 256) {
        const oldest = this.callSessions.keys().next().value;
        if (oldest) {
          this.callSessions.delete(oldest);
        }
      }
      this.callSessions.set(ids[index], { id: rememberedSessionId, scope: sessionScope, created: Date.now() });
      progress.report(new vscode.LanguageModelToolCallPart(ids[index], call.name, call.input));
    }
  }

  async test(connectionId: string, connection: Connection, model: Model, token: vscode.CancellationToken): Promise<void> {
    const route = modelConnection(connection, model);
    await this.send(connectionId, route, {
      model,
      url: endpoint(route, model),
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Reply with OK.' }] }],
      tools: [],
      requireTool: false,
    }, route.sessionId || randomUUID(), token, () => undefined);
  }

  private async send(
    connectionId: string,
    connection: Connection,
    request: Request,
    sessionId: string,
    token: vscode.CancellationToken,
    report: (part: Text | Image | ToolCall) => void,
  ): Promise<NativeTurn | undefined> {
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    if (request.requireTool && !request.tools.length) {
      throw new Error('A tool is required but the selected model has no available tools.');
    }
    if (!request.model.vision && request.messages.some(message => message.parts.some(part =>
      part.type === 'image' || (part.type === 'result' && part.content.some(item => item.type === 'image')),
    ))) {
      throw new Error('Image input is disabled for the selected model.');
    }
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      const key = connection.auth === 'none' ? undefined : await this.secrets.get(secretName(connectionId, connection));
      const copilot = vscode.extensions.getExtension('GitHub.copilot-chat');
      const version = string(copilot?.packageJSON.version);
      const headers = requestHeaders(connection, key, {
        sessionId,
        defaults: {
          'User-Agent': version ? `GitHubCopilotChat/${version}` : 'CopilotCustomAPI',
          'Editor-Version': `vscode/${vscode.version}`,
          ...(version ? { 'Editor-Plugin-Version': `copilot-chat/${version}` } : {}),
          'Copilot-Integration-Id': 'vscode-chat',
          'X-Request-Id': randomUUID(),
        },
      });
      const adapter = adapters[connection.protocol];
      const response = await post(request.url, headers, adapter.build(request), controller.signal);
      let received = false;
      const native = await adapter.read(readEvents(response, request.model.streaming), part => {
        received = true;
        if (!token.isCancellationRequested) {
          report(part);
        }
      });
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      if (!received) {
        throw new Error('The endpoint returned no text, image, or tool call.');
      }
      return native;
    } catch (error) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      if (controller.signal.aborted) {
        throw new Error('The model request timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      subscription.dispose();
    }
  }

  private resolveSession(
    connection: Connection | undefined,
    scope: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: Record<string, unknown>,
  ): string {
    if (connection?.sessionId) {
      validateHeader('X-Session-Id', connection.sessionId);
      return connection.sessionId;
    }
    const modelOptions = object(options.modelOptions);
    // The Copilot BYOK bridge supplies its stable conversation ID under this internal field.
    for (const candidate of [modelOptions.chatSessionId, modelOptions.sessionId, modelOptions._conversationId]) {
      const supplied = string(candidate).trim();
      if (/^[\x21-\x7e]{1,256}$/.test(supplied)) {
        return supplied;
      }
    }
    for (const message of [...messages].reverse()) {
      for (const part of message.content) {
        if (part instanceof vscode.LanguageModelDataPart && part.mimeType === sessionMime && part.data.length < 200) {
          try {
            const ref = string(object(JSON.parse(Buffer.from(part.data).toString('utf8'))).ref);
            const known = this.sessions.get(ref);
            if (known?.scope === scope && Date.now() - known.created < 30 * 60_000) {
              return known.id;
            }
          } catch {
            // Unrecognized data parts do not identify a conversation.
          }
        }
        if (part instanceof vscode.LanguageModelToolCallPart) {
          const session = this.callSessions.get(part.callId);
          if (session?.scope === scope && Date.now() - session.created < 30 * 60_000) {
            return session.id;
          }
        }
      }
    }
    return randomUUID();
  }

  private toMessage(message: vscode.LanguageModelChatRequestMessage, scope: string): Message {
    const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant'
      : message.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'system';
    const parts = message.content.map(toPart).filter((part): part is Part => part !== undefined);
    const result: Message = { role, parts };
    if (role !== 'assistant') {
      return result;
    }
    const refs = new Set<string>();
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelDataPart && part.mimeType === turnMime && part.data.length < 200) {
        try {
          refs.add(string(object(JSON.parse(Buffer.from(part.data).toString('utf8'))).ref));
        } catch {
          // Other chat clients may not preserve extension data parts.
        }
      }
      if (part instanceof vscode.LanguageModelToolCallPart) {
        const ref = this.turnByCall.get(part.callId);
        if (ref) {
          refs.add(ref);
        }
      }
    }
    const candidates = [...refs].map(ref => this.turns.get(ref))
      .filter(turn => turn?.scope === scope && Date.now() - turn.created < 30 * 60_000);
    if (candidates.length === 1) {
      const native = candidates[0]?.value;
      const calls = parts.filter((part): part is ToolCall => part.type === 'call');
      if (native && calls.length === native.callIds.length && calls.every(call => native.callIds.includes(call.id))) {
        result.native = native;
      }
    }
    return result;
  }

  private rememberTurn(scope: string, value: NativeTurn, aliases: string[]): string | undefined {
    if (Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) {
      return undefined;
    }
    while (this.turns.size >= 64) {
      const oldest = this.turns.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.turns.get(oldest)?.aliases.forEach(alias => this.turnByCall.delete(alias));
      this.turns.delete(oldest);
    }
    const ref = randomUUID();
    this.turns.set(ref, { scope, value, created: Date.now(), aliases });
    aliases.forEach(alias => this.turnByCall.set(alias, ref));
    return ref;
  }
}
