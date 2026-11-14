/* global acquireVsCodeApi */
'use strict';

const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const editor = $('editor');
const fields = editor.elements;
const catalog = $('catalog');
const confirmation = $('confirm');
let entries = [];
let protocols = {};
let current;
let dirty = false;
let busy = false;
let ready = false;
let operation = '';
let discovered = [];
let activeTab = 'connection';
let dictionary = {};
let chinese = {};
const textSources = new WeakMap();
const attributeSources = new WeakMap();
const notices = new Map();
const checked = new Set();
const metadataRequests = new Map();
let metadataSequence = 0;
let providerKeyOrigin;
let page = 'provider';
let usageData;
let vendor = '';
let utilityBaseline;
let routingBaseline;
const utilityFields = [$('utility-model'), $('utility-small-model')];
const commonEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const effortPattern = /^[a-zA-Z0-9_-]+$/;
const dynamicContent = [
  '#provider-list', '#status', '#provider-title', '#provider-meta', '#provider-origin', '#key-status',
  '#catalog-results', '#catalog-count', '#catalog-status', '#confirm-title', '#confirm-body', '#confirm-action',
  '#add-selected', '#protocol', '#utility-model', '#utility-small-model', '#utility-status', '#routing-status',
  '#usage-provider', '#usage-model', '#usage-status', '#usage-chart', '#usage-chart-detail', '#usage-breakdown',
  '[data-title]', '[data-subtitle]', '[data-capabilities]', '[data-metadata-status]', '[data-field="reasoningEffort"]',
].join(', ');

function t(text, ...values) {
  const translation = Object.hasOwn(dictionary, text) ? dictionary[text] : text;
  return translation.replace(/\{(\d+)\}/g, (match, index) => values[index] ?? match);
}

function translateStatic(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest(dynamicContent)) {
      continue;
    }
    const source = textSources.get(node) ?? node.data;
    const key = source.trim().replace(/^＋\s*/, '');
    if (Object.hasOwn(chinese, key)) {
      textSources.set(node, source);
      node.data = source.replace(key, () => t(key));
    }
  }
  for (const element of root.querySelectorAll('[aria-label], [placeholder]')) {
    const sources = attributeSources.get(element) ?? {};
    for (const attribute of ['aria-label', 'placeholder']) {
      const source = sources[attribute] ?? element.getAttribute(attribute);
      if (source && Object.hasOwn(chinese, source)) {
        sources[attribute] = source;
        element.setAttribute(attribute, t(source));
      }
    }
    attributeSources.set(element, sources);
  }
}

function translateMessage(message) {
  if (Object.hasOwn(dictionary, message)) {
    return dictionary[message];
  }
  for (const [pattern, key] of [
    [/^“(.+)” responded successfully\.$/, '“{0}” responded successfully.'],
    [/^Enter positive whole-number token limits for “(.+)”\.$/, 'Enter positive whole-number token limits for “{0}”.'],
    [/^Request options for “(.+)” must be valid JSON\.$/, 'Request options for “{0}” must be valid JSON.'],
    [/^Request options for “(.+)” must be a JSON object\.$/, 'Request options for “{0}” must be a JSON object.'],
    [/^Could not connect to the configured endpoint \(([^)]+)\)\.$/, 'Could not connect to the configured endpoint ({0}).'],
  ]) {
    const match = pattern.exec(message);
    if (match) {
      return t(key, match[1]);
    }
  }
  const http = /^The endpoint returned HTTP (\d+)\.(?: (.+))?$/.exec(message);
  return http ? [t('The endpoint returned HTTP {0}.', http[1]), t(http[2] ?? '')].filter(Boolean).join(' ') : message;
}

function notice(message = '', kind = '', target = $('status')) {
  notices.set(target, message);
  target.textContent = translateMessage(message);
  target.className = `notice ${kind}`;
  target.hidden = !message;
}

async function confirmAction(title, message, label) {
  if (confirmation.open) {
    return false;
  }
  $('confirm-title').textContent = t(title);
  $('confirm-body').textContent = message;
  $('confirm-action').textContent = t(label);
  confirmation.returnValue = '';
  confirmation.showModal();
  return new Promise(resolve => confirmation.addEventListener('close', () => {
    resolve(confirmation.returnValue === 'confirm');
  }, { once: true }));
}

function renderNavigation() {
  $('provider-count').textContent = String(entries.length);
  $('provider-list').replaceChildren(...entries.map(entry => {
    const button = document.createElement('button');
    button.type = 'button';
    button.disabled = busy;
    if (page === 'provider' && entry.id === current?.id) {
      button.setAttribute('aria-current', 'true');
    }
    const name = document.createElement('span');
    name.className = 'provider-name';
    name.textContent = entry.config.name;
    button.title = entry.config.name;
    const count = document.createElement('span');
    count.className = 'provider-models';
    count.textContent = String(entry.config.models.length);
    count.title = t('{0} models', entry.config.models.length);
    const protocol = document.createElement('span');
    protocol.className = 'provider-protocol';
    protocol.textContent = protocols[entry.config.protocol] ?? entry.config.protocol;
    button.append(name, count, protocol);
    button.addEventListener('click', () => void select(entry.id));
    return button;
  }));
}

function syncControls() {
  const external = current?.id && !entries.some(entry =>
    entry.id === current.id && JSON.stringify(entry.config) === current.baseline);
  $('external-change').hidden = !external;
  $('new-provider').disabled = !ready || busy;
  $('open-model-settings').disabled = !ready || busy;
  $('open-model-settings').setAttribute('aria-current', String(page === 'settings'));
  $('open-usage').disabled = !ready || busy;
  $('open-usage').setAttribute('aria-current', String(page === 'usage'));
  $('utility-fields').disabled = busy;
  $('routing-fields').disabled = busy;
  $('save-utility').disabled = busy || utilityBaseline === JSON.stringify(utilityValues());
  $('save-routing').disabled = busy || routingBaseline === routingValues();
  $('fields').disabled = busy;
  $('save').disabled = busy || !dirty || Boolean(external);
  $('revert').hidden = !dirty && !external;
  $('revert').disabled = busy;
  $('remove-provider').hidden = !current?.id;
  $('remove-provider').disabled = Boolean(external);
  $('discover').disabled = Boolean(external);
  $('custom-auth').hidden = fields.auth.value !== 'custom';
  $('credentials').hidden = fields.auth.value === 'none';
  const savedKey = Boolean(current?.hasKey);
  const changedOrigin = origin(fields.url.value) !== origin(current?.config?.url);
  const usableKey = savedKey && !changedOrigin;
  $('clear-key').hidden = !savedKey;
  $('clear-key').disabled = dirty || Boolean(external);
  $('key-status').textContent = t(usableKey ? 'Key saved. Enter a new key to replace it.'
    : savedKey ? 'Changing the endpoint origin requires a new API key.' : 'Enter a key if this endpoint requires one.');
  for (const row of $('models').children) {
    const routeOrigin = origin(modelMetadataUrl(row));
    const externalEndpoint = Boolean(routeOrigin && routeOrigin !== origin(fields.url.value));
    const hasRouteKey = externalEndpoint ? current?.keyedOrigins?.includes(routeOrigin) : usableKey;
    const button = row.querySelector('[data-test]');
    button.disabled = dirty || Boolean(external) || !current?.id || (!hasRouteKey && fields.auth.value !== 'none');
    button.title = t(dirty ? 'Save your changes before testing.' : 'Send a short test message.');
  }
  for (const item of $('provider-list').children) {
    item.disabled = busy;
  }
  $('header-count').textContent = String($('headers').children.length);
  $('model-count').textContent = String($('models').children.length);
  $('empty-models').hidden = $('models').children.length > 0;
}

function origin(value) {
  try {
    return new URL(value?.trim().replaceAll('{model}', 'model')).origin;
  } catch {
    return undefined;
  }
}

function updateTitle() {
  $('provider-title').textContent = fields.name.value.trim() || t('New provider');
  $('provider-meta').textContent = current?.id ? protocols[fields.protocol.value] ?? '' : t('Connection');
  const endpointOrigin = origin(fields.url.value);
  $('provider-origin').textContent = endpointOrigin ?? (current?.id ? '' : t('Enter the connection details and add models.'));
}

function showTab(name, focus = false) {
  activeTab = name;
  for (const tab of ['connection', 'models']) {
    const selected = name === tab;
    const button = $(`${tab}-tab`);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    $(`${tab}-panel`).hidden = !selected;
    if (focus && selected) {
      button.focus();
    }
  }
}

function changed() {
  dirty = true;
  updateTitle();
  syncControls();
}

function makeHeader(name = '', value = '', focus = false, list = $('headers'), add = $('add-header')) {
  const row = $('header-template').content.firstElementChild.cloneNode(true);
  translateStatic(row);
  const nameField = row.querySelector('[data-field="name"]');
  nameField.value = name;
  row.querySelector('[data-field="value"]').value = value;
  row.querySelector('[data-remove]').addEventListener('click', () => {
    row.remove();
    changed();
    add.focus();
  });
  list.append(row);
  if (focus) {
    nameField.focus();
  }
}

function modelValues(row) {
  const values = Object.fromEntries([...row.querySelectorAll('[data-field]')].filter(input => !input.closest('.header-row')).map(input => [
    input.dataset.field, input.type === 'checkbox' ? input.checked : input.value,
  ]));
  return { ...values, reasoningEfforts: selectedEfforts(row) };
}

function selectedEfforts(row) {
  return [...row.querySelectorAll('[data-effort-list] input:checked')].map(input => input.value);
}

function updateDefaultEffort(row, current = row.querySelector('[data-field="reasoningEffort"]').value) {
  const field = row.querySelector('[data-field="reasoningEffort"]');
  const efforts = selectedEfforts(row);
  field.replaceChildren(new Option(t('API default'), ''), ...efforts.map(effort => new Option(effort, effort)));
  field.value = efforts.includes(current) ? current : '';
  field.disabled = !efforts.length;
}

function makeEffortOption(value, checked) {
  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.value = value;
  checkbox.checked = checked;
  label.append(checkbox, value);
  return label;
}

function setEfforts(row, efforts, defaultEffort) {
  const list = row.querySelector('[data-effort-list]');
  const available = new Set([...efforts, ...[...list.querySelectorAll('input')].map(input => input.value), ...commonEfforts]);
  list.replaceChildren(...[...available].map(effort => makeEffortOption(effort, efforts.includes(effort))));
  updateDefaultEffort(row, defaultEffort);
}

function setupEfforts(row, model) {
  const list = row.querySelector('[data-effort-list]');
  const custom = row.querySelector('[data-custom-effort]');
  const add = row.querySelector('[data-add-effort]');
  const efforts = [...new Set([...(model.reasoningEfforts ?? []), model.reasoningEffort].filter(Boolean))];
  setEfforts(row, efforts, model.reasoningEffort);
  add.disabled = true;
  list.addEventListener('input', () => updateDefaultEffort(row));
  custom.addEventListener('input', event => {
    event.stopPropagation();
    add.disabled = !effortPattern.test(custom.value.trim());
  });
  const addEffort = () => {
    if (add.disabled) {
      return;
    }
    const effort = custom.value.trim();
    let checkbox = [...list.querySelectorAll('input')].find(input => input.value === effort);
    if (!checkbox) {
      const option = makeEffortOption(effort, false);
      list.append(option);
      checkbox = option.firstElementChild;
    }
    if (!checkbox.checked) {
      checkbox.click();
    }
    checkbox.focus();
    custom.value = '';
    add.disabled = true;
  };
  add.addEventListener('click', addEffort);
  custom.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      addEffort();
    }
  });
}

function headerValues(list) {
  return [...list.children].map(row => ({
    name: row.querySelector('[data-field="name"]').value,
    value: row.querySelector('[data-field="value"]').value,
  }));
}

function requestMetadata(row, manual) {
  const id = row.querySelector('[data-field="id"]').value.trim();
  const status = row.querySelector('[data-metadata-status]');
  if (!id) {
    if (manual) {
      notice('Enter a model ID before looking up defaults.', 'error', status);
    }
    return;
  }
  for (const [requestId, request] of metadataRequests) {
    if (request.row === row) {
      metadataRequests.delete(requestId);
    }
  }
  const requestId = ++metadataSequence;
  const url = modelMetadataUrl(row);
  metadataRequests.set(requestId, { row, id, url, manual, snapshot: modelValues(row) });
  notice('Looking up models.dev…', '', status);
  vscode.postMessage({ type: 'metadata', requestId, model: id, url });
}

function modelMetadataUrl(row) {
  return (!row.querySelector('[data-field="useProviderUrl"]').checked && row.dataset.savedUrl) || fields.url.value;
}

function applyMetadata(data) {
  const request = metadataRequests.get(data.requestId);
  metadataRequests.delete(data.requestId);
  if (!request || !request.row.isConnected) {
    return;
  }
  const { row, id, manual, snapshot } = request;
  const status = row.querySelector('[data-metadata-status]');
  const values = modelValues(row);
  const url = modelMetadataUrl(row);
  if (values.id.trim() !== id || url !== request.url) {
    notice('', '', status);
    return;
  }
  if (!data.defaults) {
    notice(data.unavailable ? 'models.dev is unavailable.' : 'No matching model was found in models.dev.', '', status);
    return;
  }
  let applied = false;
  for (const key of ['name', 'maxInputTokens', 'maxOutputTokens', 'toolCalling', 'vision']) {
    const value = data.defaults[key];
    if (value === undefined || values[key] !== snapshot[key] || (!manual && values[key] && values[key] !== id)) {
      continue;
    }
    const field = row.querySelector(`[data-field="${key}"]`);
    if (field.type === 'checkbox') {
      field.checked = value;
    } else {
      field.value = value;
    }
    applied = true;
  }
  const efforts = data.defaults.reasoningEfforts;
  if (efforts && (manual || !values.reasoningEfforts.length) &&
    JSON.stringify(values.reasoningEfforts) === JSON.stringify(snapshot.reasoningEfforts) &&
    values.reasoningEffort === snapshot.reasoningEffort) {
    setEfforts(row, efforts, values.reasoningEffort);
    applied = true;
  }
  if (applied) {
    updateModelSummary(row);
    changed();
  }
  notice(applied ? data.defaults.metadataSource : 'Existing model values were kept.', '', status);
}

function makeModel(model = {}, expand = false) {
  const row = $('model-template').content.firstElementChild.cloneNode(true);
  translateStatic(row);
  const values = {
    ...model,
    streaming: model.streaming ?? true,
    options: JSON.stringify(model.options ?? {}, null, 2),
  };
  const protocol = row.querySelector('[data-field="protocol"]');
  protocol.append(...Object.entries(protocols).map(([value, name]) => new Option(name, value)));
  for (const input of row.querySelectorAll('[data-field]')) {
    const value = values[input.dataset.field];
    if (input.type === 'checkbox') {
      input.checked = Boolean(value);
    } else {
      input.value = value ?? '';
    }
  }
  setupEfforts(row, model);
  updateModelSummary(row);
  row.addEventListener('input', () => updateModelSummary(row));
  row.dataset.originalId = model.id ?? '';
  row.dataset.savedUrl = model.url ?? '';
  row.querySelector('[data-existing-endpoint]').hidden = !model.url;
  const modelHeaders = row.querySelector('[data-model-headers]');
  const addModelHeader = row.querySelector('[data-add-model-header]');
  Object.entries(model.headers ?? {}).forEach(([name, value]) => makeHeader(name, value, false, modelHeaders, addModelHeader));
  addModelHeader.addEventListener('click', () => {
    makeHeader('', '', true, modelHeaders, addModelHeader);
    changed();
  });
  row.querySelector('[data-defaults]').addEventListener('click', () => requestMetadata(row, true));
  if (!model.id) {
    row.querySelector('[data-field="id"]').addEventListener('change', () => requestMetadata(row, false));
  }
  if (model.metadataSource) {
    notice(model.metadataSource, '', row.querySelector('[data-metadata-status]'));
  }
  row.querySelector('[data-test]').addEventListener('click', () => request('test', { model: modelValues(row).id }));
  row.querySelector('[data-remove]').addEventListener('click', () => {
    notices.delete(row.querySelector('[data-metadata-status]'));
    row.remove();
    changed();
    $('add-model').focus();
  });
  $('models').append(row);
  row.open = expand;
  if (expand) {
    row.querySelector('[data-field="id"]').focus();
  }
}

function updateModelSummary(row) {
  const data = modelValues(row);
  row.querySelector('[data-title]').textContent = data.name.trim() || data.id.trim() || t('New model');
  row.querySelector('[data-subtitle]').textContent = data.name && data.name !== data.id ? data.id : '';
  row.querySelector('[data-capabilities]').textContent = [
    data.streaming && t('Streaming'), data.toolCalling && t('Tools'), data.vision && t('Vision'),
  ].filter(Boolean).join(' · ');
}

function load(entry, keepNotice = false) {
  current = entry && { ...entry, baseline: entry.id ? JSON.stringify(entry.config) : '' };
  dirty = Boolean(entry && !entry.id);
  syncPage();
  if (!keepNotice) {
    notice();
  }
  renderNavigation();
  editor.reset();
  providerKeyOrigin = origin(entry?.config?.url);
  $('headers').replaceChildren();
  for (const row of $('models').children) {
    notices.delete(row.querySelector('[data-metadata-status]'));
  }
  metadataRequests.clear();
  $('models').replaceChildren();
  $('headers-details').open = false;
  if (entry) {
    const config = entry.config ?? {};
    fields.name.value = config.name ?? '';
    fields.url.value = config.url ?? '';
    fields.protocol.value = config.protocol ?? 'chat-completions';
    fields.urlMode.value = config.fullUrl ? 'exact' : 'base';
    fields.auth.value = config.auth ?? 'default';
    fields.authHeader.value = config.authHeader ?? '';
    fields.headerPreset.value = config.headerPreset ?? 'copilot';
    fields.sessionId.value = config.sessionId ?? '';
    Object.entries(config.headers ?? {}).forEach(([name, value]) => makeHeader(name, value));
    (config.models ?? []).forEach(model => makeModel(model));
    updateTitle();
  }
  syncControls();
}

async function select(id) {
  if (busy || (page === 'provider' && id && id === current?.id)) {
    return;
  }
  if (dirty && !await confirmAction('Discard changes?', t('Your changes to this provider have not been saved.'), 'Discard')) {
    return;
  }
  const entry = id ? entries.find(item => item.id === id) : { id: '', config: {} };
  if (entry) {
    if (page === 'usage') {
      vscode.postMessage({ type: 'closeUsage' });
    }
    page = 'provider';
    showTab('connection');
    load(entry);
    fields.name.focus();
  }
}

function draft() {
  return {
    name: fields.name.value,
    url: fields.url.value,
    protocol: fields.protocol.value,
    fullUrl: fields.urlMode.value === 'exact',
    auth: fields.auth.value,
    authHeader: fields.authHeader.value,
    headerPreset: fields.headerPreset.value,
    sessionId: fields.sessionId.value,
    headers: headerValues($('headers')),
    models: [...$('models').children].map(row => {
      const values = modelValues(row);
      return { ...values, originalId: row.dataset.originalId, headers: headerValues(row.querySelector('[data-model-headers]')) };
    }),
  };
}

function request(type, extra = {}) {
  if (busy || !current) {
    return;
  }
  const connection = type === 'discover' || type === 'save' ? { draft: draft(), apiKey: fields.apiKey.value } : {};
  operation = type;
  busy = true;
  syncControls();
  if (type === 'discover') {
    $('retry-catalog').disabled = true;
    $('add-selected').disabled = true;
    notice('Fetching models…', '', $('catalog-status'));
  } else {
    notice(type === 'test' ? 'Sending a test message…' : 'Saving changes…');
  }
  vscode.postMessage({ type, id: current.id, baseline: current.baseline, ...connection, ...extra });
}

function utilityValues() {
  return utilityFields.map(field => field.value);
}

function routingValues() {
  return $('routing-enabled').checked;
}

function receiveModelSettings(data) {
  const previousUtility = utilityValues();
  const latestUtility = JSON.stringify(data.utility);
  const keepUtility = utilityBaseline === latestUtility && utilityBaseline !== JSON.stringify(previousUtility);
  const values = keepUtility ? previousUtility : data.utility;
  for (const [index, field] of utilityFields.entries()) {
    const value = values[index] ?? '';
    const groups = new Map();
    field.replaceChildren(new Option(t('VS Code default'), ''));
    for (const option of data.utilityOptions) {
      const label = option.sources ? t('{0} ({1} channels)', option.name, option.sources) : option.name;
      const item = new Option(label, `${vendor}/${option.id}`);
      item.title = option.modelId;
      if (!option.provider) {
        field.add(item);
        continue;
      }
      if (!groups.has(option.provider)) {
        const group = document.createElement('optgroup');
        group.label = option.provider;
        groups.set(option.provider, group);
        field.append(group);
      }
      groups.get(option.provider).append(item);
    }
    if (value && !Array.from(field.options).some(option => option.value === value)) {
      field.add(new Option(t('Current setting: {0}', value), value));
    }
    field.value = value;
  }
  if (routingBaseline !== data.routingEnabled) {
    $('routing-enabled').checked = data.routingEnabled;
  }
  utilityBaseline = latestUtility;
  routingBaseline = data.routingEnabled;
}

function syncPage() {
  editor.hidden = page !== 'provider' || !current;
  $('empty').hidden = page !== 'provider' || Boolean(current);
  $('model-settings').hidden = page !== 'settings';
  $('usage-page').hidden = page !== 'usage';
}

async function openPage(destination) {
  if (busy || page === destination || (dirty &&
      !await confirmAction('Discard changes?', t('Your changes to this provider have not been saved.'), 'Discard'))) {
    return;
  }
  if (page === 'usage') {
    vscode.postMessage({ type: 'closeUsage' });
  }
  page = destination;
  if (dirty) {
    load(entries.find(entry => entry.id === current?.id) ?? entries[0]);
  } else {
    syncPage();
    renderNavigation();
    syncControls();
  }
  if (page === 'usage') {
    readUsage();
  }
}

function saveModelSettings(type, baseline, values, status) {
  if (busy) {
    return;
  }
  operation = type;
  busy = true;
  notice('Saving changes…', '', status);
  syncControls();
  vscode.postMessage({ type, baseline, values });
}

function readUsage() {
  const period = Number($('usage-period').value);
  if (!usageData || usageData.period !== period || usageData.error) {
    usageData = undefined;
    renderUsage();
  }
  vscode.postMessage({ type: 'readUsage', period });
}

function usageOptions(field, rows, id, label, all) {
  const previous = field.value;
  const choices = new Map(rows.map(row => [row[id], row[label]]));
  field.replaceChildren(new Option(t(all), ''), ...[...choices]
    .sort((a, b) => a[1].localeCompare(b[1], document.documentElement.lang))
    .map(([value, name]) => new Option(name, value)));
  field.value = choices.has(previous) ? previous : '';
}

function addUsage(target, row) {
  for (const field of ['requests', 'failed', 'legacyRequests', 'firstTextMs', 'firstTextSamples',
    'nonStreamMs', 'nonStreamSamples', 'tpsTokens', 'tpsMs',
    'reported', 'input', 'output', 'total', 'cached', 'cacheInput', 'reasoning', 'cachedReported', 'reasoningReported']) {
    target[field] = (target[field] ?? 0) + row[field];
  }
}

function renderUsage() {
  const provider = $('usage-provider');
  const model = $('usage-model');
  const available = usageData?.rows ?? [];
  if (usageData && !usageData.error) {
    usageOptions(provider, available, 'providerId', 'provider', 'All providers');
    usageOptions(model, available.filter(row => !provider.value || row.providerId === provider.value), 'modelId', 'model', 'All models');
  }
  provider.disabled = model.disabled = !available.length;
  notice(!usageData ? 'Loading usage…' : usageData.error ? 'Could not load usage statistics.'
    : usageData.writeFailed ? 'Some usage records could not be saved.' : '',
    usageData?.error || usageData?.writeFailed ? 'error' : '', $('usage-status'));
  const rows = available.filter(row => (!provider.value || row.providerId === provider.value) &&
    (!model.value || row.modelId === model.value));
  $('usage-empty').hidden = !usageData || usageData.error || Boolean(rows.length);
  $('usage-results').hidden = !rows.length;
  if (!rows.length) {
    return;
  }
  const totals = {};
  const grouped = new Map();
  const daily = new Map(usageData.days.map(day => [day, { day, input: 0, output: 0, requests: 0, reported: 0 }]));
  for (const row of rows) {
    addUsage(totals, row);
    const day = daily.get(row.day);
    day.input += row.input;
    day.output += row.output;
    day.requests += row.requests;
    day.reported += row.reported;
    const key = JSON.stringify([row.providerId, row.modelId]);
    const group = grouped.get(key) ?? { modelId: row.modelId };
    group.provider = row.provider;
    group.model = row.model;
    addUsage(group, row);
    grouped.set(key, group);
  }
  const language = document.documentElement.lang;
  const format = new Intl.NumberFormat(language);
  const decimal = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 2 });
  const seconds = new Intl.NumberFormat(language, { style: 'unit', unit: 'second', maximumFractionDigits: 3 });
  const values = row => {
    const measured = row.requests - row.legacyRequests;
    return {
      provider: row.provider,
      model: row.model,
      requests: format.format(row.requests),
      failed: measured ? format.format(row.failed) : '—',
      'success-rate': measured ? percent.format((measured - row.failed) / measured) : '—',
      'cache-rate': row.cacheInput ? percent.format(row.cached / row.cacheInput) : '—',
      'first-text': row.firstTextSamples ? seconds.format(row.firstTextMs / row.firstTextSamples / 1000) : '—',
      'non-stream': row.nonStreamSamples ? seconds.format(row.nonStreamMs / row.nonStreamSamples / 1000) : '—',
      tps: row.tpsMs ? decimal.format(row.tpsTokens * 1000 / row.tpsMs) : '—',
      input: row.reported ? format.format(row.input) : '—',
      output: row.reported ? format.format(row.output) : '—',
      total: row.reported ? format.format(row.total) : '—',
      cached: row.cachedReported ? format.format(row.cached) : '—',
      reasoning: row.reasoningReported ? format.format(row.reasoning) : '—',
    };
  };
  const summary = values(totals);
  for (const name of ['total', 'input', 'output', 'cache-rate', 'requests', 'failed', 'success-rate', 'first-text', 'non-stream']) {
    $(`usage-${name}`).textContent = summary[name];
  }
  $('usage-succeeded').textContent = t('{0} successful', format.format(totals.requests - totals.failed));
  $('usage-breakdown').replaceChildren(...[...grouped.values()].sort((a, b) => b.requests - a.requests || b.total - a.total)
    .map(row => {
      const tr = document.createElement('tr');
      const display = values(row);
      const notes = {
        model: row.modelId !== row.model ? row.modelId : undefined,
        requests: row.failed ? t('{0} failed', display.failed) : undefined,
        cached: row.cacheInput ? display['cache-rate'] : undefined,
      };
      for (const key of ['provider', 'model', 'requests', 'success-rate', 'first-text', 'non-stream', 'tps', 'input', 'output', 'cached', 'reasoning', 'total']) {
        const cell = tr.insertCell();
        cell.textContent = display[key];
        if (notes[key]) {
          const note = document.createElement('small');
          note.textContent = notes[key];
          cell.append(note);
        }
      }
      return tr;
    }));
  renderUsageChart([...daily.values()], format);
}

function renderUsageChart(days, format) {
  const chart = $('usage-chart');
  const caption = $('usage-chart-detail');
  const previous = chart.querySelector('[tabindex="0"]')?.dataset.day;
  const focused = chart.contains(document.activeElement);
  const date = new Intl.DateTimeFormat(document.documentElement.lang, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const peak = Math.max(1, ...days.map(row => row.input + row.output));
  const interval = Math.ceil(days.length / 7);
  const bars = days.map((row, index) => {
    const label = date.format(new Date(`${row.day}T00:00:00Z`));
    const detail = row.requests && !row.reported ? t('{0} · Token counts unavailable', label)
      : t('{0} · {1} input / {2} output', label, format.format(row.input), format.format(row.output));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'usage-bar';
    button.dataset.day = row.day;
    button.setAttribute('aria-label', detail);
    button.tabIndex = -1;
    const column = document.createElement('span');
    column.className = 'usage-bar-column';
    for (const series of ['output', 'input']) {
      const segment = document.createElement('span');
      segment.className = `usage-bar-${series}`;
      segment.style.height = `${row[series] / peak * 100}%`;
      column.append(segment);
    }
    button.append(column);
    if (index === 0 || index === days.length - 1 ||
        (index % interval === 0 && days.length - 1 - index >= interval)) {
      const tick = document.createElement('span');
      tick.className = 'usage-date';
      tick.textContent = label;
      button.append(tick);
    }
    button.addEventListener('pointerenter', () => { caption.textContent = detail; });
    button.addEventListener('focus', () => {
      chart.querySelector('[tabindex="0"]')?.setAttribute('tabindex', '-1');
      button.tabIndex = 0;
      caption.textContent = detail;
    });
    button.addEventListener('keydown', event => {
      const offset = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
      if (offset) {
        event.preventDefault();
        bars[index + offset]?.focus();
      }
    });
    return button;
  });
  const currentBar = bars.find(bar => bar.dataset.day === previous) ?? bars.at(-1);
  currentBar.tabIndex = 0;
  caption.textContent = currentBar.getAttribute('aria-label');
  chart.replaceChildren(...bars);
  if (focused) {
    currentBar.focus();
  }
}

function renderCatalog() {
  const query = $('catalog-search').value.trim().toLowerCase();
  const existing = new Set([...$('models').children].map(row => modelValues(row).id.trim()));
  const matches = discovered.filter(model => `${model.name} ${model.id}`.toLowerCase().includes(query));
  $('catalog-count').textContent = t('{0} returned', discovered.length);
  $('add-selected').textContent = checked.size ? t('Add selected ({0})', checked.size) : t('Add selected');
  $('add-selected').disabled = busy || !checked.size;
  const rows = matches.map(model => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.disabled = existing.has(model.id);
    input.checked = input.disabled || checked.has(model.id);
    input.addEventListener('change', () => {
      if (input.checked) {
        checked.add(model.id);
      } else {
        checked.delete(model.id);
      }
      $('add-selected').textContent = checked.size ? t('Add selected ({0})', checked.size) : t('Add selected');
      $('add-selected').disabled = busy || !checked.size;
    });
    const text = document.createElement('span');
    text.textContent = model.name;
    if (model.id !== model.name || input.disabled) {
      const id = document.createElement('small');
      id.textContent = input.disabled ? t('{0} · Already added', model.id) : model.id;
      text.append(id);
    }
    label.append(input, text);
    return label;
  });
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.textContent = t(discovered.length ? 'No matching models.' : 'No models loaded.');
    rows.push(empty);
  }
  $('catalog-results').replaceChildren(...rows);
}

fields.url.addEventListener('input', () => {
  const nextOrigin = origin(fields.url.value);
  if (nextOrigin !== providerKeyOrigin) {
    fields.apiKey.value = '';
    providerKeyOrigin = nextOrigin;
  }
});
editor.addEventListener('input', changed);
for (const name of ['connection', 'models']) {
  const button = $(`${name}-tab`);
  button.addEventListener('click', () => showTab(name));
  button.addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      showTab(event.key === 'Home' ? 'connection' : event.key === 'End' ? 'models'
        : activeTab === 'connection' ? 'models' : 'connection', true);
    }
  });
}
$('language').addEventListener('change', () => vscode.postMessage({ type: 'language', value: $('language').value }));
editor.addEventListener('submit', event => {
  event.preventDefault();
  if (!$('save').disabled) {
    request('save');
  }
});
$('new-provider').addEventListener('click', () => void select(''));
$('first-provider').addEventListener('click', () => void select(''));
$('open-model-settings').addEventListener('click', () => void openPage('settings'));
$('open-usage').addEventListener('click', () => void openPage('usage'));
$('usage-period').addEventListener('change', readUsage);
$('refresh-usage').addEventListener('click', readUsage);
$('usage-provider').addEventListener('change', renderUsage);
$('usage-model').addEventListener('change', renderUsage);
for (const [kind, baseline, values] of [
  ['utility', () => utilityBaseline, utilityValues], ['routing', () => routingBaseline, routingValues],
]) {
  const form = $(`${kind}-settings`);
  const save = $(`save-${kind}`);
  form.addEventListener('input', syncControls);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!save.disabled) {
      saveModelSettings(kind === 'utility' ? 'saveUtility' : 'saveRouting', baseline(), values(), $(`${kind}-status`));
    }
  });
}
$('revert').addEventListener('click', () => {
  load(current?.id ? entries.find(item => item.id === current.id) ?? entries[0] : { id: '', config: {} });
  if (!editor.hidden) {
    fields.name.focus();
  }
});
$('add-header').addEventListener('click', () => { makeHeader('', '', true); changed(); });
$('add-model').addEventListener('click', () => { makeModel({}, true); changed(); });
$('remove-provider').addEventListener('click', async () => {
  if (await confirmAction('Remove provider?', t('Remove “{0}” and its models from Copilot Custom API?', current.config.name), 'Remove provider')) {
    request('remove');
  }
});
$('clear-key').addEventListener('click', async () => {
  if (await confirmAction('Clear API key?', t('Requests that need this key will fail until you enter a new one.'), 'Clear key')) {
    request('clearKey');
  }
});
$('discover').addEventListener('click', () => {
  checked.clear();
  discovered = [];
  $('catalog-search').value = '';
  $('catalog-url').value = '';
  $('catalog-advanced').open = false;
  renderCatalog();
  catalog.showModal();
  request('discover');
});
$('catalog-search').addEventListener('input', renderCatalog);
$('close-catalog').addEventListener('click', () => catalog.close());
$('retry-catalog').addEventListener('click', () => {
  request('discover', { catalogUrl: $('catalog-url').value });
});
$('add-selected').addEventListener('click', () => {
  for (const model of discovered) {
    if (checked.has(model.id)) {
      makeModel(model, !model.maxInputTokens || !model.maxOutputTokens);
    }
  }
  catalog.close();
  changed();
});

window.addEventListener('message', ({ data }) => {
  if (data.type === 'state') {
    entries = data.entries;
    protocols = data.protocols;
    vendor = data.vendor;
    chinese = data.chinese ?? {};
    const preference = data.preference ?? 'auto';
    const language = preference === 'auto' ? data.language ?? 'en' : preference;
    const nextDictionary = language.toLowerCase().startsWith('zh') ? chinese : {};
    const languageChanged = !ready || document.documentElement.lang !== (language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en');
    dictionary = nextDictionary;
    receiveModelSettings(data);
    $('language').value = preference;
    if (languageChanged) {
      document.documentElement.lang = language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
      translateStatic(document.body);
      renderNavigation();
      for (const row of $('models').children) {
        updateDefaultEffort(row);
        updateModelSummary(row);
      }
      for (const [target, message] of notices) {
        target.textContent = translateMessage(message);
      }
      if (catalog.open) {
        renderCatalog();
      }
      updateTitle();
      if (page === 'usage') {
        renderUsage();
      }
    }
    if (!ready) {
      fields.protocol.replaceChildren(...Object.entries(protocols).map(([value, name]) => new Option(name, value)));
      $('loading').hidden = true;
      ready = true;
      load(data.selection === '' ? { id: '', config: {} } : entries.find(item => item.id === data.selection) ?? entries[0]);
    } else if (data.selection !== undefined || !dirty) {
      const selected = data.selection === '' ? entries[0]
        : entries.find(item => item.id === (data.selection ?? current?.id)) ?? entries[0];
      if (data.selection === undefined && selected && current && selected.id === current.id &&
        JSON.stringify(selected.config) === current.baseline) {
        current.hasKey = selected.hasKey;
        current.keyedOrigins = selected.keyedOrigins;
        syncControls();
        return;
      }
      const previousTab = activeTab;
      load(selected, true);
      if (selected && data.selection !== '') {
        showTab(previousTab);
      }
    } else {
      if (current?.id) {
        const saved = entries.find(item => item.id === current.id);
        current.hasKey = saved?.hasKey ?? false;
        current.keyedOrigins = saved?.keyedOrigins;
      }
      renderNavigation();
      syncControls();
    }
    if (data.showUsage) {
      void openPage('usage');
    }
  } else if (data.type === 'loadError') {
    if (!ready) {
      $('loading').textContent = translateMessage(data.status);
    } else {
      notice(data.status, 'error');
    }
  } else if (data.type === 'select') {
    void select(data.id);
  } else if (data.type === 'openUsage') {
    if (page === 'usage') {
      readUsage();
    } else {
      void openPage('usage');
    }
  } else if (data.type === 'usage' && page === 'usage' && data.period === Number($('usage-period').value)) {
    usageData = data;
    renderUsage();
  } else if (data.type === 'done' || data.type === 'error') {
    busy = false;
    if (data.type === 'done' && data.action === 'save') {
      dirty = false;
      fields.apiKey.value = '';
    }
    if (operation === 'saveUtility' || operation === 'saveRouting') {
      const utility = operation === 'saveUtility';
      if (data.type === 'done') {
        if (utility) {
          utilityBaseline = JSON.stringify(utilityValues());
        } else {
          routingBaseline = routingValues();
        }
      }
      notice(data.status, data.type === 'error' ? 'error' : 'success', $(utility ? 'utility-status' : 'routing-status'));
    } else if (operation === 'discover') {
      $('retry-catalog').disabled = false;
      $('catalog-advanced').open = true;
      notice(data.status, 'error', catalog.open ? $('catalog-status') : $('status'));
      renderCatalog();
    } else {
      notice(data.status, data.type === 'error' ? 'error' : 'success');
    }
    operation = '';
    syncControls();
  } else if (data.type === 'metadata') {
    applyMetadata(data);
  } else if (data.type === 'catalog') {
    busy = false;
    operation = '';
    discovered = data.models;
    checked.clear();
    $('retry-catalog').disabled = false;
    notice('', '', $('catalog-status'));
    renderCatalog();
    syncControls();
  }
});
vscode.postMessage({ type: 'ready' });
