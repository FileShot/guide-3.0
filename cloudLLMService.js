/**
 * guIDE Cloud LLM Service — Multi-provider cloud API integration
 * Copyright (c) 2025-2026 Brendan Gray (GitHub: FileShot)
 * All Rights Reserved. See LICENSE for terms.
 *
 * 26 providers: OpenAI, Anthropic, Google, xAI, OpenRouter, Cerebras, SambaNova,
 * Groq, Together, Fireworks, NVIDIA, Cohere, Mistral, HuggingFace, Cloudflare,
 * Perplexity, DeepSeek, AI21, DeepInfra, Hyperbolic, Novita, Moonshot, Upstage,
 * Lepton, APIFreeLLM, GraySoft.  Plus local Ollama.
 */
'use strict';

const https = require('https');
const http = require('http');
const dns = require('dns').promises;
const { EventEmitter } = require('events');
const { fitCloudHistory, messageText } = require('./tools/cloudContextFit');

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 6, timeout: 60000 });

/** ProxyNetResume1: last good A-record for graysoft.dev — used when getaddrinfo ENOTFOUND. */
const _proxyHostIpCache = new Map(); // hostname -> { ip, at }

function isTransientProxyNetError(err) {
  const msg = String(err?.message || err || '');
  const code = String(err?.code || '');
  return /ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|getaddrinfo|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|network|DNS/i.test(msg)
    || /ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT|ECONNRESET/i.test(code);
}

/** P40 queue: cipher = FAST 2B; cipher-quality = 27B worker on :18787. */
const SECRYPT_QUALITY_MODEL = 'cipher-quality';
const SECRYPT_CLOUD_PROVIDERS = new Set(['secrypt', 'cipher', 'graysoft', 'cerebras']);
const SECRYPT_LEGACY_TO_QUALITY = new Set([
  '', 'cipher', 'gpt-oss-120b', 'openai/gpt-oss-120b', 'graysoft-cloud', 'secrypt-cloud',
]);

/** Prompt size the server counted: llama `timings` (cache_n + prompt_n), else OpenAI `usage.prompt_tokens`. */
function serverPromptTokens(parsed) {
  const tm = parsed && parsed.timings;
  if (tm && (tm.prompt_n > 0 || tm.cache_n > 0)) return (tm.cache_n || 0) + (tm.prompt_n || 0);
  const u = parsed && parsed.usage;
  return u && u.prompt_tokens > 0 ? u.prompt_tokens : 0;
}

/** Non-stream chat completion JSON. Streaming clients only read `data:` lines and drop this body. */
function parseCompletionBody(raw) {
  const s = String(raw || '').trim();
  if (!s || s.startsWith('data:')) return { text: '', stopReason: null };
  try {
    const parsed = JSON.parse(s);
    const choice = parsed.choices && parsed.choices[0];
    const msg = (choice && choice.message) || {};
    const content = typeof msg.content === 'string' ? msg.content : '';
    const reasoning = typeof msg.reasoning_content === 'string'
      ? msg.reasoning_content
      : (typeof msg.reasoning === 'string' ? msg.reasoning : '');
    const stopReason = choice && choice.finish_reason != null ? String(choice.finish_reason) : null;
    return { text: String(content || reasoning || '').trim(), stopReason, promptTokens: serverPromptTokens(parsed) };
  } catch {
    return { text: '', stopReason: null };
  }
}

function textFromCompletionBody(raw) {
  return parseCompletionBody(raw).text;
}

function resolveSecryptCloudModel(provider, model) {
  if (!SECRYPT_CLOUD_PROVIDERS.has(provider)) return model;
  const id = String(model || '').trim();
  if (!id || SECRYPT_LEGACY_TO_QUALITY.has(id)) return SECRYPT_QUALITY_MODEL;
  return id;
}

/** Official HauhauCS Qwen3.8-27B Aggressive card (thinking vs instruct).
 * Source: https://huggingface.co/HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF
 * Not Qwen3.5 — Qwen3.8-27B specifically.
 */
function secryptQualitySampling(thinkingOn) {
  if (thinkingOn) {
    return {
      temperature: 1.0,
      topP: 0.95,
      topK: 20,
      minP: 0,
      presencePenalty: 0.0,
      repeatPenalty: 1.0,
      // ReasonMedium1 (operator 2026-09-30): keep medium — SampleCard1 xhigh drove
      // multi‑MB reasoning dumps / chat leaks / 900s hangs on Agent turns.
      reasoningEffort: 'medium',
    };
  }
  return {
    temperature: 0.7,
    topP: 0.8,
    topK: 20,
    minP: 0,
    presencePenalty: 1.5,
    repeatPenalty: 1.0,
    reasoningEffort: 'low',
  };
}

/**
 * EffortOnly1: Qwen / Cipher lever is reasoning_effort only (low|medium|xhigh).
 * Do NOT map effort → thinking_budget_tokens. A hard token budget cuts mid-thought
 * and fights the effort setting. Kept as a no-op export for old tests/callers.
 */
function resolveThinkingBudgetForEffort(reasoningEffort, outputTokens, thinkingOn) {
  void reasoningEffort;
  void outputTokens;
  void thinkingOn;
  return null;
}

/** Cipher-quality window. Live P40 worker target: llama-server -c 131072. Override with SECRYPT_CONTEXT_TOKENS. */
const SECRYPT_CONTEXT_DEFAULT = 131072;
const P40_WINDOWS_TTL_MS = 60 * 1000;

/**
 * Reply token budget for guIDE Cloud.
 * Auto (missing, 0, negative) uses up to 8192, and at least 4096 when the window allows.
 * A positive user cap is honored and is never silently clamped to 1024.
 */
function resolveCloudOutputTokens(requested, contextLimit) {
  const ctx = contextLimit > 0 ? contextLimit : SECRYPT_CONTEXT_DEFAULT;
  const room = Math.max(256, ctx - 512);
  if (typeof requested === 'number' && requested > 0) {
    return Math.min(requested, room);
  }
  const floor = Math.min(4096, room);
  const auto = Math.min(8192, room);
  return Math.max(floor, auto);
}

// ─── Provider endpoint map ────────────────────────────────────────────────────
const ENDPOINTS = {
  graysoft:    { host: 'graysoft.dev',                    path: '/api/ai/proxy' },
  secrypt:     { host: 'graysoft.dev',                    path: '/api/ai/proxy' },
  cipher:      { host: 'graysoft.dev',                    path: '/api/ai/proxy' },
  openai:      { host: 'api.openai.com',                  path: '/v1/chat/completions' },
  anthropic:   { host: 'api.anthropic.com',               path: '/v1/messages' },
  google:      { host: 'generativelanguage.googleapis.com', path: '/v1beta/openai/chat/completions' },
  xai:         { host: 'api.x.ai',                        path: '/v1/chat/completions' },
  groq:        { host: 'api.groq.com',                    path: '/openai/v1/chat/completions' },
  openrouter:  { host: 'openrouter.ai',                   path: '/api/v1/chat/completions' },
  apifreellm:  { host: 'apifreellm.com',                  path: '/api/v1/chat' },
  cerebras:    { host: 'api.cerebras.ai',                 path: '/v1/chat/completions' },
  sambanova:   { host: 'api.sambanova.ai',                path: '/v1/chat/completions' },
  together:    { host: 'api.together.xyz',                path: '/v1/chat/completions' },
  fireworks:   { host: 'api.fireworks.ai',                path: '/inference/v1/chat/completions' },
  nvidia:      { host: 'integrate.api.nvidia.com',        path: '/v1/chat/completions' },
  cohere:      { host: 'api.cohere.ai',                   path: '/compatibility/v1/chat/completions' },
  mistral:     { host: 'api.mistral.ai',                  path: '/v1/chat/completions' },
  huggingface: { host: 'router.huggingface.co',           path: '/v1/chat/completions' },
  cloudflare:  { host: 'api.cloudflare.com',              path: null },
  perplexity:  { host: 'api.perplexity.ai',               path: '/chat/completions' },
  deepseek:    { host: 'api.deepseek.com',                path: '/v1/chat/completions' },
  ai21:        { host: 'api.ai21.com',                    path: '/studio/v1/chat/completions' },
  deepinfra:   { host: 'api.deepinfra.com',               path: '/v1/openai/chat/completions' },
  hyperbolic:  { host: 'api.hyperbolic.xyz',              path: '/v1/chat/completions' },
  novita:      { host: 'api.novita.ai',                   path: '/v3/openai/chat/completions' },
  moonshot:    { host: 'api.moonshot.cn',                  path: '/v1/chat/completions' },
  upstage:     { host: 'api.upstage.ai',                  path: '/v1/chat/completions' },
  lepton:      { host: 'emc.lepton.run',                  path: '/api/v1/chat/completions' },
  // cursor: uses @cursor/sdk (see cursorCloudProvider.js) — no OpenAI chat path
};

// ─── Provider labels ──────────────────────────────────────────────────────────
const PROVIDER_LABELS = {
  graysoft: 'Secrypt (Cipher)', secrypt: 'Secrypt (Cipher)', cipher: 'Secrypt (Cipher)',
  openai: 'OpenAI', anthropic: 'Anthropic',
  google: 'Google Gemini', xai: 'xAI Grok', openrouter: 'OpenRouter',
  groq: 'Groq', apifreellm: 'APIFreeLLM', cerebras: 'Cerebras',
  sambanova: 'SambaNova', together: 'Together AI', fireworks: 'Fireworks AI',
  nvidia: 'NVIDIA NIM', cohere: 'Cohere', mistral: 'Mistral AI',
  huggingface: 'Hugging Face', cloudflare: 'Cloudflare Workers AI',
  perplexity: 'Perplexity', deepseek: 'DeepSeek', ai21: 'AI21 Labs',
  deepinfra: 'DeepInfra', hyperbolic: 'Hyperbolic', novita: 'Novita AI',
  moonshot: 'Moonshot AI', upstage: 'Upstage', lepton: 'Lepton AI',
  cursor: 'Cursor',
  ollama: 'Ollama (Local)',
};

// ─── Provider model catalogs ─────────────────────────────────────────────────
const PROVIDER_MODELS = {
  graysoft: [
    { id: 'cipher-quality', name: 'Secrypt Cipher Quality (P40 27B)' },
    { id: 'cipher-fast', name: 'Secrypt Cipher Fast (P40 2B)' },
  ],
  secrypt: [
    { id: 'cipher-quality', name: 'Secrypt Cipher Quality (P40 27B)' },
    { id: 'cipher-fast', name: 'Secrypt Cipher Fast (P40 2B)' },
  ],
  cipher: [
    { id: 'cipher-quality', name: 'Secrypt Cipher Quality (P40 27B)' },
    { id: 'cipher-fast', name: 'Secrypt Cipher Fast (P40 2B)' },
  ],
  openai: [
    { id: 'gpt-4.1', name: 'GPT-4.1 (Flagship)' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
    { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku (Fast)' },
  ],
  google: [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro (Free)' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (Free)' },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash (Free)' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite (Free)' },
    { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash-Lite (Free)' },
    { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview (Free)' },
  ],
  xai: [
    { id: 'grok-3', name: 'Grok 3' },
    { id: 'grok-3-mini', name: 'Grok 3 Mini' },
  ],
  openrouter: [
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (Free)' },
    { id: 'mistralai/mistral-small-3.1-24b-instruct:free', name: 'Mistral Small 3.1 (Free)' },
  ],
  apifreellm: [
    { id: 'apifreellm', name: 'APIFreeLLM 200B+ (Free)' },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B (Free, 12K TPM, Default)' },
    { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', name: 'Llama 4 Maverick 17B (Free)' },
    { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B (Free, 30K TPM)' },
    { id: 'moonshotai/kimi-k2-instruct-0905', name: 'Kimi K2 131K (Free, Moonshot AI)' },
    { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B (Free)' },
    { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B (Free, 1000 tps)' },
    { id: 'qwen/qwen3-32b', name: 'Qwen 3 32B (Free)' },
    { id: 'groq/compound', name: 'Groq Compound (Agentic, Tools)' },
    { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant (Free, 14K RPM)' },
  ],
  cerebras: [
    { id: 'gpt-oss-120b', name: 'GPT-OSS 120B (Free, Default, ~3000 tok/s)' },
  ],
  sambanova: [
    { id: 'Meta-Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B (Free, Default)' },
    { id: 'DeepSeek-V3.1', name: 'DeepSeek V3.1 (Free)' },
    { id: 'DeepSeek-R1-0528', name: 'DeepSeek R1 Reasoning (Free)' },
    { id: 'Llama-4-Maverick-17B-128E-Instruct', name: 'Llama 4 Maverick 17B (Free)' },
    { id: 'Qwen3-32B', name: 'Qwen 3 32B (Free)' },
    { id: 'gpt-oss-120b', name: 'GPT-OSS 120B (Free)' },
  ],
  together: [
    { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B Turbo' },
    { id: 'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo', name: 'Llama 3.1 405B Turbo' },
    { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1' },
    { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', name: 'Qwen 2.5 72B Turbo' },
    { id: 'mistralai/Mixtral-8x22B-Instruct-v0.1', name: 'Mixtral 8x22B' },
    { id: 'google/gemma-2-27b-it', name: 'Gemma 2 27B' },
  ],
  fireworks: [
    { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', name: 'Llama 3.3 70B' },
    { id: 'accounts/fireworks/models/deepseek-r1', name: 'DeepSeek R1' },
    { id: 'accounts/fireworks/models/qwen2p5-72b-instruct', name: 'Qwen 2.5 72B' },
  ],
  nvidia: [
    { id: 'meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B (Free)' },
    { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (Free)' },
    { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B (Free)' },
    { id: 'qwen/qwq-32b', name: 'QWQ 32B Reasoning (Free)' },
  ],
  cohere: [
    { id: 'command-a-03-2025', name: 'Command A (Free, Flagship)' },
    { id: 'command-r-plus', name: 'Command R+ (Free)' },
    { id: 'command-r', name: 'Command R (Free)' },
    { id: 'command-r7b-12-2024', name: 'Command R 7B (Free, Fast)' },
  ],
  mistral: [
    { id: 'mistral-small-latest', name: 'Mistral Small 3.2 (Free)' },
    { id: 'mistral-large-latest', name: 'Mistral Large 3 (Free)' },
    { id: 'magistral-medium-2509', name: 'Magistral Medium 1.2 (Reasoning)' },
    { id: 'magistral-small-2509', name: 'Magistral Small 1.2 (Reasoning)' },
    { id: 'ministral-8b-latest', name: 'Ministral 8B (Free, Fast)' },
    { id: 'devstral-small-latest', name: 'Devstral Small (Code Agents)' },
    { id: 'mistral-nemo', name: 'Mistral Nemo 12B (Free)' },
    { id: 'pixtral-12b-2409', name: 'Pixtral 12B Vision (Free)' },
  ],
  huggingface: [
    { id: 'deepseek-ai/DeepSeek-V3-0324', name: 'DeepSeek V3 (Free)' },
    { id: 'Qwen/Qwen3-235B-A22B', name: 'Qwen3 235B (Free)' },
    { id: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B (Free)' },
    { id: 'mistralai/Mistral-Small-3.1-24B-Instruct-2503', name: 'Mistral Small 3.1 (Free)' },
  ],
  cloudflare: [
    { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B (Free)' },
    { id: '@cf/qwen/qwq-32b', name: 'QWQ 32B Reasoning (Free)' },
    { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', name: 'DeepSeek R1 Distill 32B (Free)' },
    { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', name: 'Mistral Small 3.1 (Free)' },
    { id: '@cf/google/gemma-3-12b-it', name: 'Gemma 3 12B (Free)' },
  ],
  perplexity: [
    { id: 'sonar-pro', name: 'Sonar Pro (Web Search)' },
    { id: 'sonar', name: 'Sonar (Web Search, Fast)' },
    { id: 'sonar-reasoning-pro', name: 'Sonar Reasoning Pro' },
    { id: 'sonar-reasoning', name: 'Sonar Reasoning' },
    { id: 'r1-1776', name: 'R1-1776 (Offline, No Search)' },
  ],
  deepseek: [
    { id: 'deepseek-chat', name: 'DeepSeek V3 (Flagship)' },
    { id: 'deepseek-reasoner', name: 'DeepSeek R1 (Reasoning)' },
  ],
  ai21: [
    { id: 'jamba-2.5', name: 'Jamba 2.5 (256K context)' },
    { id: 'jamba-2.5-mini', name: 'Jamba 2.5 Mini (256K, Fast)' },
  ],
  deepinfra: [
    { id: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B' },
    { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3' },
    { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1 (Reasoning)' },
    { id: 'Qwen/Qwen3-235B-A22B', name: 'Qwen3 235B MoE' },
    { id: 'Qwen/QwQ-32B', name: 'QwQ 32B Reasoning' },
  ],
  hyperbolic: [
    { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3' },
    { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1 (Reasoning)' },
    { id: 'Qwen/Qwen3-235B-A22B', name: 'Qwen3 235B MoE' },
    { id: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B' },
  ],
  novita: [
    { id: 'deepseek/deepseek-v3-0324', name: 'DeepSeek V3' },
    { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (Reasoning)' },
    { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B' },
    { id: 'qwen/qwen3-235b-a22b', name: 'Qwen3 235B MoE' },
  ],
  moonshot: [
    { id: 'moonshot-v1-8k', name: 'Moonshot v1 8K' },
    { id: 'moonshot-v1-32k', name: 'Moonshot v1 32K' },
    { id: 'moonshot-v1-128k', name: 'Moonshot v1 128K' },
    { id: 'kimi-k2', name: 'Kimi K2 (Agentic)' },
  ],
  upstage: [
    { id: 'solar-pro2', name: 'Solar Pro 2 (Flagship)' },
    { id: 'solar-mini-ja', name: 'Solar Mini' },
  ],
  lepton: [
    { id: 'llama3-3-70b', name: 'Llama 3.3 70B' },
    { id: 'deepseek-r1', name: 'DeepSeek R1 (Reasoning)' },
    { id: 'qwen3-235b', name: 'Qwen3 235B MoE' },
  ],
  cursor: [
    { id: 'default', name: 'Auto' },
    { id: 'composer-2.5', name: 'Composer 2.5' },
    { id: 'grok-4.6', name: 'Grok 4.6' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
    { id: 'gemini-3-flash', name: 'Gemini 3 Flash' },
  ],
};

// ─── Context window limits (tokens) ──────────────────────────────────────────
const CONTEXT_LIMITS = {
  'gpt-4.1': 1047576, 'gpt-4.1-mini': 1047576,
  'gpt-4o': 128000, 'gpt-4o-mini': 128000, 'gpt-4-turbo': 128000,
  'claude-sonnet-4-20250514': 200000, 'claude-3-5-sonnet-20241022': 200000, 'claude-3-haiku-20240307': 200000,
  'gemini-2.5-pro': 1048576, 'gemini-2.5-flash': 1048576, 'gemini-2.0-flash': 1048576,
  'gemini-2.5-flash-lite': 1048576, 'gemini-2.0-flash-lite': 1048576, 'gemini-3-flash-preview': 1048576,
  'grok-3': 131072, 'grok-3-mini': 131072,
  'llama-3.3-70b-versatile': 32768, 'llama-3.1-8b-instant': 8192,
  'meta-llama/llama-4-maverick-17b-128e-instruct': 131072,
  'meta-llama/llama-4-scout-17b-16e-instruct': 131072,
  'moonshotai/kimi-k2-instruct': 131072,
  'openai/gpt-oss-120b': 32768, 'qwen/qwen3-32b': 32768,
  'gpt-oss-120b': 32768,
  'DeepSeek-V3.2': 65536, 'DeepSeek-V3.1': 65536, 'Meta-Llama-3.3-70B-Instruct': 8192,
  'DeepSeek-R1-0528': 65536, 'Qwen3-235B': 32768, 'Qwen3-32B': 32768,
  'Llama-4-Maverick-17B-128E-Instruct': 131072, 'MiniMax-M2.5': 65536,
  'command-a-03-2025': 256000, 'command-r-plus': 128000, 'command-r': 128000, 'command-r7b-12-2024': 128000,
  'mistral-small-latest': 32768, 'mistral-large-latest': 131072,
  'ministral-8b-latest': 131072, 'mistral-nemo': 131072, 'pixtral-12b-2409': 131072,
  'sonar-pro': 127072, 'sonar': 127072, 'sonar-reasoning-pro': 127072,
  'sonar-reasoning': 127072, 'r1-1776': 128000,
  'deepseek-chat': 65536, 'deepseek-reasoner': 65536,
  'jamba-2.5': 262144, 'jamba-2.5-mini': 262144,
  'moonshot-v1-8k': 8192, 'moonshot-v1-32k': 32768, 'moonshot-v1-128k': 131072, 'kimi-k2': 131072,
  'solar-pro2': 32768, 'solar-mini-ja': 32768,
};

// ─── Vision-capable models per provider ──────────────────────────────────────
const VISION_MODELS = {
  openai: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  anthropic: ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307'],
  google: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-3-flash-preview'],
  xai: ['grok-3', 'grok-3-mini'],
  openrouter: ['google/gemini-2.0-flash-exp:free'],
  mistral: ['pixtral-12b-2409'],
  // Qwen3.8-27B on P40 (cipher-quality) is multimodal — route images through Secrypt proxy.
  secrypt: ['cipher-quality', 'cipher'],
  cipher: ['cipher-quality', 'cipher'],
  graysoft: ['cipher-quality', 'cipher', 'graysoft-cloud'],
};

/** OpenAI-style multimodal user content parts for proxy / chat completions. */
function buildImageContentParts(images) {
  if (!Array.isArray(images) || images.length === 0) return [];
  return images.map((img) => {
    const raw = typeof img === 'string' ? img : (img?.data || img?.dataUrl || '');
    const mime = (typeof img === 'object' && img?.mimeType) ? img.mimeType : 'image/png';
    const url = String(raw || '').startsWith('data:')
      ? String(raw)
      : `data:${mime};base64,${raw}`;
    return { type: 'image_url', image_url: { url } };
  }).filter((p) => p.image_url && p.image_url.url && p.image_url.url !== 'data:image/png;base64,');
}

// ─── Fallback order + preferred fallback models ──────────────────────────────
const FALLBACK_ORDER = ['secrypt', 'sambanova', 'google', 'nvidia', 'cohere', 'mistral',
  'huggingface', 'cloudflare', 'together', 'fireworks', 'openrouter', 'groq'];

const PREFERRED_FALLBACK_MODEL = {
  secrypt:    'cipher-quality',
  graysoft:   'cipher-quality',
  sambanova:  'Meta-Llama-3.3-70B-Instruct',
  openrouter: 'meta-llama/llama-3.3-70b-instruct:free',
  groq:       'llama-3.3-70b-versatile',
  google:     'gemini-2.5-flash',
};

// ─── Default RPM per-key estimates for free tiers ────────────────────────────
const DEFAULT_RPM = {
  groq: 30, sambanova: 10, google: 15,
  openrouter: 20, openai: 3, anthropic: 5, xai: 60,
};

// ─── Bundled key constants ───────────────────────────────────────────────────
// guIDE Cloud uses Secrypt (P40) via graysoft.dev/api/ai/proxy — Cerebras is BYOK only.
const BUNDLED_PROVIDERS = new Set(['groq', 'sambanova', 'google', 'openrouter']);

const BUNDLED_KEYS = {
  groq:       'PSkxBSo0Fg4QaREdEgstG21qajwdFi9jDR0+IzhpHAMAbTkoChQUHx4vEiMjaRIYMAoKAzIVDWI=',
  sambanova:  'Ozs/Pj9tOG53bmxoP3duaWhqdztrbmx3bTg8OG0+az9jbmlr',
  google:     'GxMgOwkjGDAKAgwSYygiKCBoETssDz4wGxcVKw4WFR0MIxQoFhwD',
  openrouter: 'KTF3NSh3LGt3bm1rP2xjYzs8az4/O2JrOD8+ajs8bm5tOz5ibTg/bWJvY2pvPGlpb2lrPmlpbGJja21pOT5qbjloaTs4Pz48Pg==',
};

const CEREBRAS_POOL_KEYS = [
  'OSkxdzRvNDwuNyNpNz8/OSMqIm8jMDwtLSMxaCwtPi1jLSxiOWI/OWMqLTIxbzQyKGM5NA==',
  'OSkxd2gqNDQtPzdpLixiPDEsaShpYiMoaG8/aTI8b2NjaSNvLDRiI2w/NDRvLC40LCJibw==',
  'OSkxdy45PDwxMm4qLSJjKixoPDE0PjFuPi4saDciKi4qbC5sPzFvPD8uYzkyPyM0OWMyaA==',
  'OSkxdzdsaDwtYi0uPjJsPCJuPD8wMSoiOWIyLjQibCJoPDcuNz40YmI+I2JjaGkjLSMwPw==',
  'OSkxdzkyMTIyMCIqMDI0LippY2JpLjIoaGJvKDEwNG8jLWhvN25iLW8uIjFiPzQ+aCo3Yg==',
  'OSkxd2lsYyg/KGkyaT4wLigjbD5uP2g/LTc5aC4xOSpvMjk+LiI5LCoqKDAwYio3KmwyNA==',
  'OSkxdzwxLG4jaDcxMGJoMiwqPy0iPjkoOTkoKDRjYmJvIyowMGkib24wMi5ibDksaTxuLA==',
  'OSkxd2lpIm5oKDcxKGluaS1uPzdsOTRjPz4iLioxPDxuPzwsLmluPD8tY2MobGgyPzI5Nw==',
  'OSkxd2I0LjA+KGk+Py1pImIqLG8sOSI+Py1jNz9jMTciPD4iKDc3LSM5Ii4/Km8wMDwsaA==',
  'OSkxdzIyPzI0bjRvbzkuLT5sMWljPC40b2g8P25sLS0sbzdsN2IxIjEyPzk5MD83LC1sLg==',
  'OSkxd2w0MjkwYmhibigobDE+NzkwbCNuaCJjMiNsbGJuY2M/LmxjN28jPjw8Kj5jPGM5bg==',
  'OSkxdzlobzQ3PiwuOTQqN283Mi00KjIuKixjMj9pIippIzE+IjQtbGI3IzkjbD8uN28xIg==',
  'OSkxdzdubzxoLSosMWw8OSIxaCMtLjQ+MjEjPj5jbm4yLi5ubzJpYyosaCxoNDE+OS5jMg==',
  'OSkxd2gwKigiaD85LjwxPCguLCxpbC4wLi1jMihoaSIqaTQsPzI0aWg0PjkjP2IxOSJvIg==',
  'OSkxd2ljLDk3NCpsNGg8Yi0+YjIoPDxsPjE+LCIibCo0aCgtMSo3Yj8qPz8/PGNjIj43LQ==',
  'OSkxd29iPC40b2MsKCMxPy4yN24uYipub2wqLGkxYj8yLD8yPz4+bDxpaCM3Kj4sYywjOQ==',
  'OSkxd28qKiIuYiwtYiwtbmhpIjEiMGw3Yz4yPChvYjc+LipuaW40KCI+MTdpbyxjbyhiPw==',
  'OSkxdz8taDkxLm4jbz9jLDluNy0wbDc5OWIyLGwwMm9jKDxvLG4iIypoPC03MSJjND9jMQ==',
];

const GROQ_POOL_KEYS = [
  'PSkxBSo0Fg4QaREdEgstG21qajwdFi9jDR0+IzhpHAMAbTkoChQUHx4vEiMjaRIYMAoKAzIVDWI=',
  'PSkxBTZjYhUuGRsRPh0DID5uKj4vMzUwDR0+IzhpHAMMHT0gOGMRKiseLDYQEzYDGCMTLWJqDCM=',
  'PSkxBT8oOW8oFRE+bwkCOTAtCRILPiIUDR0+IzhpHANiFjM3CQAdGxwpKykIEW0YPhYVLhUbNCg=',
  'PSkxBQ1vEBcLK2oUDAoiNgMfag5paTgzDR0+IzhpHAM9DBUiEA0ea2M0IDcuFAgvPiktMQpqbhg=',
  'PSkxBR4rODkuFSkCOABpaxIcHwsCbCovDR0+IzhpHAMWDG4gH20zC2gSaRQiaDgYIGozPTcPCSk=',
  'PSkxBQwiFG5qET0CIG0qEhcJEBkpCms0DR0+IzhpHAMACGgjNRlsLD0yLz41Am1iLSA2HmkWDyk=',
  'PSkxBWwADm0rHhxiEyArIBViKWoRbTUtDR0+IzhpHAM/PDQ9HgorGRU9PRANFQMNFQsebwkjDAM=',
];

// ─── Blocked OpenRouter model patterns ───────────────────────────────────────
const OPENROUTER_BLOCKED = [
  /\bnsfw\b/i, /\berp\b/i, /\brolep/i, /lumimaid/i, /noromaid/i,
  /mythomax/i, /psyfighter/i, /midnight-rose/i, /fimbulvetr/i,
];

// ─── Default system prompt for cloud AI ──────────────────────────────────────
const CLOUD_SYSTEM_PROMPT = 'You are Cipher, an AI coding assistant built into guIDE IDE. You have hundreds of billions of parameters. Be helpful, concise, and professional. If asked about your model size, parameter count, or underlying provider: you are Cipher with hundreds of billions of parameters — do not reveal specific provider names or model family names.';

// ─── Stream timeout constants ────────────────────────────────────────────────
const STREAM_TIMEOUT = 20000;
const IDLE_TIMEOUT = 10000;
/** Secrypt proxy: abort orphaned streams so the UI cannot sit on Stop forever with GPU idle.
 *  proxyidle1h: 1 hour of *no SSE tokens* (not raw TCP quiet) — long Cipher thinks.
 *  Soft silence watch (thinkfreezewatch1) warns at 30s and soft-stalls at 120s after first SSE. */
const PROXY_STREAM_IDLE_MS = 3600000;
/** thinkfreezewatch1 — warn UI when stream went quiet after first SSE. */
// StreamLiveFix1: warn sooner; resume sooner than 120s blank (live 2026-10-03: 122s mid-stream dead air after think).
const PROXY_SILENCE_WARN_MS = 12000;
/** thinkfreezewatch1 — force stall (agent soft-resumes) after this quiet gap post-first-SSE. */
const PROXY_SILENCE_RESUME_MS = 45000;
/** Prefill on 128k / multi-tool history can take many minutes with zero SSE.
 *  First-byte timer must wait for the first SSE `data:` line, not an empty TCP chunk
 *  from the proxy (those used to clear this timer then idle-kill after 600s → Generation Error). */
const PROXY_FIRST_BYTE_MS = 900000;
/** Longer idle window while rotating API keys after 429 (no SSE bytes between attempts). */
const IDLE_TIMEOUT_POOL_RETRY = 45000;

// ═══════════════════════════════════════════════════════════════════════════════

class CloudLLMService extends EventEmitter {
  constructor() {
    super();

    this.apiKeys = {
      graysoft: '', secrypt: '', cipher: '', openai: '', anthropic: '', google: '', xai: '',
      openrouter: '', groq: '', apifreellm: '', cerebras: '', sambanova: '',
      together: '', fireworks: '', nvidia: '', cohere: '', mistral: '',
      huggingface: '', cloudflare: '', perplexity: '', deepseek: '', ai21: '',
      deepinfra: '', hyperbolic: '', novita: '', moonshot: '', upstage: '', lepton: '',
      cursor: '',
    };

    this.activeProvider = null;
    this.activeModel = 'cipher-quality';

    this._openRouterModelsCache = null;
    this._openRouterModelsFetchedAt = 0;

    this._rateLimitedUntil = {};
    this._keyPools = {};
    this._keyPoolIndex = {};
    /** Providers that keep the same pool key until limit/cooldown (Cursor). */
    this._stickyPoolProviders = new Set(['cursor']);
    this._recent429Timestamps = [];
    this._requestTimestamps = {};
    this._providerRPMPerKey = {};
    this._defaultRPMPerKey = { ...DEFAULT_RPM };
    /** Optional CursorKeyPool instance (set from electron-main). */
    this._cursorKeyPool = null;

    this._apifreellmLastRequest = 0;
    this._cloudflareAccountId = '';
    this._licenseManager = null;
    this._userOwnedProviders = new Set();
    /** Per-request window of each P40 model id for this account, from secrypt.space /v1/models. */
    this._p40Windows = null;
    this._p40WindowsAt = 0;
    this._p40WindowsLoad = null;

    this._ollamaAvailable = null;
    this._ollamaModels = [];
    this._ollamaLastCheck = 0;

    this._seedBundledKeys();
  }

  // ─── License manager ────────────────────────────────────────────────────────

  setLicenseManager(lm) { this._licenseManager = lm; }

  // ─── P40 model windows ──────────────────────────────────────────────────────

  /** Reads the window the proxy routes this account to for each model id (llama n_ctx per slot). */
  loadP40Windows() {
    if (this._p40Windows && Date.now() - this._p40WindowsAt < P40_WINDOWS_TTL_MS) return Promise.resolve(this._p40Windows);
    if (this._p40WindowsLoad) return this._p40WindowsLoad;
    const token = this._licenseManager?.getSessionToken?.() || null;
    this._p40WindowsLoad = new Promise((resolve) => {
      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const req = https.request({ host: 'secrypt.space', path: '/v1/models', method: 'GET', headers, timeout: 5000 }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
            const windows = {};
            for (const row of JSON.parse(raw).data || []) {
              const n = Number(row && row.context_length);
              if (row && row.id && Number.isInteger(n) && n > 0) windows[String(row.id).toLowerCase()] = n;
            }
            if (Object.keys(windows).length) {
              const changed = JSON.stringify(windows) !== JSON.stringify(this._p40Windows);
              this._p40Windows = windows;
              this._p40WindowsAt = Date.now();
              if (changed) console.log(`[CloudLLM] P40 windows ${JSON.stringify(windows)}`);
            }
          } catch (e) {
            console.warn(`[CloudLLM] P40 windows unreadable: ${e.message}`);
          }
          resolve(this._p40Windows);
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => {
        console.warn(`[CloudLLM] P40 windows fetch failed: ${e.message}`);
        resolve(this._p40Windows);
      });
      req.end();
    }).finally(() => { this._p40WindowsLoad = null; });
    return this._p40WindowsLoad;
  }

  // ─── Bundled key management ─────────────────────────────────────────────────

  _isBundledProvider(provider) {
    return BUNDLED_PROVIDERS.has(provider);
  }

  _seedBundledKeys() {
    const xorKey = 0x5A;
    const decode = (encoded) => Buffer.from(Buffer.from(encoded, 'base64').map(b => b ^ xorKey)).toString();

    try {
      for (const [provider, encoded] of Object.entries(BUNDLED_KEYS)) {
        if (!this.apiKeys[provider] || !this.apiKeys[provider].trim()) {
          this.apiKeys[provider] = decode(encoded);
        }
      }
      // Cerebras pool intentionally not seeded — guIDE Cloud is Secrypt only.
      for (const encoded of GROQ_POOL_KEYS) {
        this.addKeyToPool('groq', decode(encoded));
      }
      console.log('[CloudLLM] Bundled free-tier pools seeded (Secrypt Cloud primary; no Cerebras bundle)');
    } catch (e) {
      console.warn('[CloudLLM] Key seed error:', e.message);
    }
  }

  // ─── Request tracking + RPM pacing ──────────────────────────────────────────

  _recordRequest(provider) {
    if (!this._requestTimestamps[provider]) this._requestTimestamps[provider] = [];
    this._requestTimestamps[provider].push(Date.now());
  }

  _learnRPMFromHeaders(provider, headers) {
    if (!headers) return;
    const limitStr = headers['x-ratelimit-limit-requests']
      || headers['ratelimit-limit']
      || headers['x-ratelimit-limit-requests-minute'];
    if (!limitStr) return;

    const limit = parseInt(limitStr, 10);
    if (limit > 0 && limit < 10000) {
      const prev = this._providerRPMPerKey[provider];
      this._providerRPMPerKey[provider] = limit;
      if (prev !== limit) {
        console.log(`[CloudLLM] Learned ${provider} RPM/key = ${limit} (was ${prev || 'default'})`);
      }
    }
  }

  _getPerKeyRPM(provider) {
    return this._providerRPMPerKey[provider]
      || this._defaultRPMPerKey[provider]
      || 30;
  }

  getProactivePaceMs(provider) {
    const perKeyRPM = this._getPerKeyRPM(provider);
    const poolSize = this._keyPools[provider]?.length || 1;
    const totalRPM = perKeyRPM * poolSize;
    const targetRPM = totalRPM * 0.85;
    const minIntervalMs = 60000 / targetRPM;

    const stamps = this._requestTimestamps[provider] || [];
    const now = Date.now();
    const oneMinAgo = now - 60000;
    const recentStamps = stamps.filter(t => t > oneMinAgo);
    this._requestTimestamps[provider] = recentStamps;

    const recentCount = recentStamps.length;
    if (recentCount >= targetRPM) {
      const oldestRecent = recentStamps[0];
      const msUntilSlotFrees = (oldestRecent + 60000) - now;
      return Math.max(msUntilSlotFrees, minIntervalMs);
    }

    if (recentCount > 0) {
      const lastRequestMs = recentStamps[recentStamps.length - 1];
      const elapsed = now - lastRequestMs;
      if (elapsed < minIntervalMs) return minIntervalMs - elapsed;
    }

    return 0;
  }

  getRecommendedPaceMs(provider) {
    const now = Date.now();
    this._recent429Timestamps = this._recent429Timestamps.filter(t => now - t < 120000);
    const recent429Count = this._recent429Timestamps.length;

    if (recent429Count === 0) return 0;
    if (recent429Count <= 2) return 2000;
    if (recent429Count <= 5) return 5000;
    return 10000;
  }

  // ─── API key management ─────────────────────────────────────────────────────

  setApiKey(provider, key) {
    if (provider === 'cloudflare' && key && key.includes(':')) {
      const [accountId, token] = key.split(':');
      this._cloudflareAccountId = accountId;
      this.apiKeys.cloudflare = token;
    } else {
      this.apiKeys[provider] = key || '';
    }
    if (key && key.trim()) {
      this._userOwnedProviders.add(provider);
    }
  }

  isUsingOwnKey(provider) {
    return this._userOwnedProviders.has(provider);
  }

  // ─── Key pool management ────────────────────────────────────────────────────

  addKeyToPool(provider, key) {
    if (!this._keyPools[provider]) this._keyPools[provider] = [];
    if (this._keyPools[provider].some(e => e.key === key)) return;
    this._keyPools[provider].push({ key, cooldownUntil: 0, disabled: false });
    if (!this._keyPoolIndex[provider]) this._keyPoolIndex[provider] = 0;
    if (!this.apiKeys[provider] || !this.apiKeys[provider].trim()) {
      this.apiKeys[provider] = key;
    }
  }

  _getPoolKey(provider) {
    const pool = this._keyPools[provider];
    if (!pool || pool.length === 0) return null;

    const now = Date.now();
    const startIdx = this._keyPoolIndex[provider] || 0;

    // Sticky: stay on current key until it is cooling/disabled, then advance once.
    if (this._stickyPoolProviders.has(provider)) {
      for (let i = 0; i < pool.length; i++) {
        const idx = (startIdx + i) % pool.length;
        if (pool[idx].disabled) continue;
        if (pool[idx].cooldownUntil > now) continue;
        if (idx !== startIdx) {
          this._keyPoolIndex[provider] = idx;
          console.log(
            `[CloudLLM] sticky ${provider} advanced idx ${startIdx}→${idx} (...${String(pool[idx].key).slice(-4)})`
          );
        }
        return pool[idx].key;
      }
      let earliest = pool[0];
      for (let i = 1; i < pool.length; i++) {
        if (pool[i].cooldownUntil < earliest.cooldownUntil) earliest = pool[i];
      }
      return earliest.key;
    }

    for (let i = 0; i < pool.length; i++) {
      const idx = (startIdx + i) % pool.length;
      if (pool[idx].disabled) continue;
      if (pool[idx].cooldownUntil <= now) {
        this._keyPoolIndex[provider] = (idx + 1) % pool.length;
        return pool[idx].key;
      }
    }

    let earliest = pool[0];
    for (let i = 1; i < pool.length; i++) {
      if (pool[i].cooldownUntil < earliest.cooldownUntil) earliest = pool[i];
    }
    return earliest.key;
  }

  _cooldownPoolKey(provider, key, durationMs) {
    const pool = this._keyPools[provider];
    if (!pool) return;
    const entry = pool.find(e => e.key === key);
    if (entry) entry.cooldownUntil = Date.now() + durationMs;
  }

  _disablePoolKey(provider, key, reason) {
    const pool = this._keyPools[provider];
    if (!pool) return;
    const entry = pool.find(e => e.key === key);
    if (entry && !entry.disabled) {
      entry.disabled = true;
      console.warn(`[CloudLLM] Disabled ${provider} key ...${key.slice(-6)} (${reason})`);
    }
  }

  getPoolStatus(provider) {
    const pool = this._keyPools[provider];
    if (!pool) return { total: 0, available: 0, onCooldown: 0 };
    const now = Date.now();
    const available = pool.filter(e => !e.disabled && e.cooldownUntil <= now).length;
    const disabled = pool.filter(e => e.disabled).length;
    return { total: pool.length, available, onCooldown: pool.length - available - disabled, disabled };
  }

  // ─── Provider catalog ───────────────────────────────────────────────────────

  getConfiguredProviders() {
    const { isCursorAdmin } = require('./cursorAdminGate');
    const allowCursor = isCursorAdmin({
      licenseManager: this._licenseManager,
    });
    const providers = [];
    for (const [provider, key] of Object.entries(this.apiKeys)) {
      if (provider === 'cursor_pool') continue;
      if (provider === 'cursor' && !allowCursor) continue;
      if (key && key.trim()) {
        providers.push({ provider, label: PROVIDER_LABELS[provider] || provider });
      }
    }
    // Secrypt Cipher always listed as guIDE Cloud (P40 via graysoft /api/ai/proxy)
    if (!providers.find(p => p.provider === 'secrypt')) {
      providers.unshift({ provider: 'secrypt', label: PROVIDER_LABELS.secrypt || 'Secrypt (Cipher)' });
    }
    const sessionToken = this._licenseManager?.getSessionToken();
    if (sessionToken && !providers.find(p => p.provider === 'graysoft')) {
      providers.push({ provider: 'graysoft', label: PROVIDER_LABELS['graysoft'] || 'Secrypt (Cipher)' });
    }
    if (this._ollamaAvailable) {
      providers.push({ provider: 'ollama', label: 'Ollama (Local)' });
    }
    return providers;
  }

  getAllProviders() {
    const { isCursorAdmin } = require('./cursorAdminGate');
    const allowCursor = isCursorAdmin({
      licenseManager: this._licenseManager,
    });
    return Object.entries(PROVIDER_LABELS)
      .filter(([p]) => p !== 'ollama')
      .filter(([p]) => (p === 'cursor' ? allowCursor : true))
      .map(([provider, label]) => ({
        provider,
        label,
        hasKey: !!(this.apiKeys[provider] && this.apiKeys[provider].trim()),
        isFree: BUNDLED_PROVIDERS.has(provider),
        adminOnly: provider === 'cursor',
      }));
  }

  _getProviderLabel(provider) {
    return PROVIDER_LABELS[provider] || provider;
  }

  _getProviderModels(provider) {
    return PROVIDER_MODELS[provider] || [];
  }

  _getEndpoint(provider) {
    const ep = ENDPOINTS[provider];
    if (!ep) return null;
    if (provider === 'cloudflare') {
      return {
        host: ep.host,
        path: `/client/v4/accounts/${this._cloudflareAccountId || 'ACCOUNT_ID'}/ai/v1/chat/completions`,
      };
    }
    return ep;
  }

  _supportsVision(provider, model) {
    if (provider === 'ollama') {
      return /llava|bakllava|qwen.*vl|minicpm.*v|moondream|internvl|cogvlm|-vl\b|\.vision\b|vision-/i.test(model);
    }
    // Secrypt P40 quality worker hosts Qwen3.8 multimodal — never refuse images for these ids.
    if (
      provider === 'secrypt' || provider === 'cipher' || provider === 'graysoft'
      || model === 'cipher-quality' || model === 'cipher' || model === 'graysoft-cloud'
    ) {
      return true;
    }
    const list = VISION_MODELS[provider] || [];
    return list.some(m => model.includes(m) || m.includes(model));
  }

  _getModelContextLimit(provider, model) {
    // Secrypt P40 quality worker. Live llama-server: IQ4_XS weights, -c 65536, Q4 KV on GPU.
    if (
      provider === 'secrypt' ||
      provider === 'cipher' ||
      provider === 'graysoft' ||
      model === 'cipher' ||
      model === 'cipher-quality' ||
      model === 'graysoft-cloud'
    ) {
      const measured = this._p40Windows && this._p40Windows[String(model || '').toLowerCase()];
      if (measured) return measured;
      return parseInt(process.env.SECRYPT_CONTEXT_TOKENS || String(SECRYPT_CONTEXT_DEFAULT), 10) || SECRYPT_CONTEXT_DEFAULT;
    }
    return CONTEXT_LIMITS[model] || 32768;
  }

  // ─── Ollama local LLM detection ─────────────────────────────────────────────

  async detectOllama() {
    const now = Date.now();
    if (this._ollamaLastCheck && now - this._ollamaLastCheck < 30000) {
      return this._ollamaAvailable;
    }

    return new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost', port: 11434, path: '/api/tags',
        method: 'GET', timeout: 3000,
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            this._ollamaModels = (parsed.models || []).map(m => ({
              id: m.name, name: m.name,
              size: m.size, modified: m.modified_at,
            }));
            this._ollamaAvailable = true;
          } catch {
            this._ollamaAvailable = false;
            this._ollamaModels = [];
          }
          this._ollamaLastCheck = Date.now();
          resolve(this._ollamaAvailable);
        });
      });
      req.on('error', () => {
        this._ollamaAvailable = false;
        this._ollamaModels = [];
        this._ollamaLastCheck = Date.now();
        resolve(false);
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  getOllamaModels() { return this._ollamaModels; }

  getOllamaVisionModels() {
    return this._ollamaModels.filter(m =>
      /llava|bakllava|qwen.*vl|minicpm.*v|moondream|internvl|cogvlm/i.test(m.id)
    );
  }

  // ─── OpenRouter live model catalog ──────────────────────────────────────────

  async fetchOpenRouterModels() {
    const now = Date.now();
    if (this._openRouterModelsCache && now - this._openRouterModelsFetchedAt < 600000) {
      return this._openRouterModelsCache;
    }

    return new Promise((resolve) => {
      const req = https.request({
        host: 'openrouter.ai', path: '/api/v1/models',
        method: 'GET', timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const models = (parsed.data || [])
              .filter(m => {
                if (m.id.includes('/image') || m.id.includes('/audio')) return false;
                if (OPENROUTER_BLOCKED.some(rx => rx.test(m.id) || rx.test(m.name || ''))) return false;
                return true;
              })
              .map(m => ({
                id: m.id,
                name: m.name || m.id,
                contextLength: m.context_length,
                pricing: m.pricing,
                isFree: m.pricing && parseFloat(m.pricing.prompt) === 0 && parseFloat(m.pricing.completion) === 0,
              }))
              .sort((a, b) => {
                if (a.isFree && !b.isFree) return -1;
                if (!a.isFree && b.isFree) return 1;
                return (a.name || '').localeCompare(b.name || '');
              });

            this._openRouterModelsCache = models;
            this._openRouterModelsFetchedAt = Date.now();
            resolve(models);
          } catch {
            resolve(this._openRouterModelsCache || PROVIDER_MODELS.openrouter);
          }
        });
      });
      req.on('error', () => resolve(this._openRouterModelsCache || PROVIDER_MODELS.openrouter));
      req.on('timeout', () => { req.destroy(); resolve(this._openRouterModelsCache || PROVIDER_MODELS.openrouter); });
      req.end();
    });
  }

  // ─── Context trimming ───────────────────────────────────────────────────────

  /**
   * Qwen/Jinja: only the first message may be role=system.
   * Coerce any later system roles to user; drop empty.
   * Merge consecutive same-role turns (assistant,assistant → one) — bare upstream 400
   * on Cipher when silent incomplete continues stacked assistants with empty prompt.
   * When ensureEndsWithUser, append a structural [System] user turn if the list ends on assistant
   * (chat template requires a trailing user to generate the next assistant).
   */
  _normalizeMessagesForChatTemplate(messages, { ensureEndsWithUser = false } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    const out = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m) continue;
      let role = String(m.role || 'user').toLowerCase();
      // Preserve multimodal content arrays (vision). Only flatten non-array objects.
      const content = typeof m.content === 'string'
        ? m.content
        : (Array.isArray(m.content) ? m.content : messageText(m));
      const empty = Array.isArray(content) ? content.length === 0 : !content;
      if (empty && role !== 'assistant') continue;
      if (role === 'system' && out.length > 0) role = 'user';
      if (role !== 'system' && role !== 'assistant' && role !== 'user') role = 'user';
      const prev = out.length ? out[out.length - 1] : null;
      if (prev && prev.role === role && role !== 'system') {
        // Never concatenate into a multimodal array — push as separate turn instead.
        if (Array.isArray(prev.content) || Array.isArray(content)) {
          out.push({ role, content });
          continue;
        }
        const sep = prev.content && content ? '\n' : '';
        prev.content = `${prev.content || ''}${sep}${content || ''}`;
        continue;
      }
      out.push({ role, content });
    }
    if (ensureEndsWithUser && out.length > 0 && out[out.length - 1].role === 'assistant') {
      out.push({ role: 'user', content: '[System]' });
    }
    return out;
  }

  _trimToContextLimit(messages, provider, model, maxTokens, measured = null) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    const contextLimit = this._getModelContextLimit(provider, model);
    const outputTokens = (typeof maxTokens === 'number' && maxTokens > 0)
      ? maxTokens
      : resolveCloudOutputTokens(0, contextLimit);
    const hasSystem = messages[0]?.role === 'system';
    const systemPrompt = hasSystem ? messageText(messages[0]) : '';
    const body = hasSystem ? messages.slice(1) : messages.slice();
    if (body.length === 0) return messages;
    const last = body[body.length - 1];
    const history = body.slice(0, -1).map((m) => ({ role: m.role, content: messageText(m) }));
    const fit = fitCloudHistory({
      systemPrompt,
      history,
      nextUser: messageText(last),
      contextLimit,
      outputTokens,
      measured,
    });
    if (fit.droppedCount === 0 && fit.nextUser === messageText(last)) return messages;
    const out = [];
    if (hasSystem) out.push({ ...messages[0], content: typeof messages[0].content === 'string' ? messages[0].content : systemPrompt });
    out.push(...fit.history);
    if (fit.nextUser === messageText(last) && last && typeof last.content !== 'string') out.push(last);
    else out.push({ role: last.role || 'user', content: fit.nextUser });
    if (fit.droppedCount > 0) {
      console.log(`[CloudLLM] Context rotate dropped ${fit.droppedCount} messages to fit ${model} (${contextLimit} tokens)`);
    }
    return out;
  }

  // ─── Proxy routing ──────────────────────────────────────────────────────────

  async _generateViaProxy(provider, model, systemPrompt, prompt, options, onToken, conversationHistory, onThinkingToken, sessionToken, images = []) {
    // guIDE Cloud / Cerebras / GraySoft → Secrypt Cipher on P40 (same path as Pocket)
    const useSecrypt =
      provider === 'secrypt' ||
      provider === 'cipher' ||
      provider === 'graysoft' ||
      provider === 'cerebras';
    const proxyProvider = useSecrypt ? 'secrypt' : provider;
    const proxyModel = useSecrypt
      ? resolveSecryptCloudModel(provider, model)
      : model;

    let sys = typeof systemPrompt === 'string' ? systemPrompt : '';

    let messages = [
      ...conversationHistory.map(m => ({ role: m.role, content: m.content })),
    ];
    const promptText = String(prompt || '');
    const imageParts = buildImageContentParts(images);
    // ImgHist1: later rounds of the same turn re-attach images to the user's original ask
    // (earlier in history), after context trim — trim flattens history to text.
    const imageAnchor = String(options.imageAnchorText || '').trim();
    let anchorImages = null;
    if (imageParts.length > 0 && imageAnchor) {
      for (let i = messages.length - 2; i >= 0; i -= 1) {
        const m = messages[i];
        if (m && m.role === 'user' && typeof m.content === 'string' && m.content.trim() === imageAnchor) {
          anchorImages = imageParts;
          break;
        }
      }
    }
    if (anchorImages) {
      if (promptText.trim()) messages.push({ role: 'user', content: promptText });
    } else if (imageParts.length > 0) {
      // VisionMerge1: one user turn — history often already ends with role=user; a second
      // user+vision message → bodyRoles=…,user,user → upstream 400 on Qwen Jinja (2026-10-02 12:25Z).
      const last = messages.length ? messages[messages.length - 1] : null;
      let textForVision = promptText.trim();
      if (!textForVision && last && last.role === 'user' && typeof last.content === 'string') {
        textForVision = last.content.trim();
      }
      if (!textForVision) textForVision = ' ';
      const userContent = [{ type: 'text', text: textForVision }, ...imageParts];
      if (last && last.role === 'user') {
        if (Array.isArray(last.content)) {
          const merged = [...last.content];
          const hasText = merged.some((p) => p && p.type === 'text');
          if (!hasText && textForVision) merged.unshift({ type: 'text', text: textForVision });
          for (const img of imageParts) merged.push(img);
          messages[messages.length - 1] = { role: 'user', content: merged };
        } else if (typeof last.content === 'string') {
          messages[messages.length - 1] = { role: 'user', content: userContent };
        } else {
          messages.push({ role: 'user', content: userContent });
        }
      } else {
        messages.push({ role: 'user', content: userContent });
      }
      console.log(`[CloudLLM] proxy vision: ${imageParts.length} image(s) on final user message model=${proxyModel}`);
    } else if (promptText.trim() || messages.length === 0) {
      messages.push({ role: 'user', content: promptText });
    }
    if (useSecrypt) await this.loadP40Windows();
    const contextLimit = useSecrypt ? this._getModelContextLimit(proxyProvider, proxyModel) : 0;
    const outputTokens = useSecrypt
      ? resolveCloudOutputTokens(options.maxTokens, contextLimit)
      : (options.maxTokens > 0 ? options.maxTokens : 2048);
    // Qwen-class cipher-quality leaves thinking off unless the request turns it on.
    const thinkingOn = options.enableThinking !== false && options.thinkingMode !== 'off';

    if (useSecrypt) {
      // HARD: GGUF Jinja allows at most ONE role=system, and only at index 0.
      // Graysoft prepends `systemPrompt` as that sole system, then appends `messages`.
      // Strategy A: put system ONLY in systemPrompt; body messages must never contain role=system.
      // (Strategy B — system in messages[0] + omit systemPrompt — fails on secrypt.space which
      // always injects SECRYPT_SYSTEM_PROMPT before appending body.messages.)
      const bodyOnly = messages
        .map((m) => {
          const role = String(m?.role || 'user').toLowerCase();
          // Preserve multimodal content arrays (vision). Flatten only non-array objects.
          const content = typeof m?.content === 'string'
            ? m.content
            : (Array.isArray(m?.content) ? m.content : messageText(m));
          const empty = Array.isArray(content) ? content.length === 0 : !content;
          if (empty && role !== 'assistant') return null;
          if (role === 'system') {
            return { role: 'user', content: Array.isArray(content) ? messageText({ content }) : content };
          }
          if (role !== 'assistant' && role !== 'user') {
            return { role: 'user', content };
          }
          return { role, content };
        })
        .filter(Boolean);

      let withSystem = sys
        ? [{ role: 'system', content: sys }, ...bodyOnly]
        : bodyOnly.slice();
      // Always normalize + ensure trailing user when not mid-partial-continue.
      // Live 2026-09-29: empty prompt + history ending assistant,assistant → upstream 400.
      withSystem = this._normalizeMessagesForChatTemplate(withSystem, {
        ensureEndsWithUser: !options.continuePartial,
      });
      if (!options.continuePartial) {
        withSystem = this._trimToContextLimit(
          withSystem,
          proxyProvider,
          proxyModel,
          outputTokens,
          options.measuredPrompt || null
        );
      }
      withSystem = this._normalizeMessagesForChatTemplate(withSystem, {
        ensureEndsWithUser: !options.continuePartial,
      });

      if (withSystem[0]?.role === 'system') {
        sys = withSystem[0].content;
        messages = withSystem.slice(1);
      } else {
        messages = withSystem.slice();
      }
      // Ironclad: zero system roles leave in the body (proxy will prepend systemPrompt).
      // Keep multimodal arrays intact on user messages (VisionCipher1).
      messages = messages.map((m) => {
        const role = String(m?.role || 'user').toLowerCase();
        const content = typeof m.content === 'string'
          ? m.content
          : (Array.isArray(m.content) ? m.content : messageText(m));
        if (role === 'system' || (role !== 'user' && role !== 'assistant')) {
          return { role: 'user', content };
        }
        return { role, content };
      });
      const bodySys = messages.filter((m) => m.role === 'system').length;
      const rolesLog = messages.map((m) => m.role).join(',');
      console.log(
        `[CloudLLM] secrypt bodyRoles=${rolesLog || '(none)'} bodySys=${bodySys} hasSystemPrompt=${!!sys} msgs=${messages.length}`
      );
      if (bodySys > 0) {
        console.error(`[CloudLLM] ILLEGAL body system coerced away: ${rolesLog}`);
        messages = messages.map((m) => (
          m.role === 'system' ? { role: 'user', content: m.content } : m
        ));
      }
    }

    if (anchorImages) {
      let idx = -1;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        // includes: normalize can merge the ask with an adjacent user turn.
        if (m && m.role === 'user' && typeof m.content === 'string' && m.content.includes(imageAnchor)) {
          idx = i;
          break;
        }
      }
      if (idx >= 0) {
        messages[idx] = { role: 'user', content: [{ type: 'text', text: messages[idx].content }, ...anchorImages] };
      } else {
        // Ask was rotated out by context fit — images ride the trailing user turn.
        let lastUser = -1;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (messages[i] && messages[i].role === 'user') { lastUser = i; break; }
        }
        if (lastUser >= 0) {
          const c = messages[lastUser].content;
          messages[lastUser] = {
            role: 'user',
            content: Array.isArray(c)
              ? [...c, ...anchorImages]
              : [{ type: 'text', text: String(c || ' ') }, ...anchorImages],
          };
          idx = lastUser;
        }
      }
      console.log(
        `[CloudLLM] proxy vision: ${anchorImages.length} image(s) on original ask idx=${idx}/${messages.length} model=${proxyModel}`,
      );
    }

    const proxyEffort = options.reasoningEffort || (thinkingOn ? 'medium' : 'low');
    // EffortOnly1: wire reasoning_effort only. No thinking_budget_tokens /
    // reasoning_budget_tokens — those hard-stop mid-thought and make effort pointless.
    console.log(
      `[CloudLLM] proxy sampling effort=${proxyEffort} (EffortOnly1 no think-budget) `
      + `outputTokens=${outputTokens} temp=${options.temperature ?? 0.7} thinkingOn=${thinkingOn ? 1 : 0}`,
    );

    const proxyBodyObj = {
      provider: proxyProvider,
      model: proxyModel,
      messages,
      maxTokens: outputTokens,
      temperature: options.temperature ?? 0.7,
      top_p: options.topP,
      top_k: options.topK,
      min_p: options.minP,
      presence_penalty: options.presencePenalty,
      repeat_penalty: options.repeatPenalty,
      stream: !!onToken,
      enableThinking: thinkingOn,
      reasoning_effort: proxyEffort === 'high' ? 'xhigh' : proxyEffort,
      chat_template_kwargs: {
        enable_thinking: thinkingOn,
        // Qwen template allows only xhigh|medium|low — never "high" (Jinja 500).
        reasoning_effort: proxyEffort === 'high' ? 'xhigh' : proxyEffort,
        preserve_thinking: thinkingOn,
      },
    };
    if (sys) {
      proxyBodyObj.systemPrompt = sys;
    }
    if (options.continuePartial) {
      proxyBodyObj.continuePartial = String(options.continuePartial);
      // ThinkStallLeak1: stall mid-reasoning must NOT force reasoning_format=none —
      // that dumps the rest of the thought into delta.content and leaks into chat
      // mid-sentence (live 2026-09-30 "...glass display for" → "digital content").
      if (!options.continueInThinking) {
        proxyBodyObj.reasoning_format = 'none';
      } else {
        console.log('[CloudLLM] continueInThinking: keeping reasoning channel for stall resume');
      }
    }
    const proxyBody = JSON.stringify(proxyBodyObj);

    const streamOpts = {
      streamIdleMs: options.streamIdleMs != null ? options.streamIdleMs : PROXY_STREAM_IDLE_MS,
      firstByteMs: PROXY_FIRST_BYTE_MS,
      onStreamQuiet: options.onStreamQuiet || null,
    };
    // Warm IP cache so a later ENOTFOUND can reconnect without waiting on flaky resolver.
    void this._resolveProxyConnectHost('graysoft.dev').catch(() => {});
    try {
      const result = await this._streamRequest(
        'graysoft.dev', '/api/ai/proxy', sessionToken, proxyBody,
        'openai', onToken, {}, onThinkingToken, proxyProvider,
        streamOpts.streamIdleMs,
        streamOpts.firstByteMs,
        streamOpts.onStreamQuiet,
      );
      const promptChars = String(sys || '').length
        + messages.reduce((n, m) => n + messageText(m).length, 0);
      return { ...result, promptChars, model: proxyModel, provider: proxyProvider, viaProxy: true };
    } catch (err) {
      if (err.message && (err.message.includes('quota_exceeded') || err.message.includes('429'))) {
        const e = new Error(err.message);
        e.isQuotaError = true;
        throw e;
      }
      // ProxyNetResume1: DNS/name failure → resolve A/AAAA (or cache) and retry once with Host/SNI.
      // Do not pretend to "fall through to direct" — there is no direct Secrypt path.
      if (isTransientProxyNetError(err) && !options._proxyDnsRetried) {
        const ip = await this._resolveProxyConnectHost('graysoft.dev');
        if (ip) {
          console.warn(
            `[CloudLLM] Proxy DNS/net fail (${String(err.message || '').slice(0, 80)}) — `
            + `retry via ${ip} Host=graysoft.dev`,
          );
          try {
            const result = await this._streamRequest(
              ip, '/api/ai/proxy', sessionToken, proxyBody,
              'openai', onToken, { Host: 'graysoft.dev' }, onThinkingToken, proxyProvider,
              streamOpts.streamIdleMs,
              streamOpts.firstByteMs,
              streamOpts.onStreamQuiet,
              'graysoft.dev',
            );
            const promptChars = String(sys || '').length
              + messages.reduce((n, m) => n + messageText(m).length, 0);
            return { ...result, promptChars, model: proxyModel, provider: proxyProvider, viaProxy: true };
          } catch (retryErr) {
            console.warn(`[CloudLLM] Proxy IP-retry failed: ${String(retryErr.message || '').slice(0, 120)}`);
            throw retryErr;
          }
        }
      }
      console.warn(`[CloudLLM] Proxy request failed for ${proxyProvider}:`, err.message?.substring(0, 120));
      throw err;
    }
  }

  async _resolveProxyConnectHost(hostname) {
    const cached = _proxyHostIpCache.get(hostname);
    if (cached?.ip && Date.now() - cached.at < 30 * 60 * 1000) {
      return cached.ip;
    }
    try {
      const answers = await dns.lookup(hostname, { all: true, verbatim: true });
      const v4 = answers.find((a) => a.family === 4);
      const pick = v4 || answers[0];
      if (pick?.address) {
        _proxyHostIpCache.set(hostname, { ip: pick.address, at: Date.now() });
        console.log(`[CloudLLM] Proxy host ${hostname} → ${pick.address}`);
        return pick.address;
      }
    } catch (e) {
      console.warn(`[CloudLLM] Proxy host lookup failed for ${hostname}: ${e.message}`);
      if (cached?.ip) {
        console.warn(`[CloudLLM] Using stale cached IP ${cached.ip} for ${hostname}`);
        return cached.ip;
      }
    }
    return null;
  }

  // ─── Main generate entry point ──────────────────────────────────────────────

  async generate(prompt, options = {}) {
    const provider = options.provider || this.activeProvider;
    const model = options.model || this.activeModel;
    console.log(`[CloudLLM] generate called: provider=${provider}, model=${model}, hasKey=${!!this.apiKeys[provider]}, promptLen=${prompt?.length || 0}, stream=${options.stream}`);
    const systemPrompt = options.systemPrompt || CLOUD_SYSTEM_PROMPT;
    const onToken = options.onToken;
    const onThinkingToken = options.onThinkingToken || null;
    const conversationHistory = options.conversationHistory || [];
    let images = options.images || [];
    const noFallback = options.noFallback || false;

    if (!provider || (!this.apiKeys[provider] && provider !== 'ollama' && provider !== 'graysoft' && provider !== 'secrypt' && provider !== 'cipher')) {
      throw new Error(`No API key configured for ${provider}`);
    }

    if (provider === 'ollama') {
      return this._generateOllama(model, systemPrompt, prompt, options, onToken, conversationHistory, onThinkingToken, images);
    }

    // Secrypt / GraySoft Cloud — session token optional (anonymous proxy quota applies)
    const sessionToken = this._licenseManager?.getSessionToken();
    if (provider === 'graysoft' || provider === 'secrypt' || provider === 'cipher') {
      if (sessionToken) this.apiKeys[provider] = sessionToken;
    }

    const forceSecryptCloud =
      provider === 'graysoft' ||
      provider === 'secrypt' ||
      provider === 'cipher' ||
      provider === 'cerebras';

    // VisionCipher1: images MUST stay on the Secrypt proxy (Qwen3.8 multimodal).
    // Skipping proxy forced a broken direct call → UI note + 400 "provider, model, and messages are required".
    if (forceSecryptCloud && !options.skipProxy) {
      return await this._generateViaProxy(
        provider, model, systemPrompt, prompt, options, onToken, conversationHistory, onThinkingToken, sessionToken || null, images
      );
    }

    if (sessionToken && this._isBundledProvider(provider) && !(images && images.length > 0) && !options.skipProxy) {
      try {
        return await this._generateViaProxy(provider, model, systemPrompt, prompt, options, onToken, conversationHistory, onThinkingToken, sessionToken, images);
      } catch (err) {
        if (err.isQuotaError) throw err;
        console.warn('[CloudLLM] Proxy unreachable, using direct bundled key as fallback');
      }
    }

    if (images && images.length > 0 && !this._supportsVision(provider, model)) {
      if (onToken) {
        onToken(`\n\n*Note: ${model} does not support image input. Images will be ignored. Use a vision-capable model like GPT-4o, Claude Sonnet 4, or Gemini 2.5 for image analysis.*\n\n`);
      }
      options.images = [];
      images = [];
    }

    const now = Date.now();
    let providerOnCooldown = false;
    if (this._rateLimitedUntil[provider] && this._rateLimitedUntil[provider] > now) {
      const pool = this._keyPools[provider];
      const hasAvailableKey = pool && pool.some(e => e.cooldownUntil <= now);
      if (hasAvailableKey) {
        console.log(`[CloudLLM] ${provider} provider cooldown but pool has available keys, retrying...`);
        delete this._rateLimitedUntil[provider];
      } else {
        providerOnCooldown = true;
        const waitSec = Math.ceil((this._rateLimitedUntil[provider] - now) / 1000);
        console.log(`[CloudLLM] ${provider} on cooldown for ${waitSec}s, switching seamlessly to next provider`);
      }
    }

    if (!providerOnCooldown) {
      const result = await this._attemptWithPoolRotation(provider, model, systemPrompt, prompt, options, onToken, conversationHistory, onThinkingToken, images, noFallback);
      if (result) return result;
    }

    // R47-Fix-E: Only respect noFallback for actual rate limits (429).
    // For transient server errors (5xx), always try fallback chain — the user
    // benefits from transparent failover rather than a misleading "Rate limited" error.
    if (noFallback && !this._lastAttemptWasServerError) {
      throw new Error(`Rate limited on all available providers. Please wait a minute and try again.`);
    }
    return this._attemptFallbackChain(provider, model, systemPrompt, prompt, options, onToken, conversationHistory, onThinkingToken, images);
  }

  async _attemptWithPoolRotation(provider, model, systemPrompt, prompt, options, onToken, conversationHistory, onThinkingToken, images, noFallback) {
    this._lastAttemptWasServerError = false; // R47-Fix-E: Track whether failure was 5xx
    const proactivePace = this.getProactivePaceMs(provider);
    if (proactivePace > 0) {
      console.log(`[CloudLLM] Proactive pacing: waiting ${proactivePace}ms before ${provider} request (RPM budget management)`);
      await new Promise(r => setTimeout(r, proactivePace));
    }

    const pool = this._keyPools[provider];
    const activePool = pool ? pool.filter(e => !e.disabled) : [];
    const maxRetries = activePool.length || (pool ? pool.length : 1);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const attemptKey = this._getPoolKey(provider) || this.apiKeys[provider];
      if (!attemptKey) break;

      this._recordRequest(provider);

      try {
        const genOptions = attempt > 0
          ? { ...options, streamIdleMs: IDLE_TIMEOUT_POOL_RETRY }
          : options;
        return await this._executeGeneration(provider, model, systemPrompt, prompt, genOptions, onToken, conversationHistory, onThinkingToken, images, attemptKey);
      } catch (err) {
        // Classify errors using actual HTTP status codes when available,
        // falling back to string matching only when no status code is present
        const msg = err.message || '';
        const msgLower = msg.toLowerCase();
        const statusCode = err.status || err.statusCode || err.response?.status || 0;

        let is429, is401, is403, is5xx, isUsageLimit;
        isUsageLimit =
          provider === 'cursor' &&
          (msgLower.includes('usage limit') ||
            msgLower.includes('spend limit') ||
            msgLower.includes('usage_limit') ||
            msgLower.includes('usage-based pricing required'));
        if (statusCode > 0) {
          is401 = statusCode === 401;
          is429 = !is401 && (statusCode === 429 || statusCode === 413);
          is403 = !is401 && !is429 && statusCode === 403;
          is5xx = !is401 && !is429 && !is403 && statusCode >= 500 && statusCode < 600;
        } else {
          is401 = msg.includes('401') || msgLower.includes('unauthorized');
          is429 =
            !is401 &&
            !isUsageLimit &&
            (msg.includes('429') ||
              msg.includes('413') ||
              msgLower.includes('rate limit') ||
              msgLower.includes('too large') ||
              msgLower.includes('tokens per minute'));
          is403 = !is401 && !is429 && !isUsageLimit && (msg.includes('403') || msgLower.includes('forbidden'));
          is5xx =
            !is401 &&
            !is429 &&
            !is403 &&
            !isUsageLimit &&
            (msg.includes('500') ||
              msg.includes('502') ||
              msg.includes('503') ||
              msg.includes('ECONNRESET') ||
              msgLower.includes('timeout'));
        }

        if (is401) {
          this._disablePoolKey(provider, attemptKey, '401 auth failed');
          if (pool && pool.length > 1 && attempt < maxRetries - 1) {
            console.log(`[CloudLLM] 401 on ${provider} key ...${attemptKey.slice(-6)}, skipping dead key (attempt ${attempt + 2}/${maxRetries})`);
            continue;
          }
          throw new Error(`${this._getProviderLabel(provider)} API key rejected (401). Check your API key in Settings.`);
        }

        if (isUsageLimit) {
          if (this._cursorKeyPool) {
            const next = this._cursorKeyPool.rotateOnLimit(err, attemptKey);
            if (next && pool && pool.length > 1 && attempt < maxRetries - 1) {
              console.log(
                `[CloudLLM] Cursor usage limit on ...${attemptKey.slice(-6)}, sticky-rotating (attempt ${attempt + 2}/${maxRetries})`
              );
              continue;
            }
          } else {
            // Fallback without CursorKeyPool: long cooldown + advance sticky index
            const { cooldownMsFromError } = require('./cursorKeyPool');
            const ms = cooldownMsFromError(err);
            this._cooldownPoolKey(provider, attemptKey, ms);
            const cur = this._keyPoolIndex[provider] || 0;
            this._keyPoolIndex[provider] = (cur + 1) % Math.max(pool?.length || 1, 1);
            if (pool && pool.length > 1 && attempt < maxRetries - 1) {
              console.log(
                `[CloudLLM] Cursor usage limit on ...${attemptKey.slice(-6)}, rotating (attempt ${attempt + 2}/${maxRetries})`
              );
              continue;
            }
          }
          throw err;
        }

        if (is429) {
          this._recent429Timestamps.push(Date.now());
          this._cooldownPoolKey(provider, attemptKey, 60000);
          if (provider === 'cursor' && this._cursorKeyPool) {
            this._cursorKeyPool.rotateOnLimit(err, attemptKey);
          } else if (provider === 'cursor' && pool && pool.length > 1) {
            const cur = this._keyPoolIndex[provider] || 0;
            this._keyPoolIndex[provider] = (cur + 1) % pool.length;
          }

          if (pool && pool.length > 1 && attempt < maxRetries - 1) {
            console.log(`[CloudLLM] 429 on ${provider} key ...${attemptKey.slice(-6)}, rotating (attempt ${attempt + 2}/${maxRetries})`);
            continue;
          }

          this._rateLimitedUntil[provider] = Date.now() + 60000;
          console.log(`[CloudLLM] 429 on ${provider} (all pool keys exhausted), cooldown for 60s`);

          if (noFallback) {
            const label = (this._isBundledProvider(provider) && !this.isUsingOwnKey(provider))
              ? 'Cipher'
              : this._getProviderLabel(provider);
            throw new Error(`${label} rate limited. Please wait a minute or try a different model.`);
          }
          return null;
        }

        if (is403 || is5xx) {
          const cooldownMs = is403 ? 300000 : 60000;
          this._rateLimitedUntil[provider] = Date.now() + cooldownMs;
          this._lastAttemptWasServerError = true; // R47-Fix-E: 5xx/403 should still try fallback
          console.log(`[CloudLLM] ${msg.substring(0, 80)} on ${provider}, cooldown ${cooldownMs / 1000}s, falling to fallback chain`);
          return null;
        }

        throw err;
      }
    }
    return null;
  }

  async _attemptFallbackChain(provider, model, systemPrompt, prompt, options, onToken, conversationHistory, onThinkingToken, images) {
    const fallbackChain = [];
    const now = Date.now();

    if (provider === 'google') {
      const altModels = (PROVIDER_MODELS.google || []).map(m => m.id).filter(m => m !== model);
      for (const altModel of altModels) {
        fallbackChain.push({ provider: 'google', model: altModel });
      }
    }

    for (const p of FALLBACK_ORDER) {
      if (p === provider) continue;
      if (!this.apiKeys[p]) continue;
      if (this._rateLimitedUntil[p] && this._rateLimitedUntil[p] > now) continue;

      const pModel = PREFERRED_FALLBACK_MODEL[p] || (PROVIDER_MODELS[p] || [])[0]?.id;
      if (pModel) fallbackChain.push({ provider: p, model: pModel });
    }

    for (const fb of fallbackChain) {
      if (fb.provider !== 'google' && this._rateLimitedUntil[fb.provider] && this._rateLimitedUntil[fb.provider] > Date.now()) continue;

      console.log(`[CloudLLM] Falling back to ${fb.provider}/${fb.model}`);
      await new Promise(r => setTimeout(r, 0));

      try {
        const result = await this._executeGeneration(fb.provider, fb.model, systemPrompt, prompt, options, onToken, conversationHistory, onThinkingToken, images);
        result.fallbackUsed = { from: provider, to: fb.provider, model: fb.model };
        return result;
      } catch (fbErr) {
        const msg = fbErr.message || '';
        const msgLower = msg.toLowerCase();

        if (msg.includes('429') || msg.includes('413') || msgLower.includes('rate limit') || msgLower.includes('too large') || msgLower.includes('tokens per minute')) {
          this._rateLimitedUntil[fb.provider] = Date.now() + 60000;
          console.log(`[CloudLLM] Fallback ${fb.provider} also rate limited (cooldown 60s), trying next...`);
          continue;
        }
        if (msg.includes('403') || msgLower.includes('forbidden')) {
          this._rateLimitedUntil[fb.provider] = Date.now() + 300000;
          console.log(`[CloudLLM] Fallback ${fb.provider} 403 forbidden, cooldown 5min, trying next...`);
          continue;
        }
        if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msgLower.includes('timeout') || msg.includes('ECONNRESET')) {
          console.log(`[CloudLLM] Fallback ${fb.provider} transient error: ${msg.substring(0, 100)}, trying next...`);
          continue;
        }
        throw fbErr;
      }
    }

    throw new Error('Rate limited on all available providers. Please wait a minute and try again.');
  }

  // ─── Provider routing ───────────────────────────────────────────────────────

  _executeGeneration(provider, model, systemPrompt, prompt, options, onToken, conversationHistory, onThinkingToken, images = [], overrideKey = null) {
    console.log(`[CloudLLM] _executeGeneration: provider=${provider}, model=${model}, isOllama=${provider === 'ollama'}, isAnthropic=${provider === 'anthropic'}, stream=${!!onToken}, historyLen=${conversationHistory?.length || 0}`);
    if (provider === 'ollama') {
      return this._generateOllama(model, systemPrompt, prompt, options, onToken, conversationHistory, onThinkingToken, images);
    }

    const apiKey = overrideKey || this._getPoolKey(provider) || this.apiKeys[provider];
    if (!apiKey) throw new Error(`No API key configured for ${provider}`);

    if (provider === 'cursor') {
      const { assertCursorAdmin } = require('./cursorAdminGate');
      assertCursorAdmin({ licenseManager: this._licenseManager });
      const { generateWithCursorSdk } = require('./cursorCloudProvider');
      return generateWithCursorSdk({
        apiKey,
        model,
        systemPrompt,
        prompt,
        conversationHistory,
        onToken,
        onThinkingToken,
        projectPath: options.projectPath || options.cwd || process.cwd(),
        getCancelled: options.getCancelled || null,
      });
    }
    if (provider === 'apifreellm') {
      return this._generateAPIFreeLLM(apiKey, systemPrompt, prompt, options, onToken, conversationHistory);
    }
    if (provider === 'anthropic') {
      return this._generateAnthropic(apiKey, model, systemPrompt, prompt, options, onToken, conversationHistory, onThinkingToken, images);
    }

    return this._generateOpenAICompatible(provider, apiKey, model, systemPrompt, prompt, options, onToken, conversationHistory, onThinkingToken, images);
  }

  // ─── OpenAI-compatible generation (24 providers) ────────────────────────────

  async _generateOpenAICompatible(provider, apiKey, model, systemPrompt, prompt, options, onToken, conversationHistory = [], onThinkingToken = null, images = []) {
    const endpoint = this._getEndpoint(provider);
    let messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.map(m => ({ role: m.role, content: m.content })),
    ];

    if (images && images.length > 0) {
      const userContent = [
        { type: 'text', text: prompt },
        ...images.map(img => ({
          type: 'image_url',
          image_url: { url: img.data.startsWith('data:') ? img.data : `data:${img.mimeType || 'image/png'};base64,${img.data}` },
        })),
      ];
      messages.push({ role: 'user', content: userContent });
    } else if (String(prompt || '').trim() || conversationHistory.length === 0) {
      messages.push({ role: 'user', content: prompt });
    }

    messages = this._trimToContextLimit(messages, provider, model, options.maxTokens);

    const body = JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages,
      max_tokens: options.maxTokens || 2048,
      temperature: options.temperature || 0.7,
      stream: !!onToken,
    });

    if (onToken) {
      const streamIdleMs = options.streamIdleMs || IDLE_TIMEOUT;
      return this._streamRequest(endpoint.host, endpoint.path, apiKey, body, 'openai', onToken, {}, onThinkingToken, provider, streamIdleMs);
    }

    const data = await this._makeRequest(endpoint.host, endpoint.path, apiKey, body, {}, provider);
    try {
      const parsed = JSON.parse(data);
      return {
        text: parsed.choices?.[0]?.message?.content || '',
        model: parsed.model || model,
        tokensUsed: parsed.usage?.total_tokens || 0,
      };
    } catch {
      throw new Error(`Invalid JSON response from ${provider}: ${String(data).substring(0, 200)}`);
    }
  }

  // ─── Anthropic generation ───────────────────────────────────────────────────

  async _generateAnthropic(apiKey, model, systemPrompt, prompt, options, onToken, conversationHistory = [], onThinkingToken = null, images = []) {
    const endpoint = this._getEndpoint('anthropic');
    const messages = [
      ...conversationHistory.map(m => ({ role: m.role, content: m.content })),
    ];

    if (images && images.length > 0) {
      const userContent = [
        ...images.map(img => {
          let base64Data = img.data;
          let mediaType = img.mimeType || 'image/png';
          if (base64Data.startsWith('data:')) {
            const match = base64Data.match(/^data:([^;]+);base64,(.+)$/);
            if (match) { mediaType = match[1]; base64Data = match[2]; }
          }
          return {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64Data },
          };
        }),
        { type: 'text', text: prompt },
      ];
      messages.push({ role: 'user', content: userContent });
    } else if (String(prompt || '').trim() || conversationHistory.length === 0) {
      messages.push({ role: 'user', content: prompt });
    }

    const body = JSON.stringify({
      model: model || 'claude-3-haiku-20240307',
      max_tokens: options.maxTokens || 2048,
      system: systemPrompt,
      messages,
      stream: !!onToken,
    });

    const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };

    if (onToken) {
      return this._streamRequest(endpoint.host, endpoint.path, apiKey, body, 'anthropic', onToken, headers, onThinkingToken, 'anthropic');
    }

    const data = await this._makeRequest(endpoint.host, endpoint.path, apiKey, body, headers, 'anthropic');
    try {
      const parsed = JSON.parse(data);
      const text = parsed.content?.map(b => b.text).join('') || '';
      return {
        text,
        model: parsed.model || model,
        tokensUsed: (parsed.usage?.input_tokens || 0) + (parsed.usage?.output_tokens || 0),
      };
    } catch {
      throw new Error(`Invalid JSON response from anthropic: ${String(data).substring(0, 200)}`);
    }
  }

  // ─── Ollama local generation (NDJSON streaming) ─────────────────────────────

  async _generateOllama(model, systemPrompt, prompt, options, onToken, conversationHistory = [], onThinkingToken = null, images = []) {
    const maxTokens = options.maxTokens || 4096;
    const temperature = options.temperature ?? 0.7;

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    for (const h of conversationHistory) messages.push({ role: h.role, content: h.content });

    const userMsg = { role: 'user', content: prompt };
    if (images && images.length > 0) {
      userMsg.images = images.map(img => {
        const src = typeof img === 'string' ? img : (img.data || img.dataUrl || '');
        const b64Match = src.match(/^data:[^;]+;base64,(.+)$/);
        return b64Match ? b64Match[1] : src;
      }).filter(Boolean);
    }
    if (String(prompt || '').trim() || images?.length || conversationHistory.length === 0) {
      messages.push(userMsg);
    }

    const body = JSON.stringify({
      model, messages,
      stream: !!onToken,
      options: { temperature, num_predict: maxTokens },
    });

    return new Promise((resolve, reject) => {
      const postOptions = {
        hostname: 'localhost', port: 11434, path: '/api/chat',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 120000,
      };

      let fullText = '';
      const req = http.request(postOptions, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', c => errBody += c);
          res.on('end', () => reject(new Error(`Ollama ${res.statusCode}: ${errBody.substring(0, 200)}`)));
          return;
        }

        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              const token = obj?.message?.content || '';
              if (token) {
                fullText += token;
                if (onToken) onToken(token);
              }
              if (obj.done) {
                resolve({ text: fullText, model, provider: 'ollama', tokensUsed: Math.ceil(fullText.length / 4) });
              }
            } catch { /* skip malformed lines */ }
          }
        });
        res.on('end', () => {
          if (buf.trim()) {
            try {
              const obj = JSON.parse(buf);
              const token = obj?.message?.content || '';
              if (token) { fullText += token; if (onToken) onToken(token); }
            } catch { /* ignore */ }
          }
          resolve({ text: fullText, model, provider: 'ollama', tokensUsed: Math.ceil(fullText.length / 4) });
        });
        res.on('error', reject);
      });

      req.on('error', (err) => reject(new Error(`Ollama connection failed: ${err.message}. Is Ollama running? (ollama serve)`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('Ollama request timed out after 120s')); });
      req.write(body);
      req.end();
    });
  }

  // ─── APIFreeLLM generation (custom non-OpenAI format) ───────────────────────

  async _generateAPIFreeLLM(apiKey, systemPrompt, prompt, options, onToken, conversationHistory = []) {
    const now = Date.now();
    const elapsed = now - this._apifreellmLastRequest;
    if (elapsed < 5000) {
      const waitMs = 5000 - elapsed;
      console.log(`[CloudLLM] APIFreeLLM throttle: waiting ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
    }
    this._apifreellmLastRequest = Date.now();

    const endpoint = this._getEndpoint('apifreellm');
    let fullMessage = '';
    if (systemPrompt) fullMessage += `[System: ${systemPrompt}]\n\n`;
    for (const msg of conversationHistory) {
      fullMessage += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n\n`;
    }
    fullMessage += `User: ${prompt}`;

    const body = JSON.stringify({ message: fullMessage, model: 'apifreellm' });

    try {
      const data = await this._makeRequest(endpoint.host, endpoint.path, apiKey, body, {}, 'apifreellm');
      const parsed = JSON.parse(data);
      if (!parsed.success) throw new Error(parsed.error || 'APIFreeLLM returned an error');

      const text = parsed.response || '';
      if (onToken && text) {
        for (const word of text.split(' ')) onToken(word + ' ');
      }
      return { text, model: 'APIFreeLLM 200B+', tokensUsed: Math.ceil(text.length / 4) };
    } catch (error) {
      if (error.message && error.message.includes('429')) {
        throw new Error('APIFreeLLM rate limit — free tier allows 1 request every 5 seconds. Please wait and retry.');
      }
      throw error;
    }
  }

  // ─── HTTP request helpers ───────────────────────────────────────────────────

  _makeRequest(host, path, apiKey, body, extraHeaders = {}, provider = null) {
    return new Promise((resolve, reject) => {
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...extraHeaders,
      };
      if (apiKey && !extraHeaders['x-api-key']) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const req = https.request({ host, path, method: 'POST', headers, agent: keepAliveAgent }, (res) => {
        if (provider && res.statusCode < 400) {
          this._learnRPMFromHeaders(provider, res.headers);
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 400) {
            this._rejectWithParsedError(reject, res.statusCode, data, provider || host);
          } else {
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(20000, () => {
        req.destroy();
        reject(new Error(`Request timeout to ${host}. Try again or switch models.`));
      });
      req.write(body);
      req.end();
    });
  }

  _rejectWithParsedError(reject, statusCode, data, source) {
    let errMsg = `API error ${statusCode}: ${data.substring(0, 300)}`;
    try {
      const errObj = JSON.parse(data);
      const msg = errObj?.error?.message || errObj?.error || data.substring(0, 300);
      const code = errObj?.error?.code || statusCode;

      if (code !== 429) {
        console.error(`[CloudLLM] API error from ${source}: HTTP ${statusCode} / code=${code} — ${String(msg).substring(0, 200)}`);
      }

      if (code === 429) {
        errMsg = 'Rate limited (429). Free model quota exhausted. Try switching to a different model or wait a few minutes.';
      } else if (code === 404) {
        errMsg = 'Model not found (404). It may have been removed or renamed. Try a different model.';
      } else if (code === 400 && String(msg).toLowerCase().includes('decommission')) {
        errMsg = 'This model has been decommissioned. Please select a different model.';
      } else if (code === 400 && (String(msg).includes('not enabled') || String(msg).toLowerCase().includes('developer instruction'))) {
        errMsg = `Model error (400): ${msg}. This model doesn't support system prompts. Try a different model.`;
      } else {
        errMsg = `API error ${code}: ${msg}`;
      }
    } catch {
      console.error(`[CloudLLM] API error from ${source}: HTTP ${statusCode} — ${data.substring(0, 200)}`);
    }
    reject(new Error(errMsg));
  }

  /**
   * Drop the in-flight Cloud HTTP request. The P40 slot stays busy until this
   * socket closes; leaving it open makes the next message continue that generation.
   */
  abortActiveStream() {
    const active = this._activeStream;
    if (!active) return false;
    this._activeStream = null;
    const err = new Error('Generation cancelled');
    err.code = 'ABORTED';
    try { active.clearTimers(); } catch (_) {}
    try { active.req.setTimeout(0); } catch (_) {}
    try { active.req.destroy(); } catch (_) {}
    try { active.finishReject(err); } catch (_) {}
    return true;
  }

  _streamRequest(host, path, apiKey, body, format, onToken, extraHeaders = {}, onThinkingToken = null, provider = null, streamIdleMs = IDLE_TIMEOUT, firstByteMs = STREAM_TIMEOUT, onStreamQuiet = null, tlsServername = null) {
    this.abortActiveStream();
    return new Promise((resolve, reject) => {
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...extraHeaders,
      };
      if (apiKey && !extraHeaders['x-api-key']) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      if (tlsServername && !headers.Host) headers.Host = tlsServername;

      let fullText = '';
      let stopReason = null;
      let promptTokens = 0;
      let rawBody = '';
      let sawSse = false;
      let firstDataTimer = null;
      let idleTimer = null;
      let silenceWatch = null;
      let firstByteWatch = null;
      let lastSseAt = 0;
      let silenceWarned = false;
      let firstByteWarned = false;
      let settled = false;
      let socketStall = null;
      const waitStartedAt = Date.now();
      const firstByte = firstByteMs > 0 ? firstByteMs : STREAM_TIMEOUT;

      const clearTimers = () => {
        if (firstDataTimer) { clearTimeout(firstDataTimer); firstDataTimer = null; }
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        if (silenceWatch) { clearInterval(silenceWatch); silenceWatch = null; }
        if (firstByteWatch) { clearInterval(firstByteWatch); firstByteWatch = null; }
      };

      // StreamWaitLive1: UI must see progress during prefill (before any SSE token).
      // Silence watch only armed after first SSE — first-byte wait was invisible for up to 900s.
      const armFirstByteWatch = () => {
        if (firstByteWatch || typeof onStreamQuiet !== 'function') return;
        firstByteWatch = setInterval(() => {
          if (settled || lastSseAt) return;
          const ageMs = Date.now() - waitStartedAt;
          if (ageMs < 5000) return;
          try {
            onStreamQuiet({ ageMs, host, provider, phase: 'first-byte' });
          } catch (_) { /* ignore UI callback errors */ }
          firstByteWarned = true;
        }, 5000);
      };

      const armSilenceWatch = () => {
        if (silenceWatch || typeof onStreamQuiet !== 'function') return;
        silenceWatch = setInterval(() => {
          if (!lastSseAt || settled) return;
          const ageMs = Date.now() - lastSseAt;
          if (ageMs >= PROXY_SILENCE_RESUME_MS) {
            console.error(`[CloudLLM] Stream silence resume: no SSE for ${Math.round(ageMs / 1000)}s from ${host} (provider=${provider || 'unknown'})`);
            try { req.destroy(); } catch (_) {}
            settle(reject, new Error(`Stream stalled from ${host}. Try again or switch models.`));
            return;
          }
          if (ageMs >= PROXY_SILENCE_WARN_MS) {
            silenceWarned = true;
            try {
              onStreamQuiet({ ageMs, host, provider, phase: 'mid-stream' });
            } catch (_) { /* ignore UI callback errors */ }
          }
        }, 5000);
      };

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        if (this._activeStream && this._activeStream.req === req) this._activeStream = null;
        clearTimers();
        try { req.setTimeout(0); } catch (_) {}
        fn(value);
      };

      const reqOpts = {
        host,
        path,
        method: 'POST',
        headers,
        agent: keepAliveAgent,
      };
      if (tlsServername) reqOpts.servername = tlsServername;
      const req = https.request(reqOpts, (res) => {
        if (provider && res.statusCode < 400) {
          this._learnRPMFromHeaders(provider, res.headers);
        }

        if (res.statusCode >= 400) {
          clearTimers();
          let errData = '';
          res.on('data', chunk => errData += chunk);
          res.on('end', () => {
            let errMsg = `API error ${res.statusCode}: ${errData.substring(0, 500)}`;
            try {
              const errObj = JSON.parse(errData);
              const msg = errObj?.error?.message || errObj?.error || errData.substring(0, 300);
              if (res.statusCode === 429) {
                errMsg = 'Rate limited (429). Pool rotation will handle this.';
              } else if (res.statusCode === 400) {
                const msgLower = String(msg).toLowerCase();
                if (msgLower.includes('decommission')) {
                  errMsg = 'This model has been decommissioned. Please select a different model.';
                } else if (msgLower.includes('not enabled') || msgLower.includes('developer instruction')) {
                  errMsg = "This model doesn't support system/developer prompts. Try a different model.";
                } else {
                  errMsg = `Model error (400): ${msg}`;
                }
              } else if (res.statusCode === 404) {
                errMsg = 'Model not found (404). It may have been removed or renamed. Try a different model.';
              } else {
                errMsg = `API error ${res.statusCode}: ${msg}`;
              }
            } catch { /* use default errMsg */ }
            settle(reject, new Error(errMsg));
          });
          return;
        }

        // Cache successful connect peer for later ENOTFOUND recovery (hostname requests only).
        if (!tlsServername && host && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
          try {
            const peer = req.socket?.remoteAddress;
            if (peer && !peer.includes(':')) {
              _proxyHostIpCache.set(host, { ip: peer, at: Date.now() });
            }
          } catch (_) { /* ignore */ }
        }

        let buffer = '';
        let gotFirstSse = false;

        armFirstByteWatch();
        // WaitCopy1: do NOT paint age=0 "Waiting for model" into chat. That lied after
        // tool rounds (prose+tools already on screen) and flashed every new generate.
        // First-byte watch starts reporting only after 5s of real prefill silence.

        firstDataTimer = setTimeout(() => {
          console.error(`[CloudLLM] Stream timeout: no SSE data within ${firstByte / 1000}s from ${host}`);
          req.destroy();
          settle(reject, new Error(`No response from ${host} within ${firstByte / 1000}s. The model may be overloaded. Try again or switch models.`));
        }, firstByte);

        const armIdle = streamIdleMs > 0;
        const effectiveIdle = armIdle ? streamIdleMs : IDLE_TIMEOUT;
        const resetIdleTimer = () => {
          if (!armIdle) return;
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            console.error(`[CloudLLM] Stream idle timeout: no SSE for ${effectiveIdle / 1000}s from ${host} (provider=${provider || 'unknown'})`);
            req.destroy();
            if (fullText) {
              settle(resolve, { text: fullText, model: 'cloud', tokensUsed: fullText.length / 4, stopReason, promptTokens });
            } else {
              settle(reject, new Error(`Stream stalled from ${host}. Try again or switch models.`));
            }
          }, effectiveIdle);
        };

        res.on('data', (chunk) => {
          const chunkText = chunk.toString();
          rawBody += chunkText;
          buffer += chunkText;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          // stallnever1: only SSE `data:` lines clear first-byte / arm idle.
          // Empty proxy TCP chunks during P40 prefill must NOT start the idle clock.
          let sawSseLine = false;
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            sawSseLine = true;
            sawSse = true;
            lastSseAt = Date.now();
            silenceWarned = false;
            if (!gotFirstSse) {
              gotFirstSse = true;
              if (firstDataTimer) { clearTimeout(firstDataTimer); firstDataTimer = null; }
              if (firstByteWatch) { clearInterval(firstByteWatch); firstByteWatch = null; }
              try {
                req.setTimeout(0);
                if (socketStall) req.removeListener('timeout', socketStall);
              } catch (_) {}
              armSilenceWatch();
            }
            const jsonStr = line.slice(6).trim();
            if (jsonStr === '[DONE]') continue;

            try {
              const parsed = JSON.parse(jsonStr);
              if (parsed && parsed.error) {
                const errMsg = parsed.error.message || parsed.error.code || JSON.stringify(parsed.error).slice(0, 300);
                const code = parsed.error.code || 500;
                console.error(
                  `[CloudLLM] SSE error payload code=${code}: ${String(errMsg).slice(0, 800)}`
                  + (options?.images?.length ? ` visionImages=${options.images.length}` : ''),
                );
                req.destroy();
                const e = new Error(`upstream ${code}: ${String(errMsg).slice(0, 400)}`);
                e.statusCode = typeof code === 'number' ? code : 500;
                e.upstreamError = true;
                settle(reject, e);
                return;
              }
              let token = '';
              let thinkingToken = '';

              if (format === 'openai') {
                const choice = parsed.choices?.[0];
                const delta = choice?.delta;
                token = delta?.content || '';
                thinkingToken = delta?.reasoning_content || delta?.reasoning || '';
                if (choice?.finish_reason) stopReason = choice.finish_reason;
                const measuredTokens = serverPromptTokens(parsed);
                if (measuredTokens > 0) promptTokens = measuredTokens;
              } else if (format === 'anthropic') {
                if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'thinking') {
                  // Thinking block start
                } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'thinking_delta') {
                  thinkingToken = parsed.delta?.thinking || '';
                } else if (parsed.type === 'content_block_delta') {
                  token = parsed.delta?.text || '';
                }
              }

              if (thinkingToken && onThinkingToken) onThinkingToken(thinkingToken);
              if (token) {
                fullText += token;
                if (onToken) onToken(token);
              }
            } catch { /* skip malformed JSON */ }
          }
          if (sawSseLine) resetIdleTimer();
        });

        res.on('end', () => {
          if (!fullText && !sawSse) {
            const parsedBody = parseCompletionBody(rawBody);
            if (parsedBody.text) fullText = parsedBody.text;
            if (parsedBody.stopReason && !stopReason) stopReason = parsedBody.stopReason;
            if (parsedBody.promptTokens && !promptTokens) promptTokens = parsedBody.promptTokens;
          }
          const sseLines = rawBody.split('\n').filter((l) => l.startsWith('data: '));
          const streamDiag = {
            httpStatus: res.statusCode,
            sawSse,
            rawBodyLen: rawBody.length,
            finish_reason: stopReason,
            textLen: fullText.length,
            sseCount: sseLines.length,
            firstSse: sseLines[0] ? String(sseLines[0]).slice(0, 160) : '',
            lastSse: sseLines.length ? String(sseLines[sseLines.length - 1]).slice(0, 160) : '',
          };
          if (!fullText) {
            console.warn(`[CloudLLM] empty stream ${JSON.stringify(streamDiag)}`);
          }
          settle(resolve, {
            text: fullText,
            model: 'cloud',
            tokensUsed: fullText.length / 4,
            stopReason,
            promptTokens,
            streamDiag,
          });
        });
      });

      this._activeStream = {
        req,
        clearTimers,
        finishReject: (err) => settle(reject, err),
      };

      req.on('error', (err) => {
        settle(reject, err?.code === 'ABORTED' ? err : err);
      });
      socketStall = () => {
        if (settled) return;
        console.error(`[CloudLLM] Socket timeout from ${host} after ${firstByte / 1000}s`);
        req.destroy();
        settle(reject, new Error(`Connection timeout to ${host}. Try again or switch models.`));
      };
      req.setTimeout(firstByte, socketStall);
      req.write(body);
      req.end();
    });
  }

  // ─── Status ─────────────────────────────────────────────────────────────────

  /** Latest cooldown expiry for a provider (pool keys + provider-level). */
  getRateLimitCooldownUntil(provider) {
    const now = Date.now();
    let until = this._rateLimitedUntil[provider] || 0;
    const pool = this._keyPools[provider];
    if (pool) {
      for (const entry of pool) {
        if (entry.cooldownUntil > until) until = entry.cooldownUntil;
      }
    }
    return until > now ? until : null;
  }

  getStatus() {
    const configured = this.getConfiguredProviders();
    return {
      hasKeys: configured.length > 0,
      providers: configured.map(p => p.provider),
      activeProvider: this.activeProvider,
      activeModel: this.activeModel,
    };
  }
}

module.exports = {
  CloudLLMService,
  PROVIDER_MODELS,
  PROVIDER_LABELS,
  BUNDLED_PROVIDERS,
  SECRYPT_QUALITY_MODEL,
  SECRYPT_CONTEXT_DEFAULT,
  resolveSecryptCloudModel,
  parseCompletionBody,
  textFromCompletionBody,
  resolveCloudOutputTokens,
  resolveThinkingBudgetForEffort,
  secryptQualitySampling,
};
