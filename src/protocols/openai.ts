import { JsonObject, object, string } from '../config';
import { Adapter, checkStreamError, imageUrl, records, Request, schema, textParts, ToolCall, toolCall } from './types';

function chatMessages(request: Request): JsonObject[] {
  const result: JsonObject[] = [];
  for (const message of request.messages) {
    if (message.role === 'assistant' && message.native) {
      result.push(...message.native.items);
      continue;
    }
    const images: JsonObject[] = [];
    const content: JsonObject[] = [];
    const calls: JsonObject[] = [];
    for (const part of message.parts) {
      if (part.type === 'result') {
        result.push({ role: 'tool', tool_call_id: part.id, content: textParts(part.content) });
        for (const item of part.content) {
          if (item.type === 'image') {
            images.push({ type: 'image_url', image_url: { url: imageUrl(item) } });
          }
        }
      } else if (part.type === 'call') {
        calls.push({
          id: part.id,
          type: 'function',
          function: { name: part.name, arguments: JSON.stringify(part.input) },
        });
      } else if (part.type === 'image') {
        content.push({ type: 'image_url', image_url: { url: imageUrl(part) } });
      } else {
        content.push({ type: 'text', text: part.text });
      }
    }
    content.push(...images);
    if (content.length || calls.length) {
      const text = content.every(part => part.type === 'text')
        ? content.map(part => part.text).join('') : content;
      result.push({
        role: message.role,
        content: content.length ? text : null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
    }
  }
  return result;
}

export const chatCompletions: Adapter = {
  build(request) {
    const { model, tools, requireTool } = request;
    const options = model.options;
    const limit = options.max_completion_tokens !== undefined
      || (options.max_tokens === undefined && request.url.hostname === 'api.openai.com')
      ? 'max_completion_tokens' : 'max_tokens';
    return {
      [limit]: model.maxOutputTokens,
      ...options,
      ...(request.maxOutputTokens !== undefined ? {
        max_tokens: limit === 'max_tokens' ? request.maxOutputTokens : undefined,
        max_completion_tokens: limit === 'max_completion_tokens' ? request.maxOutputTokens : undefined,
      } : {}),
      ...(model.reasoningEffort ? { reasoning_effort: model.reasoningEffort } : {}),
      model: model.id,
      messages: chatMessages(request),
      stream: model.streaming,
      n: 1,
      tools: tools.length ? tools.map(tool => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: schema(tool) },
      })) : undefined,
      tool_choice: tools.length ? (requireTool ? 'required' : 'auto') : undefined,
    };
  },

  async read(events, report) {
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let content = '';
    let reasoning = '';
    let finished = false;
    for await (const event of events) {
      checkStreamError(event);
      if (event.name === '[DONE]') {
        finished = true;
        break;
      }
      const choices = records(event.data.choices);
      const choice = choices.find(item => item.index === 0) ?? choices[0];
      if (!choice) {
        continue;
      }
      const message = object(event.json ? choice.message : choice.delta);
      const text = string(message.content) || string(message.refusal);
      if (text) {
        content += text;
        report({ type: 'text', text });
      }
      reasoning += string(message.reasoning_content);
      for (const [position, call] of records(message.tool_calls).entries()) {
        const index = typeof call.index === 'number' ? call.index : position;
        const entry = pending.get(index) ?? { id: '', name: '', args: '' };
        const func = object(call.function);
        entry.id ||= string(call.id);
        entry.name += string(func.name);
        entry.args += string(func.arguments);
        pending.set(index, entry);
      }
      const stop = string(choice.finish_reason);
      if (stop === 'content_filter' || (stop === 'length' && pending.size)) {
        throw new Error('The endpoint stopped before it completed the response.');
      }
      finished ||= event.json || Boolean(stop);
    }
    if (!finished) {
      throw new Error('The Chat Completions stream ended before completion.');
    }
    const calls = [...pending.entries()].sort(([a], [b]) => a - b)
      .map(([, call]) => toolCall(call.id, call.name, call.args));
    calls.forEach(report);
    if (reasoning && calls.length) {
      return {
        items: [{
          role: 'assistant',
          content: content || null,
          reasoning_content: reasoning,
          tool_calls: calls.map(call => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          })),
        }],
        callIds: calls.map(call => call.id),
      };
    }
    return undefined;
  },
};

function responseInput(request: Request): JsonObject[] {
  const result: JsonObject[] = [];
  for (const message of request.messages) {
    if (message.role === 'assistant' && message.native) {
      result.push(...message.native.items.filter(item => item.type !== 'reasoning' ||
        typeof item.encrypted_content === 'string' || request.model.options.store === true));
      continue;
    }
    let content: JsonObject[] = [];
    const flush = () => {
      if (content.length) {
        result.push({ role: message.role, content });
        content = [];
      }
    };
    for (const part of message.parts) {
      if (part.type === 'text') {
        content.push({ type: 'input_text', text: part.text });
      } else if (part.type === 'image') {
        content.push({ type: 'input_image', image_url: imageUrl(part) });
      } else {
        flush();
        if (part.type === 'call') {
          result.push({
            type: 'function_call', call_id: part.id, name: part.name, arguments: JSON.stringify(part.input),
          });
        } else {
          result.push({
            type: 'function_call_output',
            call_id: part.id,
            output: part.content.some(item => item.type === 'image')
              ? part.content.map(item => item.type === 'text'
                ? { type: 'input_text', text: item.text }
                : { type: 'input_image', image_url: imageUrl(item) })
              : textParts(part.content),
          });
        }
      }
    }
    flush();
  }
  return result;
}

export const responses: Adapter = {
  build(request) {
    const { model, tools, requireTool } = request;
    const reasoning = model.reasoningEffort
      ? { ...object(model.options.reasoning), effort: model.reasoningEffort }
      : model.options.reasoning;
    return {
      store: false,
      ...(request.url.hostname === 'api.openai.com' && model.options.store !== true
        ? { include: ['reasoning.encrypted_content'] } : {}),
      ...model.options,
      max_output_tokens: request.maxOutputTokens ?? model.options.max_output_tokens ?? model.maxOutputTokens,
      reasoning,
      model: model.id,
      input: responseInput(request),
      previous_response_id: undefined,
      conversation: undefined,
      stream: model.streaming,
      tools: tools.length ? tools.map(tool => ({
        type: 'function', name: tool.name, description: tool.description, parameters: schema(tool), strict: false,
      })) : undefined,
      tool_choice: tools.length ? (requireTool ? 'required' : 'auto') : undefined,
    };
  },

  async read(events, report) {
    const completed = new Map<number, JsonObject>();
    const deltas = new Map<number, string>();
    let output: JsonObject[] = [];
    let streamedText = false;
    let finished = false;
    for await (const event of events) {
      checkStreamError(event);
      const { data } = event;
      const type = string(data.type) || event.name;
      if (type === 'response.incomplete' || data.status === 'incomplete') {
        throw new Error('The Responses endpoint returned an incomplete response.');
      }
      const index = typeof data.output_index === 'number' ? data.output_index : completed.size;
      if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
        const text = string(data.delta);
        if (text) {
          streamedText = true;
          report({ type: 'text', text });
        }
      } else if (type === 'response.function_call_arguments.delta') {
        deltas.set(index, (deltas.get(index) ?? '') + string(data.delta));
      } else if (type === 'response.function_call_arguments.done' && typeof data.arguments === 'string') {
        deltas.set(index, data.arguments);
      } else if (type === 'response.output_item.done') {
        const item = object(data.item);
        completed.set(index, item.type === 'function_call' && !string(item.arguments)
          ? { ...item, arguments: deltas.get(index) } : item);
      } else if (type === 'response.completed' || event.json) {
        const response = event.json ? data : object(data.response);
        if (response.status === 'failed' || response.status === 'incomplete' || response.error) {
          throw new Error('The Responses endpoint failed to complete generation.');
        }
        output = records(response.output);
        finished = true;
      }
      if (finished || event.name === '[DONE]') {
        break;
      }
    }
    if (!finished) {
      throw new Error('The Responses stream ended before completion.');
    }
    if (!output.length) {
      output = [...completed.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
    }
    const calls: ToolCall[] = [];
    const items: JsonObject[] = [];
    for (const [index, item] of output.entries()) {
      if (item.type === 'message' && item.role === 'assistant') {
        if (!streamedText) {
          for (const block of records(item.content)) {
            const text = string(block.text) || string(block.refusal);
            if (text) {
              report({ type: 'text', text });
            }
          }
        }
        items.push(item);
      } else if (item.type === 'function_call') {
        const args = item.arguments ?? deltas.get(index);
        calls.push(toolCall(item.call_id, item.name, args));
        items.push({ ...item, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) });
      } else if (item.type === 'reasoning') {
        items.push(item);
      }
    }
    calls.forEach(report);
    return items.length ? { items, callIds: calls.map(call => call.id) } : undefined;
  },
};
