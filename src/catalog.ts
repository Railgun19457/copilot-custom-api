import { array, Connection, endpoint, object, parseUrl, requestHeaders, string } from './config';
import { readEvents, sendRequest } from './http';

export interface CatalogModel {
  id: string;
  name: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  vision?: boolean;
  reasoningEfforts?: string[];
  metadataSource?: string;
}

export function catalogUrl(connection: Connection): URL {
  const url = endpoint(connection, { id: 'model', streaming: false });
  const path = url.pathname.replace(/\/+$/, '');
  const modelsPath = path.replace(/\/(?:chat\/completions|responses|messages|interactions|models\/[^/]+:generateContent)$/, '/models');
  if (modelsPath === path) {
    throw new Error('Enter a Models URL for this custom route.');
  }
  url.pathname = modelsPath;
  return url;
}

export async function fetchCatalog(connection: Connection, apiKey?: string, override?: string): Promise<CatalogModel[]> {
  const url = override ? parseUrl(override) : catalogUrl(connection);
  if (url.origin !== parseUrl(connection.url).origin) {
    throw new Error('The Models URL must use the same origin as the API endpoint.');
  }
  const headers = requestHeaders(connection, apiKey);
  headers.set('Accept', 'application/json');
  const models = new Map<string, CatalogModel>();
  const signal = AbortSignal.timeout(20_000);
  for (let page = 0; page < 20; page++) {
    const response = await sendRequest(url, { headers, signal });
    let data;
    for await (const event of readEvents(response, false)) {
      data = event.data;
    }
    if (!data || (!Array.isArray(data.data) && !Array.isArray(data.models))) {
      throw new Error('The Models endpoint did not return a model list.');
    }
    const googleFormat = !Array.isArray(data.data);
    for (const value of array(googleFormat ? data.models : data.data)) {
      const item = object(value);
      const rawId = string(item.id || item.name).trim();
      const id = googleFormat ? rawId.replace(/^models\//, '') : rawId;
      if (!id) {
        continue;
      }
      models.set(id, {
        id,
        name: string(item.displayName || item.display_name).trim() || id,
        maxInputTokens: positiveInteger(item.inputTokenLimit ?? item.max_input_tokens),
        maxOutputTokens: positiveInteger(item.outputTokenLimit ?? item.max_output_tokens),
      });
    }
    const token = string(data.nextPageToken);
    const after = data.has_more === true ? string(data.last_id) : '';
    if (!token && !after) {
      return [...models.values()];
    }
    url.searchParams.set(token ? 'pageToken' : 'after_id', token || after);
  }
  throw new Error('The model list exceeded 20 pages. Use a filtered Models URL or add models manually.');
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
