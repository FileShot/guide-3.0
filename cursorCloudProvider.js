/**
 * Cursor provider for guIDE — uses @cursor/sdk (Agent API), not OpenAI chat/completions.
 *
 * HARD: Never run Agent.send inside Electron main. Electron Node 20 lacks node:sqlite
 * and Agent.send native-crashes the whole app (crashpad). Always spawn system Node
 * (`cursorCloudProviderWorker.js`) when process.versions.electron is set.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

function resolveCursorModelSelection(modelId) {
  const id = String(modelId || 'default').trim() || 'default';
  // SDK catalog: id "default" IS Auto (aliases include "auto")
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

function resolveCursorAgentStoreDir() {
  const base =
    process.env.GUIDE_USER_DATA ||
    process.env.APPDATA ||
    os.homedir();
  const root = path.join(base, 'guide-ide', 'cursor-agent-store');
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (_) {}
  return root;
}

function createCursorLocalOptions(cwd) {
  const { JsonlLocalAgentStore } = require('@cursor/sdk');
  const storeDir = resolveCursorAgentStoreDir();
  return {
    cwd: String(cwd || process.cwd()),
    store: new JsonlLocalAgentStore(storeDir),
  };
}

function buildCursorUserMessage(systemPrompt, prompt, conversationHistory) {
  const parts = [];
  const sys = String(systemPrompt || '').trim();
  if (sys) {
    parts.push(`[System instructions for this turn]\n${sys}`);
  }
  const hist = Array.isArray(conversationHistory) ? conversationHistory : [];
  for (const m of hist) {
    const role = String(m?.role || 'user');
    const content = String(m?.content || '').trim();
    if (!content) continue;
    parts.push(`[${role}]\n${content}`);
  }
  const user = String(prompt || '').trim();
  if (user) parts.push(`[user]\n${user}`);
  if (!parts.length) {
    throw new Error('Cursor generate: empty messages (no user query)');
  }
  return parts.join('\n\n');
}

function resolveSystemNodeBinary() {
  const candidates = [];
  if (process.env.GUIDE_SYSTEM_NODE) candidates.push(process.env.GUIDE_SYSTEM_NODE);
  candidates.push(
    'D:\\Server\\node.exe',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
    'node'
  );
  for (const c of candidates) {
    if (!c) continue;
    if (c === 'node') return c;
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return 'node';
}

function generateWithCursorSdkInWorker(opts) {
  const {
    apiKey,
    model,
    systemPrompt,
    prompt,
    conversationHistory,
    onToken,
    onThinkingToken,
    projectPath,
    getCancelled,
  } = opts;

  const key = String(apiKey || '').trim();
  if (!key) return Promise.reject(new Error('No API key configured for cursor'));

  const cwd = String(projectPath || process.cwd() || '').trim() || process.cwd();
  const modelSelection = resolveCursorModelSelection(model);
  const workerPath = path.join(__dirname, 'cursorCloudProviderWorker.js');
  const nodeBin = resolveSystemNodeBinary();
  const payload = {
    apiKey: key,
    model: modelSelection.id,
    systemPrompt,
    prompt,
    conversationHistory,
    cwd,
    storeDir: resolveCursorAgentStoreDir(),
  };

  console.log(
    `[CursorSDK] worker spawn node=${nodeBin} model=${modelSelection.id} (Auto if default) cwd=${cwd}`
  );

  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [workerPath, JSON.stringify(payload)], {
      cwd: __dirname,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let buf = '';
    let stderr = '';
    let fullText = '';
    let thinkingText = '';
    let donePayload = null;
    let settled = false;
    let cancelTimer = null;

    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (cancelTimer) clearInterval(cancelTimer);
      fn(arg);
    };

    cancelTimer = setInterval(() => {
      if (getCancelled?.()) {
        try {
          child.kill('SIGTERM');
        } catch (_) {}
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch (_) {}
        }, 1500);
      }
    }, 250);

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch (_) {
          continue;
        }
        if (ev.type === 'token' && ev.text) {
          fullText += ev.text;
          if (onToken) onToken(ev.text);
        } else if (ev.type === 'thinking' && ev.text) {
          thinkingText += ev.text;
          if (onThinkingToken) onThinkingToken(ev.text);
        } else if (ev.type === 'done') {
          donePayload = ev;
          if (ev.text && !fullText) {
            fullText = String(ev.text);
            if (onToken) onToken(fullText);
          }
        } else if (ev.type === 'error') {
          settle(reject, new Error(String(ev.message || 'Cursor agent run failed')));
          try {
            child.kill('SIGTERM');
          } catch (_) {}
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      settle(reject, new Error(`Cursor worker spawn failed (${nodeBin}): ${err.message}`));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      if (donePayload) {
        settle(resolve, {
          text: String(donePayload.text || fullText || ''),
          model: donePayload.model || modelSelection.id,
          provider: 'cursor',
          tokensUsed:
            donePayload.tokensUsed ||
            Math.round((fullText.length + thinkingText.length) / 4),
          thinkingText: donePayload.thinkingText || thinkingText,
        });
        return;
      }
      if (getCancelled?.()) {
        settle(reject, new Error('cancelled'));
        return;
      }
      const tail = stderr.trim().slice(-400);
      settle(
        reject,
        new Error(
          `Cursor worker exited code=${code} signal=${signal || ''} ${tail}`.trim()
        )
      );
    });
  });
}

async function generateWithCursorSdkInProcess({
  apiKey,
  model,
  systemPrompt,
  prompt,
  conversationHistory,
  onToken,
  onThinkingToken,
  projectPath,
  getCancelled,
}) {
  let Agent;
  try {
    ({ Agent } = require('@cursor/sdk'));
  } catch (e) {
    throw new Error(`Cursor SDK not installed: ${e.message}`);
  }

  const key = String(apiKey || '').trim();
  if (!key) throw new Error('No API key configured for cursor');

  const cwd = String(projectPath || process.cwd() || '').trim() || process.cwd();
  const modelSelection = resolveCursorModelSelection(model);
  const message = buildCursorUserMessage(systemPrompt, prompt, conversationHistory);
  const local = createCursorLocalOptions(cwd);

  console.log(
    `[CursorSDK] in-process create model=${modelSelection.id} cwd=${cwd} store=jsonl msgLen=${message.length}`
  );

  const agent = await Agent.create({
    apiKey: key,
    model: modelSelection,
    local,
  });

  let fullText = '';
  let thinkingText = '';
  try {
    const run = await agent.send(message);
    if (typeof run.stream === 'function') {
      for await (const event of run.stream()) {
        if (getCancelled?.()) {
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
              if (onToken) onToken(block.text);
            }
          }
        } else if (type === 'thinking' || type === 'reasoning') {
          const text =
            event?.text ||
            event?.message?.content?.map?.((b) => b.text).filter(Boolean).join('') ||
            '';
          if (text) {
            thinkingText += text;
            if (onThinkingToken) onThinkingToken(text);
          }
        }
      }
      if (typeof run.wait === 'function') {
        const waited = await run.wait();
        if (waited?.status === 'error') {
          throw new Error(waited?.error?.message || 'Cursor agent run failed');
        }
        if (!fullText && waited?.result) {
          fullText = String(waited.result);
          if (onToken) onToken(fullText);
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
      const text = String(result?.result || result?.text || '');
      fullText = text;
      if (text && onToken) onToken(text);
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

  return {
    text: fullText,
    model: modelSelection.id,
    provider: 'cursor',
    tokensUsed: Math.round((fullText.length + thinkingText.length) / 4),
    thinkingText,
  };
}

/** Annotate usage-limit errors with which Cursor account owns this API key. */
async function annotateCursorError(apiKey, err) {
  const msg = String(err && err.message ? err.message : err);
  try {
    const { Cursor } = require('@cursor/sdk');
    const me = await Cursor.me({ apiKey: String(apiKey || '').trim() });
    const email = me?.userEmail || '';
    const keyName = me?.apiKeyName || '';
    if (email && /usage limit|Spend Limit|usage_limit/i.test(msg)) {
      return new Error(
        `${msg} [guIDE API key account: ${email}${keyName ? ` / key="${keyName}"` : ''}. ` +
          `That is the Agent API pool for this key — not Cursor IDE chat Auto on a different login. ` +
          `Create a crsr_ key while logged into the same account as the IDE, or set a Spend Limit at cursor.com/dashboard.]`
      );
    }
  } catch (_) {}
  return err instanceof Error ? err : new Error(msg);
}

async function generateWithCursorSdk(opts) {
  const run = async () => {
    if (process.versions.electron) {
      return generateWithCursorSdkInWorker(opts);
    }
    try {
      return await generateWithCursorSdkInWorker(opts);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      if (/spawn failed|ENOENT/i.test(msg)) {
        console.warn('[CursorSDK] worker unavailable, falling back in-process:', msg.slice(0, 160));
        return generateWithCursorSdkInProcess(opts);
      }
      throw e;
    }
  };
  try {
    return await run();
  } catch (e) {
    throw await annotateCursorError(opts.apiKey, e);
  }
}

async function listCursorModels(apiKey) {
  const { Cursor } = require('@cursor/sdk');
  const key = String(apiKey || '').trim();
  if (!key) return [];
  try {
    const models = await Cursor.models.list({ apiKey: key });
    const mapped = (models || []).map((m) => ({
      id: m.id,
      name: m.id === 'default' ? 'Auto' : m.displayName || m.name || m.id,
    }));
    mapped.sort((a, b) => {
      if (a.id === 'default') return -1;
      if (b.id === 'default') return 1;
      return String(a.name).localeCompare(String(b.name));
    });
    return mapped;
  } catch (e) {
    console.warn('[CursorSDK] models.list failed:', e.message);
    return [
      { id: 'default', name: 'Auto' },
      { id: 'composer-2.5', name: 'Composer 2.5' },
      { id: 'grok-4.6', name: 'Grok 4.6' },
    ];
  }
}

module.exports = {
  generateWithCursorSdk,
  listCursorModels,
  resolveCursorModelSelection,
  buildCursorUserMessage,
  createCursorLocalOptions,
  resolveCursorAgentStoreDir,
  resolveSystemNodeBinary,
  generateWithCursorSdkInWorker,
  annotateCursorError,
};
