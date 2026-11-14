import {
  array, configuredConnections, Connection, effortList, endpoint, isObject, modelConnection, object,
  protocols, requestHeaders, string, validateHeader, validPriority,
} from './config';

function readHeaders(value: unknown): Record<string, string> {
  const names = new Set<string>();
  return Object.fromEntries(array(value).map(item => {
    const row = object(item);
    const name = string(row.name).trim();
    const lower = name.toLowerCase();
    if (!name || names.has(lower)) {
      throw new Error('Enter a unique name for each HTTP header.');
    }
    names.add(lower);
    const headerValue = string(row.value);
    validateHeader(name, headerValue);
    return [name, headerValue];
  }));
}

export function readProviderDraft(value: unknown, connectionOnly = false, previous?: Connection): Connection {
  const draft = object(value);
  const headers = readHeaders(draft.headers);
  const modelIds = new Set<string>();
  const models = (connectionOnly ? [] : array(draft.models)).map(item => {
    const row = object(item);
    const id = string(row.id).trim();
    if (!id || modelIds.has(id)) {
      throw new Error('Enter a unique API model ID for each model.');
    }
    modelIds.add(id);
    const maxInputTokens = Number(row.maxInputTokens);
    const maxOutputTokens = Number(row.maxOutputTokens);
    if (![maxInputTokens, maxOutputTokens].every(limit => Number.isSafeInteger(limit) && limit > 0)) {
      throw new Error(`Enter positive whole-number token limits for “${id}”.`);
    }
    let options: unknown;
    try {
      options = JSON.parse(string(row.options).trim() || '{}');
    } catch {
      throw new Error(`Request options for “${id}” must be valid JSON.`);
    }
    if (!isObject(options)) {
      throw new Error(`Request options for “${id}” must be a JSON object.`);
    }
    const effortInput = array(row.reasoningEfforts);
    if (effortInput.some(effort => typeof effort !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(effort))) {
      throw new Error('Reasoning efforts may contain only letters, digits, underscores, and hyphens.');
    }
    const reasoningEfforts = effortList(effortInput);
    const reasoningEffort = string(row.reasoningEffort).trim();
    if (reasoningEffort && !reasoningEfforts.includes(reasoningEffort)) {
      throw new Error('The default reasoning effort must be in the supported list.');
    }
    if (row.protocol && !Object.hasOwn(protocols, string(row.protocol))) {
      throw new Error('Select an API protocol.');
    }
    const priority = row.priority === undefined || row.priority === '' ? 0 : Number(row.priority);
    if (!validPriority(priority)) {
      throw new Error('Enter a non-negative whole number for the channel priority.');
    }
    const existing = previous?.models.find(model => model.id === row.originalId);
    return {
      ...row, id, maxInputTokens, maxOutputTokens, options, reasoningEfforts, priority, headers: readHeaders(row.headers),
      url: row.useProviderUrl === true ? undefined : existing?.url,
      fullUrl: existing?.fullUrl,
    };
  });
  const name = string(draft.name).trim() || (connectionOnly ? 'Discovery' : '');
  if (!name) {
    throw new Error('Enter a provider name.');
  }
  if (!Object.hasOwn(protocols, string(draft.protocol))) {
    throw new Error('Select an API protocol.');
  }
  const authHeader = string(draft.authHeader).trim();
  if (draft.auth === 'custom' && (!authHeader || Object.keys(headers).some(name => name.toLowerCase() === authHeader.toLowerCase()))) {
    throw new Error('Enter an API key header that is separate from the extra HTTP headers.');
  }
  const connection = configuredConnections({
    draft: { ...draft, name, url: string(draft.url).trim(), authHeader, models, headers },
  }).draft;
  if (!connection) {
    throw new Error('Check the HTTP(S) endpoint URL and authentication settings.');
  }
  validateHeader('X-Session-Id', connection.sessionId ?? '');
  requestHeaders(connection, 'validation');
  for (const model of connection.models) {
    const request = modelConnection(connection, model);
    if (connection.auth === 'custom' && Object.hasOwn(request.headers, authHeader.toLowerCase())) {
      throw new Error('Enter an API key header that is separate from the extra HTTP headers.');
    }
    requestHeaders(request, 'validation');
    endpoint(request, model);
  }
  return connection;
}
