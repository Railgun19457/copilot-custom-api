import { array, isObject, JsonObject, Model, object, string } from '../config';

export type Image = { type: 'image'; mime: string; base64: string };
export type Text = { type: 'text'; text: string };
export type ToolCall = { type: 'call'; id: string; name: string; input: JsonObject };
export type ToolResult = { type: 'result'; id: string; content: (Text | Image)[] };
export type Part = Text | Image | ToolCall | ToolResult;
export type NativeTurn = { items: JsonObject[]; callIds: string[] };

export interface Message {
  role: 'system' | 'user' | 'assistant';
  parts: Part[];
  native?: NativeTurn;
}

export interface Request {
  model: Model;
  url: URL;
  messages: Message[];
  tools: readonly { name: string; description: string; inputSchema?: object }[];
  requireTool: boolean;
  maxOutputTokens?: number;
}

export interface Event {
  name: string;
  data: JsonObject;
  json: boolean;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number };
  completion_tokens_details?: { reasoning_tokens: number };
}

export interface ResponseMetadata {
  native?: NativeTurn;
  usage?: TokenUsage;
}

export interface Adapter {
  build(request: Request): JsonObject;
  read(events: AsyncIterable<Event>, report: (part: Text | ToolCall | Image) => void): Promise<ResponseMetadata>;
}

export function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// Streaming APIs can send cumulative counts in separate events.
export function updateUsage(previous: JsonObject, next: unknown): JsonObject {
  return {
    ...previous,
    ...Object.fromEntries(Object.entries(object(next)).filter(([, value]) => value != null)),
  };
}

export function tokenUsage(
  input: unknown, output: unknown, total?: unknown,
  details: { cached?: unknown; cacheWrite?: unknown; reasoning?: unknown } = {},
): TokenUsage | undefined {
  const inputTokens = tokenCount(input);
  const totalTokens = tokenCount(total);
  const outputTokens = tokenCount(output) ?? (inputTokens !== undefined && totalTokens !== undefined
    ? tokenCount(totalTokens - inputTokens) : undefined);
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  const cached = tokenCount(details.cached);
  const written = tokenCount(details.cacheWrite);
  const reasoning = tokenCount(details.reasoning);
  const promptDetails: TokenUsage['prompt_tokens_details'] =
    cached !== undefined || written !== undefined ? {
      ...(cached !== undefined ? { cached_tokens: cached } : {}),
      ...(written !== undefined ? { cache_creation_input_tokens: written } : {}),
    } : undefined;
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: totalTokens ?? inputTokens + outputTokens,
    ...(promptDetails ? { prompt_tokens_details: promptDetails } : {}),
    ...(reasoning !== undefined ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
  };
}

export function textParts(parts: readonly Part[]): string {
  return parts.filter((part): part is Text => part.type === 'text').map(part => part.text).join('');
}

export function systemText(messages: readonly Message[]): string {
  return messages.filter(message => message.role === 'system').map(message => textParts(message.parts)).join('\n\n');
}

export function imageUrl(part: Image): string {
  return `data:${part.mime};base64,${part.base64}`;
}

export function argumentsObject(value: unknown): JsonObject {
  if (isObject(value)) {
    return value;
  }
  try {
    const decoded: unknown = typeof value === 'string' && value.trim() ? JSON.parse(value) : {};
    if (isObject(decoded)) {
      return decoded;
    }
  } catch {
    // Use a protocol error without echoing the potentially sensitive arguments.
  }
  throw new Error('The endpoint returned invalid tool arguments.');
}

export function toolCall(id: unknown, name: unknown, input: unknown): ToolCall {
  if (!string(id) || !string(name)) {
    throw new Error('The endpoint returned a tool call without an ID or name.');
  }
  return { type: 'call', id: string(id), name: string(name), input: argumentsObject(input) };
}

export function checkStreamError(event: Event): void {
  const type = string(event.data.type) || string(event.data.event_type) || event.name;
  if (event.data.error || ['error', 'response.failed', 'interaction.failed', 'interaction.error'].includes(type)) {
    const error = object(event.data.error ?? object(event.data.response).error);
    const code = string(error.code) || string(error.type);
    const detail = /^[\w.-]{1,70}$/.test(code) ? ` (${code})` : '';
    throw new Error(`The endpoint reported a generation error${detail}.`);
  }
}

export function records(value: unknown): JsonObject[] {
  return array(value).filter(isObject);
}

export function findCallNames(messages: readonly Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'call') {
        names.set(part.id, part.name);
      }
    }
  }
  return names;
}

export function callName(names: ReadonlyMap<string, string>, id: string): string {
  const name = names.get(id);
  if (!name) {
    throw new Error('A tool result is missing its preceding tool call.');
  }
  return name;
}

export function schema(tool: Request['tools'][number]): object {
  return tool.inputSchema ?? { type: 'object', properties: {} };
}
