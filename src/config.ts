export const protocols = {
  'chat-completions': 'OpenAI Chat Completions',
  responses: 'OpenAI Responses',
  messages: 'Anthropic Messages',
  'gemini-interactions': 'Gemini Interactions',
  'gemini-generate-content': 'Gemini GenerateContent',
} as const;

export type Protocol = keyof typeof protocols;
export type JsonObject = Record<string, unknown>;

export interface Model {
  id: string;
  name: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  toolCalling: boolean;
  vision: boolean;
  streaming: boolean;
  reasoningEffort?: string;
  reasoningEfforts?: string[];
  priority?: number;
  url?: string;
  fullUrl?: boolean;
  protocol?: Protocol;
  headers?: Record<string, string>;
  options: JsonObject;
}

export interface Connection {
  name: string;
  protocol: Protocol;
  url: string;
  fullUrl: boolean;
  auth: 'default' | 'bearer' | 'custom' | 'none';
  authHeader?: string;
  headerPreset?: 'copilot' | 'none';
  sessionId?: string;
  headers: Record<string, string>;
  models: Model[];
}

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const object = (value: unknown): JsonObject => isObject(value) ? value : {};
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const string = (value: unknown): string => typeof value === 'string' ? value : '';

export function validPriority(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const versionedPath = /\/v\d+(?:(?:beta|alpha)\d*)?$/i;
const headerName = /^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/;
const restrictedHeaders = /^(host|content-length|transfer-encoding|connection|cookie|set-cookie|proxy-.*|sec-.*)$/i;
const credentialQuery = /^(key|api[-_]?key|access[-_]?token|token|authorization|signature|sig)$/i;

export function parseUrl(value: string): URL {
  const url = new URL(value.replaceAll('{model}', 'model'));
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Enter an HTTP(S) URL without embedded credentials or a fragment.');
  }
  if (value.includes('{model}') && new URL(value.replaceAll('{model}', 'another-model')).origin !== url.origin) {
    throw new Error('The model placeholder cannot change the endpoint origin.');
  }
  for (const name of url.searchParams.keys()) {
    if (credentialQuery.test(name)) {
      throw new Error('Enter API credentials separately from the URL.');
    }
  }
  return url;
}

export function modelConnection(connection: Connection, model: Model): Connection {
  let url = model.url || connection.url;
  if (!model.url && model.protocol && model.protocol !== connection.protocol) {
    const base = parseUrl(connection.url);
    const path = base.pathname.replace(/\/+$/, '');
    const standardRoute = /\/(?:chat\/completions|responses|messages|interactions|models\/[^/]+:(?:streamGenerateContent|generateContent))$/;
    if (standardRoute.test(path)) {
      base.pathname = path.replace(standardRoute, '') || '/';
      base.searchParams.delete('alt');
      url = base.href;
    } else if (connection.fullUrl) {
      throw new Error('Use a provider base URL to select a different protocol for this model.');
    }
  }
  const differentOrigin = parseUrl(url).origin !== parseUrl(connection.url).origin;
  return {
    ...connection,
    url,
    fullUrl: model.url ? model.fullUrl === true : url === connection.url && connection.fullUrl,
    protocol: model.protocol ?? connection.protocol,
    headers: Object.fromEntries([
      ...Object.entries(differentOrigin ? {} : connection.headers),
      ...Object.entries(model.headers ?? {}),
    ].map(([name, value]) => [name.toLowerCase(), value])),
  };
}

export function endpoint(connection: Connection, model: Pick<Model, 'id' | 'streaming'>): URL {
  const geminiModel = model.id.replace(/^models\//, '');
  const base = parseUrl(connection.url);
  const url = parseUrl(connection.url.replaceAll('{model}', encodeURIComponent(geminiModel)));
  if (url.origin !== base.origin) {
    throw new Error('The model placeholder cannot change the endpoint origin.');
  }
  let path = url.pathname.replace(/\/+$/, '');

  if (connection.protocol === 'gemini-generate-content') {
    const action = model.streaming ? 'streamGenerateContent' : 'generateContent';
    if (/:(?:streamGenerateContent|generateContent)$/.test(path)) {
      url.pathname = path.replace(/:[^/:]+$/, `:${action}`);
    } else if (!connection.fullUrl) {
      if (!versionedPath.test(path)) {
        path += '/v1beta';
      }
      url.pathname = `${path}/models/${encodeURIComponent(geminiModel)}:${action}`;
    }
    if (model.streaming) {
      url.searchParams.set('alt', 'sse');
    } else if (url.searchParams.get('alt') === 'sse') {
      url.searchParams.delete('alt');
    }
    return url;
  }

  const action = {
    'chat-completions': '/chat/completions',
    responses: '/responses',
    messages: '/messages',
    'gemini-interactions': '/interactions',
  }[connection.protocol];
  if (!connection.fullUrl && !path.endsWith(action)) {
    url.pathname = path + (versionedPath.test(path) ? '' : '/v1') + action;
  }
  return url;
}

export function validateHeader(name: string, value: string): void {
  if (!headerName.test(name) || restrictedHeaders.test(name) || /[^\t\x20-\x7e\x80-\xff]/.test(value)) {
    throw new Error('Invalid or unsupported HTTP header.');
  }
}

export function requestHeaders(
  connection: Connection,
  apiKey?: string,
  request?: { defaults: Record<string, string>; sessionId: string },
): Headers {
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' });
  if (connection.protocol === 'messages') {
    headers.set('anthropic-version', '2023-06-01');
  }
  if (request && connection.headerPreset !== 'none') {
    for (const [name, value] of Object.entries(request.defaults)) {
      headers.set(name, value);
    }
  }
  if (request && (connection.headerPreset !== 'none' || connection.sessionId)) {
    validateHeader('X-Session-Id', request.sessionId);
    headers.set('X-Session-Id', request.sessionId);
  }
  for (const [name, value] of Object.entries(connection.headers)) {
    validateHeader(name, value);
    if (/^(authorization|api[-_]?key|x-.*(?:key|token)|.*secret)$/i.test(name)) {
      throw new Error('Set authentication headers using the API key and authentication controls.');
    }
    // Catalog requests have no conversation metadata.
    if (!request && value.includes('${sessionId}')) {
      continue;
    }
    const resolved = request ? value.replaceAll('${sessionId}', () => request.sessionId) : value;
    validateHeader(name, resolved);
    headers.set(name, resolved);
  }
  if (connection.auth === 'none') {
    return headers;
  }
  if (!apiKey) {
    throw new Error('This provider needs an API key. Set it in Manage Providers.');
  }
  const protocolHeader = {
    'chat-completions': 'Authorization',
    responses: 'Authorization',
    messages: 'x-api-key',
    'gemini-interactions': 'x-goog-api-key',
    'gemini-generate-content': 'x-goog-api-key',
  }[connection.protocol];
  const name = connection.auth === 'custom'
    ? connection.authHeader ?? ''
    : connection.auth === 'bearer' ? 'Authorization' : protocolHeader;
  const value = name.toLowerCase() === 'authorization' ? `Bearer ${apiKey}` : apiKey;
  validateHeader(name, value);
  headers.set(name, value);
  return headers;
}

export function effortList(value: unknown): string[] {
  return [...new Set((typeof value === 'string' ? value.split(/[\s,，]+/) : array(value))
    .map(item => string(item).trim()).filter(item => /^[a-zA-Z0-9_-]+$/.test(item)))];
}

export function effectiveReasoningEffort(model: Model, selected: unknown): string | undefined {
  return typeof selected === 'string' && model.reasoningEfforts?.includes(selected) ? selected : model.reasoningEffort;
}

function storedHeaders(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object(value)).filter((item): item is [string, string] => typeof item[1] === 'string'),
  );
}

export function configuredConnections(value: unknown): Record<string, Connection> {
  const valid: Record<string, Connection> = Object.create(null);
  for (const [key, entry] of Object.entries(object(value))) {
    if (!/^[a-zA-Z0-9_-]+$/.test(key) || !isObject(entry) ||
      !string(entry.name).trim() || !Object.hasOwn(protocols, string(entry.protocol)) ||
      !['default', 'bearer', 'custom', 'none'].includes(string(entry.auth))) {
      continue;
    }
    try {
      parseUrl(string(entry.url));
      if (entry.auth === 'custom') {
        validateHeader(string(entry.authHeader), '');
      }
    } catch {
      continue;
    }
    const headers = storedHeaders(entry.headers);
    const models = new Map<string, Model>();
    for (const item of array(entry.models)) {
      const data = object(item);
      const id = string(data.id).trim();
      if (!id || !Number.isSafeInteger(data.maxInputTokens) || Number(data.maxInputTokens) <= 0 ||
        !Number.isSafeInteger(data.maxOutputTokens) || Number(data.maxOutputTokens) <= 0) {
        continue;
      }
      const efforts = effortList(data.reasoningEfforts);
      const url = string(data.url).trim();
      models.set(id, {
        id,
        name: string(data.name).trim() || id,
        maxInputTokens: Number(data.maxInputTokens),
        maxOutputTokens: Number(data.maxOutputTokens),
        toolCalling: data.toolCalling === true,
        vision: data.vision === true,
        streaming: data.streaming !== false,
        reasoningEffort: string(data.reasoningEffort).trim() || undefined,
        ...(efforts.length ? { reasoningEfforts: efforts } : {}),
        ...(validPriority(data.priority) && data.priority > 0 ? { priority: data.priority } : {}),
        ...(url ? { url, fullUrl: data.fullUrl === true } : {}),
        ...(Object.hasOwn(protocols, string(data.protocol)) ? { protocol: data.protocol as Protocol } : {}),
        ...(Object.keys(object(data.headers)).length ? { headers: storedHeaders(data.headers) } : {}),
        options: object(data.options),
      });
    }
    valid[key] = {
      name: string(entry.name),
      protocol: entry.protocol as Protocol,
      url: string(entry.url),
      fullUrl: entry.fullUrl === true,
      auth: entry.auth as Connection['auth'],
      authHeader: string(entry.authHeader) || undefined,
      ...(entry.headerPreset === 'none' ? { headerPreset: 'none' as const } : {}),
      ...(string(entry.sessionId).trim() ? { sessionId: string(entry.sessionId).trim() } : {}),
      headers,
      models: [...models.values()],
    };
  }
  return valid;
}
