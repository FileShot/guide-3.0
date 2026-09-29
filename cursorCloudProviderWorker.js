/**
 * Out-of-process Cursor SDK worker.
 * Electron's Node (20.x, no node:sqlite) native-crashes on Agent.send.
 * guIDE main spawns this with system Node so crashes stay in the child.
 *
 * Protocol (stdout NDJSON, one object per line):
 *   { type: 'token', text }
 *   { type: 'thinking', text }
 *   { type: 'done', text, model, tokensUsed, thinkingText }
 *   { type: 'error', message }
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function resolveModel(modelId) {
  const id = String(modelId || 'default').trim() || 'default';
  if (
    id === 'auto' ||
    id === 'auto-smart' ||
    id === 'auto-smart-balance' ||
    id === 'auto-smart-cost' ||
    id === 'auto-smart-intelligence'
  ) {
    return { id: 'default' };
  }
  return { id };
}

function buildMessage(systemPrompt, prompt, conversationHistory) {
  const parts = [];
  const sys = String(systemPrompt || '').trim();
  if (sys) parts.push(`[System instructions for this turn]\n${sys}`);
  const hist = Array.isArray(conversationHistory) ? conversationHistory : [];
  for (const m of hist) {
    const role = String(m?.role || 'user');
    const content = String(m?.content || '').trim();
    if (!content) continue;
    parts.push(`[${role}]\n${content}`);
  }
  const user = String(prompt || '').trim();
  if (user) parts.push(`[user]\n${user}`);
  if (!parts.length) throw new Error('Cursor generate: empty messages (no user query)');
  return parts.join('\n\n');
}

async function main() {
  const raw = process.argv[2];
  if (!raw) throw new Error('worker: missing payload argv');
  const payload = JSON.parse(raw);
  const key = String(payload.apiKey || '').trim();
  if (!key) throw new Error('No API key configured for cursor');

  const { Agent, JsonlLocalAgentStore } = require('@cursor/sdk');
  const cwd = String(payload.cwd || process.cwd()).trim() || process.cwd();
  const storeRoot =
    String(payload.storeDir || '').trim() ||
    path.join(process.env.APPDATA || os.homedir(), 'guide-ide', 'cursor-agent-store');
  fs.mkdirSync(storeRoot, { recursive: true });

  const modelSelection = resolveModel(payload.model);
  const message = buildMessage(
    payload.systemPrompt,
    payload.prompt,
    payload.conversationHistory
  );

  const local = {
    cwd,
    store: new JsonlLocalAgentStore(storeRoot),
  };

  const agent = await Agent.create({
    apiKey: key,
    model: modelSelection,
    local,
  });

  let fullText = '';
  let thinkingText = '';
  let cancelled = false;

  process.on('message', (msg) => {
    if (msg && msg.type === 'cancel') cancelled = true;
  });
  // Also honor SIGTERM from parent kill
  process.on('SIGTERM', () => {
    cancelled = true;
  });

  try {
    const run = await agent.send(message);
    if (typeof run.stream === 'function') {
      for await (const event of run.stream()) {
        if (cancelled) {
          try {
            await run.cancel?.();
          } catch (_) {}
          break;
        }
        const type = event?.type;
        if (type === 'assistant') {
          const content = event?.message?.content || [];
          for (const block of content) {
            if (block?.type === 'text' && block.text) {
              fullText += block.text;
              emit({ type: 'token', text: block.text });
            }
          }
        } else if (type === 'thinking' || type === 'reasoning') {
          const text =
            event?.text ||
            event?.message?.content?.map?.((b) => b.text).filter(Boolean).join('') ||
            '';
          if (text) {
            thinkingText += text;
            emit({ type: 'thinking', text });
          }
        } else if (type === 'status' && event?.status === 'ERROR') {
          const msg = event?.message || event?.error || 'Cursor agent run failed';
          throw new Error(String(msg));
        }
      }
      if (typeof run.wait === 'function') {
        const waited = await run.wait();
        if (waited?.status === 'error') {
          throw new Error(waited?.error?.message || 'Cursor agent run failed');
        }
        if (!fullText && waited?.result) {
          fullText = String(waited.result);
          emit({ type: 'token', text: fullText });
        }
      }
    } else {
      const result = await Agent.prompt(message, {
        apiKey: key,
        model: modelSelection,
        local,
      });
      if (result?.status === 'error') {
        throw new Error(result?.error?.message || 'Cursor agent run failed');
      }
      fullText = String(result?.result || result?.text || '');
      if (fullText) emit({ type: 'token', text: fullText });
    }
  } finally {
    try {
      if (typeof agent[Symbol.asyncDispose] === 'function') {
        await agent[Symbol.asyncDispose]();
      } else if (typeof agent.close === 'function') {
        await agent.close();
      }
    } catch (_) {}
  }

  emit({
    type: 'done',
    text: fullText,
    model: modelSelection.id,
    tokensUsed: Math.round((fullText.length + thinkingText.length) / 4),
    thinkingText,
  });
}

main().catch((e) => {
  emit({ type: 'error', message: String(e && e.message ? e.message : e) });
  process.exitCode = 1;
});
