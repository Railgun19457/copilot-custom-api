import { randomUUID } from 'node:crypto';
import { JsonObject, object, string } from '../config';
import {
  Adapter, argumentsObject, callName, checkStreamError, findCallNames, Image, records,
  Request, schema, systemText, Text, textParts, tokenCount, tokenUsage, ToolCall, toolCall, updateUsage,
} from './types';

const generatedCallId = 'copilot-custom-api-';

function geminiUsage(prompt: unknown, toolPrompt: unknown, output: unknown, thoughts: unknown, total: unknown, cached: unknown) {
  const input = tokenCount(prompt);
  const toolInput = tokenCount(toolPrompt) ?? 0;
  const response = tokenCount(output);
  const reasoning = tokenCount(thoughts);
  return tokenUsage(input === undefined ? undefined : input + toolInput,
    response === undefined ? undefined : response + (reasoning ?? 0), total, { cached, reasoning });
}

function generateContents(request: Request): JsonObject[] {
  const names = findCallNames(request.messages);
  const contents: { role: string; parts: JsonObject[] }[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') {
      continue;
    }
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts = message.role === 'assistant' && message.native ? message.native.items : message.parts.map(part => {
      if (part.type === 'text') {
        return { text: part.text };
      }
      if (part.type === 'image') {
        return { inlineData: { mimeType: part.mime, data: part.base64 } };
      }
      const id = part.id.startsWith(generatedCallId) ? undefined : part.id;
      if (part.type === 'call') {
        return { functionCall: { id, name: part.name, args: part.input } };
      }
      const images = part.content.filter((item): item is Image => item.type === 'image');
      return {
        functionResponse: {
          id,
          name: callName(names, part.id),
          response: { output: textParts(part.content) },
          parts: images.length ? images.map(image => ({
            inlineData: { mimeType: image.mime, data: image.base64 },
          })) : undefined,
        },
      };
    });
    if (parts.length) {
      const last = contents.at(-1);
      if (last?.role === role) {
        last.parts.push(...parts);
      } else {
        contents.push({ role, parts: [...parts] });
      }
    }
  }
  return contents;
}

export const geminiGenerateContent: Adapter = {
  build(request) {
    const { model, tools, requireTool } = request;
    const generation = object(model.options.generationConfig);
    const system = systemText(request.messages);
    return {
      ...model.options,
      contents: generateContents(request),
      systemInstruction: system ? { parts: [{ text: system }] } : model.options.systemInstruction,
      generationConfig: {
        ...generation,
        maxOutputTokens: request.maxOutputTokens ?? generation.maxOutputTokens ?? model.maxOutputTokens,
        candidateCount: 1,
        thinkingConfig: model.reasoningEffort
          ? { ...object(generation.thinkingConfig), thinkingLevel: model.reasoningEffort.toUpperCase() }
          : generation.thinkingConfig,
      },
      tools: tools.length ? [{ functionDeclarations: tools.map(tool => ({
        name: tool.name, description: tool.description, parametersJsonSchema: schema(tool),
      })) }] : undefined,
      toolConfig: tools.length ? {
        functionCallingConfig: { mode: requireTool ? 'ANY' : 'AUTO' },
      } : undefined,
    };
  },

  async read(events, report) {
    const calls: ToolCall[] = [];
    const items: JsonObject[] = [];
    let finished = false;
    let counts: JsonObject = {};
    for await (const event of events) {
      checkStreamError(event);
      if (event.name === '[DONE]') {
        finished = true;
        break;
      }
      if (object(event.data.promptFeedback).blockReason) {
        throw new Error('Gemini blocked the request.');
      }
      counts = updateUsage(counts, event.data.usageMetadata);
      const candidates = records(event.data.candidates);
      const candidate = candidates.find(item => item.index === 0) ?? candidates[0];
      if (!candidate) {
        continue;
      }
      for (const item of records(object(candidate.content).parts)) {
        const functionCall = object(item.functionCall);
        if (item.functionCall) {
          if (functionCall.willContinue || functionCall.partialArgs) {
            throw new Error('Disable partial function arguments for Gemini GenerateContent.');
          }
          calls.push(toolCall(string(functionCall.id) || `${generatedCallId}${randomUUID()}`, functionCall.name, functionCall.args));
        } else if (item.thought !== true && string(item.text)) {
          report({ type: 'text', text: string(item.text) });
        } else if (item.thought !== true) {
          const inlineData = object(item.inlineData);
          if (string(inlineData.mimeType).startsWith('image/') && string(inlineData.data)) {
            report({ type: 'image', mime: string(inlineData.mimeType), base64: string(inlineData.data) });
          }
        }
        const last = items.at(-1);
        if (last && typeof last.text === 'string' && typeof item.text === 'string' &&
          !last.thoughtSignature && !item.thoughtSignature && last.thought === item.thought) {
          // Preserve the original boundaries of signed parts.
          last.text += item.text;
        } else {
          items.push({ ...item });
        }
      }
      const reason = string(candidate.finishReason);
      if (reason && !['STOP', 'MAX_TOKENS', 'FINISH_REASON_UNSPECIFIED'].includes(reason)) {
        throw new Error('Gemini stopped before it completed the response.');
      }
      finished ||= event.json || reason === 'STOP' || reason === 'MAX_TOKENS';
    }
    if (!finished) {
      throw new Error('The Gemini GenerateContent stream ended before completion.');
    }
    calls.forEach(report);
    return {
      native: items.length ? { items, callIds: calls.map(call => call.id) } : undefined,
      usage: geminiUsage(counts.promptTokenCount, counts.toolUsePromptTokenCount, counts.candidatesTokenCount,
        counts.thoughtsTokenCount, counts.totalTokenCount, counts.cachedContentTokenCount),
    };
  },
};

function interactionContent(part: Text | Image): JsonObject {
  return part.type === 'text' ? { type: 'text', text: part.text } : {
    type: 'image', mime_type: part.mime, data: part.base64,
  };
}

function interactionInput(request: Request): JsonObject[] {
  const names = findCallNames(request.messages);
  const result: JsonObject[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') {
      continue;
    }
    if (message.role === 'assistant' && message.native) {
      result.push(...message.native.items);
      continue;
    }
    let content: JsonObject[] = [];
    const flush = () => {
      if (content.length) {
        result.push({ type: message.role === 'assistant' ? 'model_output' : 'user_input', content });
        content = [];
      }
    };
    for (const part of message.parts) {
      if (part.type === 'text' || part.type === 'image') {
        content.push(interactionContent(part));
      } else {
        flush();
        if (part.type === 'call') {
          result.push({ type: 'function_call', id: part.id, name: part.name, arguments: part.input });
        } else {
          result.push({
            type: 'function_result', call_id: part.id, name: callName(names, part.id),
            result: part.content.map(interactionContent),
          });
        }
      }
    }
    flush();
  }
  return result;
}

function reportInteractionContent(block: JsonObject, report: (part: Text | Image) => void): void {
  if (block.type === 'text' && string(block.text)) {
    report({ type: 'text', text: string(block.text) });
  } else if (block.type === 'image' && string(block.data) && string(block.mime_type).startsWith('image/')) {
    report({ type: 'image', mime: string(block.mime_type), base64: string(block.data) });
  }
}

export const geminiInteractions: Adapter = {
  build(request) {
    const { model, tools, requireTool } = request;
    const generation = object(model.options.generation_config);
    return {
      store: false,
      ...model.options,
      model: model.id.replace(/^models\//, ''),
      input: interactionInput(request),
      previous_interaction_id: undefined,
      background: false,
      stream: model.streaming,
      system_instruction: systemText(request.messages) || model.options.system_instruction,
      generation_config: {
        ...generation,
        max_output_tokens: request.maxOutputTokens ?? generation.max_output_tokens ?? model.maxOutputTokens,
        ...(model.reasoningEffort ? { thinking_level: model.reasoningEffort.toLowerCase() } : {}),
        tool_choice: tools.length ? (requireTool ? 'any' : 'auto') : undefined,
      },
      tools: tools.length ? tools.map(tool => ({
        type: 'function', name: tool.name, description: tool.description, parameters: schema(tool),
      })) : undefined,
    };
  },

  async read(events, report) {
    const steps = new Map<number, { step: JsonObject; arguments: string }>();
    let items: JsonObject[] = [];
    let finished = false;
    let streamed = false;
    let counts: JsonObject = {};
    const reportContent = (block: JsonObject) => reportInteractionContent(block, part => {
      streamed = true;
      report(part);
    });
    for await (const event of events) {
      checkStreamError(event);
      const { data } = event;
      const type = string(data.event_type) || event.name;
      const interaction = event.json ? data : object(data.interaction);
      const status = string(interaction.status ?? data.status);
      if (['failed', 'cancelled', 'incomplete'].includes(status)) {
        throw new Error('Gemini did not complete the interaction.');
      }
      if (event.json || type === 'interaction.completed') {
        counts = object(interaction.usage ?? data.usage);
        items = records(interaction.steps);
        if (!streamed) {
          for (const item of items) {
            if (item.type === 'model_output') {
              records(item.content).forEach(reportContent);
            }
          }
        }
        finished = true;
        break;
      }
      if (typeof data.index !== 'number') {
        continue;
      }
      if (type === 'step.start') {
        const step = { ...object(data.step) };
        const content = records(step.content);
        if (step.type === 'model_output' && content.length) {
          content.forEach(reportContent);
        }
        steps.set(data.index, { step, arguments: '' });
      } else if (type === 'step.delta') {
        const delta = object(data.delta);
        const entry = steps.get(data.index);
        if (!entry) {
          throw new Error('The Gemini Interactions stream returned a delta for an unknown step.');
        }
        if (delta.type === 'arguments_delta') {
          entry.arguments += string(delta.arguments);
        } else if (delta.type === 'thought_signature') {
          entry.step.signature = string(delta.signature);
        } else if (delta.type === 'thought_summary') {
          entry.step.summary = [...records(entry.step.summary), object(delta.content)];
        } else if (entry.step.type === 'model_output' && ['text', 'image'].includes(string(delta.type))) {
          reportContent(delta);
          const content = records(entry.step.content);
          const last = content.at(-1);
          if (last?.type === 'text' && delta.type === 'text') {
            last.text = string(last.text) + string(delta.text);
          } else {
            content.push(delta);
          }
          entry.step.content = content;
        }
      }
    }
    if (!finished) {
      throw new Error('The Gemini Interactions stream ended before completion.');
    }
    if (!items.length) {
      items = [...steps.entries()].sort(([a], [b]) => a - b).map(([, entry]) =>
        entry.arguments ? { ...entry.step, arguments: argumentsObject(entry.arguments) } : entry.step);
    }
    const calls = items.filter(item => item.type === 'function_call')
      .map(item => toolCall(item.id, item.name, item.arguments));
    calls.forEach(report);
    const supported = items.filter(item => ['thought', 'model_output', 'function_call'].includes(string(item.type)));
    return {
      native: supported.length ? { items: supported, callIds: calls.map(call => call.id) } : undefined,
      usage: geminiUsage(counts.total_input_tokens, counts.total_tool_use_tokens, counts.total_output_tokens,
        counts.total_thought_tokens, counts.total_tokens, counts.total_cached_tokens),
    };
  },
};
