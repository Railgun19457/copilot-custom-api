import { JsonObject, object, string } from '../config';
import { Adapter, argumentsObject, checkStreamError, records, Request, schema, systemText, toolCall } from './types';

function messages(request: Request): JsonObject[] {
  const result: { role: string; content: JsonObject[] }[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') {
      continue;
    }
    const content: JsonObject[] = [];
    if (message.role === 'assistant' && message.native) {
      content.push(...message.native.items);
    } else {
      for (const part of message.parts) {
        if (part.type === 'text') {
          if (part.text) {
            content.push({ type: 'text', text: part.text });
          }
        } else if (part.type === 'image') {
          content.push({ type: 'image', source: { type: 'base64', media_type: part.mime, data: part.base64 } });
        } else if (part.type === 'call') {
          content.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input });
        } else {
          content.push({
            type: 'tool_result',
            tool_use_id: part.id,
            content: part.content.map(item => item.type === 'text'
              ? { type: 'text', text: item.text || ' ' }
              : { type: 'image', source: { type: 'base64', media_type: item.mime, data: item.base64 } }),
          });
        }
      }
    }
    if (!content.length) {
      continue;
    }
    const last = result.at(-1);
    if (last?.role === message.role) {
      last.content.push(...content);
    } else {
      result.push({ role: message.role, content });
    }
  }
  for (const message of result) {
    if (message.role === 'user') {
      // Anthropic requires every tool result at the beginning of its user turn.
      const results = message.content.filter(block => block.type === 'tool_result');
      const others = message.content.filter(block => block.type !== 'tool_result');
      message.content = [...results, ...others];
    }
  }
  return result;
}

export const anthropicMessages: Adapter = {
  build(request) {
    const { model, tools, requireTool } = request;
    const thinking = model.options.thinking ?? (model.reasoningEffort ? { type: 'adaptive' } : undefined);
    if (requireTool && ['enabled', 'adaptive'].includes(string(object(thinking).type))) {
      throw new Error('Anthropic does not allow forcing a tool while thinking is enabled.');
    }
    return {
      ...model.options,
      max_tokens: request.maxOutputTokens ?? model.options.max_tokens ?? model.maxOutputTokens,
      thinking,
      output_config: model.reasoningEffort
        ? { ...object(model.options.output_config), effort: model.reasoningEffort }
        : model.options.output_config,
      model: model.id,
      messages: messages(request),
      system: systemText(request.messages) || model.options.system,
      stream: model.streaming,
      tools: tools.length ? tools.map(tool => ({
        name: tool.name, description: tool.description, input_schema: schema(tool),
      })) : undefined,
      tool_choice: tools.length ? { type: requireTool ? 'any' : 'auto' } : undefined,
    };
  },

  async read(events, report) {
    const blocks = new Map<number, { block: JsonObject; arguments: string }>();
    let items: JsonObject[] = [];
    let finished = false;
    for await (const event of events) {
      checkStreamError(event);
      const { data } = event;
      const type = string(data.type) || event.name;
      if (event.json) {
        items = records(data.content);
        for (const block of items) {
          if (block.type === 'text' && string(block.text)) {
            report({ type: 'text', text: string(block.text) });
          }
        }
        finished = true;
        break;
      }
      if (type === 'message_stop') {
        finished = true;
        break;
      }
      if (typeof data.index !== 'number') {
        continue;
      }
      if (type === 'content_block_start') {
        const block = { ...object(data.content_block) };
        if (block.type === 'text' && string(block.text)) {
          report({ type: 'text', text: string(block.text) });
        }
        blocks.set(data.index, { block, arguments: '' });
      } else if (type === 'content_block_delta') {
        const entry = blocks.get(data.index);
        const delta = object(data.delta);
        if (!entry) {
          throw new Error('The Messages stream returned a delta for an unknown content block.');
        }
        if (delta.type === 'text_delta') {
          const text = string(delta.text);
          entry.block.text = string(entry.block.text) + text;
          if (text) {
            report({ type: 'text', text });
          }
        } else if (delta.type === 'input_json_delta') {
          entry.arguments += string(delta.partial_json);
        } else if (delta.type === 'thinking_delta') {
          entry.block.thinking = string(entry.block.thinking) + string(delta.thinking);
        } else if (delta.type === 'signature_delta') {
          entry.block.signature = string(entry.block.signature) + string(delta.signature);
        }
      }
    }
    if (!finished) {
      throw new Error('The Messages stream ended before completion.');
    }
    if (blocks.size) {
      items = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, entry]) =>
        entry.arguments ? { ...entry.block, input: argumentsObject(entry.arguments) } : entry.block);
    }
    const calls = items.filter(item => item.type === 'tool_use')
      .map(item => toolCall(item.id, item.name, item.input));
    calls.forEach(report);
    const supported = items.filter(item => ['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(string(item.type)));
    return supported.length ? { items: supported, callIds: calls.map(call => call.id) } : undefined;
  },
};
