import { isObject } from './config';
import { Event } from './protocols/types';

const maxEventLength = 16 * 1024 * 1024;

function decode(value: string, name: string, json: boolean): Event {
  if (value.trim() === '[DONE]') {
    return { name: '[DONE]', data: {}, json: false };
  }
  let data: unknown;
  try {
    data = JSON.parse(value);
  } catch {
    throw new Error('The endpoint returned invalid JSON.');
  }
  if (!isObject(data)) {
    throw new Error('The endpoint returned an unexpected response.');
  }
  return { name, data, json };
}

export async function* readEvents(response: Response, streaming: boolean): AsyncGenerator<Event> {
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const sse = mime === 'text/event-stream' || (streaming && (!mime || mime === 'application/octet-stream'));
  if (!response.body) {
    throw new Error('The endpoint returned an empty response.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let name = '';
  let data: string[] = [];
  let size = 0;

  function processLine(line: string): Event | undefined {
    if (!line) {
      const event = data.length ? decode(data.join('\n'), name, false) : undefined;
      name = '';
      data = [];
      size = 0;
      return event;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') {
      name = value;
    } else if (field === 'data') {
      size += value.length + 1;
      if (size > maxEventLength) {
        throw new Error('The endpoint returned an oversized stream event.');
      }
      data.push(value);
    }
    return undefined;
  }

  try {
    if (!sse) {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          yield decode(pending + decoder.decode(), '', true);
          return;
        }
        pending += decoder.decode(chunk.value, { stream: true });
        if (pending.length > maxEventLength) {
          throw new Error('The endpoint returned an oversized JSON response.');
        }
      }
    }
    let done = false;
    let scanned = 0;
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      pending += done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let consumed = 0;
      let index = scanned;
      for (; index < pending.length; index++) {
        const char = pending[index];
        if (char !== '\n' && char !== '\r') {
          continue;
        }
        if (char === '\r' && index === pending.length - 1 && !done) {
          break;
        }
        const event = processLine(pending.slice(consumed, index));
        if (char === '\r' && pending[index + 1] === '\n') {
          index++;
        }
        consumed = index + 1;
        if (event) {
          yield event;
        }
      }
      pending = pending.slice(consumed);
      scanned = index - consumed;
      if (pending.length > maxEventLength) {
        throw new Error('The endpoint returned an oversized stream line.');
      }
    }
    if (pending) {
      processLine(pending);
    }
    const last = processLine('');
    if (last) {
      yield last;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function post(url: URL, headers: Headers, body: object, signal: AbortSignal): Promise<Response> {
  return sendRequest(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
}

export async function sendRequest(url: URL, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: 'manual' });
  } catch (error) {
    if (init.signal?.aborted) {
      throw init.signal.reason;
    }
    const code = error instanceof Error && isObject(error.cause) ? error.cause.code : undefined;
    const suffix = typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : '';
    throw new Error(`Could not connect to the configured endpoint${suffix}.`);
  }
  if (response.ok) {
    return response;
  }
  await response.body?.cancel().catch(() => undefined);
  const hint = response.status >= 300 && response.status < 400
    ? 'Use the final endpoint URL. Redirects are not followed.'
    : ({
      400: 'Check the selected protocol, model ID, and request options.',
      401: 'Check the API key and authentication header.',
      403: 'Check that this credential can access the model.',
      404: 'Check the endpoint URL and model ID.',
      429: 'Check the provider rate limit or quota.',
    } as Record<number, string>)[response.status];
  throw new Error(`The endpoint returned HTTP ${response.status}.${hint ? ` ${hint}` : ''}`);
}
