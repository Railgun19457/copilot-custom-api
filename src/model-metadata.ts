import { CatalogModel } from './catalog';
import { array, effortList, isObject, object, parseUrl, string } from './config';
import { readEvents, sendRequest } from './http';

export type ModelDefaults = Pick<CatalogModel, 'name' | 'maxInputTokens' | 'maxOutputTokens'> & {
  toolCalling?: boolean;
  vision?: boolean;
  reasoningEfforts?: string[];
  metadataSource: string;
};

type Entry = { provider: string; origin?: string; id: string; canonical: string; model: Record<string, unknown> };
type Index = Map<string, Entry[]>;
const catalogUrl = new URL('https://models.dev/api.json');
const knownOrigins: Readonly<Record<string, string>> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
};
let cached: { expires: number; index: Index } | undefined;
let loading: Promise<Index> | undefined;

function normalizedId(value: string): string {
  return value.trim().toLowerCase().replace(/^models\//, '');
}

function safeOrigin(value: string): string | undefined {
  try {
    return parseUrl(value).origin;
  } catch {
    return undefined;
  }
}

export function indexMetadata(value: unknown): Index {
  const index: Index = new Map();
  for (const [providerId, raw] of Object.entries(object(value))) {
    const provider = object(raw);
    const origin = safeOrigin(string(provider.api)) ?? (Object.hasOwn(knownOrigins, providerId) ? knownOrigins[providerId] : undefined);
    for (const [id, model] of Object.entries(object(provider.models))) {
      if (!isObject(model)) {
        continue;
      }
      const canonical = normalizedId(string(model.canonical_model_id));
      const key = normalizedId(id);
      const entry = { provider: string(provider.name) || providerId, origin, id: key, canonical, model };
      for (const alias of new Set([key, key.split('/').at(-1), canonical, canonical.split('/').at(-1)])) {
        if (alias) {
          const matches = index.get(alias) ?? [];
          matches.push(entry);
          index.set(alias, matches);
        }
      }
    }
  }
  return index;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function resolveDefaults(index: Index, id: string, endpoint: string): ModelDefaults | undefined {
  const key = normalizedId(id);
  const origin = safeOrigin(endpoint);
  const candidates = index.get(key) ?? [];
  const sameOrigin = candidates.filter(entry => origin && entry.origin === origin);
  const exact = candidates.filter(entry => entry.id === key || entry.canonical === key);
  const matches = sameOrigin.length ? sameOrigin : exact.length ? exact : candidates;
  const canonicalFamilies = new Set(matches.map(entry => entry.canonical
    ? entry.canonical.split('/').slice(0, -1).join('/') : entry.id.split('/').slice(0, -1).join('/')).filter(Boolean));
  if (!matches.length || (!sameOrigin.length && !exact.length && canonicalFamilies.size > 1)) {
    return undefined;
  }
  // Prefer the exact ID on the serving provider. Otherwise choose the most common
  // capability/effort signature for this model across providers.
  const choices = new Map<string, { count: number; defaults: ModelDefaults }>();
  for (const entry of matches) {
    const m = entry.model;
    const limit = object(m.limit);
    const context = positive(limit.context);
    const output = positive(limit.output);
    const input = positive(limit.input) ?? (context && output ? positive(context - output) : context);
    const modalities = object(m.modalities).input;
    const efforts = effortList(array(m.reasoning_options).flatMap(option => {
      const row = object(option);
      return row.type === 'effort' ? array(row.values) : [];
    }));
    const vision = Array.isArray(modalities) ? modalities.includes('image') : undefined;
    const toolCalling = typeof m.tool_call === 'boolean' ? m.tool_call : undefined;
    const defaults: ModelDefaults = {
      name: string(m.name) || id,
      maxInputTokens: input,
      maxOutputTokens: output,
      toolCalling,
      vision,
      reasoningEfforts: efforts.length ? efforts : undefined,
      metadataSource: `models.dev · ${entry.provider}`,
    };
    if (sameOrigin.length && entry.id === key) {
      return defaults;
    }
    const signature = JSON.stringify([vision, toolCalling, [...efforts].sort()]);
    const current = choices.get(signature);
    if (!current) {
      choices.set(signature, { count: 1, defaults });
    } else {
      current.count++;
      if ((output ?? Infinity) < (current.defaults.maxOutputTokens ?? Infinity)) {
        current.defaults = defaults;
      }
    }
  }
  return [...choices.values()].sort((left, right) => right.count - left.count)[0]?.defaults;
}

export async function loadMetadata(): Promise<Index> {
  if (cached && cached.expires > Date.now()) {
    return cached.index;
  }
  if (loading) {
    return loading;
  }
  loading = (async () => {
    const response = await sendRequest(catalogUrl, { signal: AbortSignal.timeout(10_000) });
    for await (const event of readEvents(response, false)) {
      const index = indexMetadata(event.data);
      if (index.size) {
        cached = { expires: Date.now() + 60 * 60_000, index };
        return index;
      }
    }
    throw new Error('models.dev returned no model metadata.');
  })();
  try {
    return await loading;
  } catch (error) {
    if (cached) {
      return cached.index;
    }
    throw error;
  } finally {
    loading = undefined;
  }
}
