/**
 * Diagnostic script: check which ChatWrapper node-llama-cpp auto-detects for each model family.
 * This is research — not application testing. It loads each model, creates LlamaChat,
 * and reports the wrapper name and function calling settings.
 */

import { getLlama, LlamaChat } from 'node-llama-cpp';
import { fileURLToPath } from 'url';
import path from 'path';

const MODELS = [
  // One small model per family
  { label: 'Qwen3.5-2B',     path: 'D:\\models\\qwen3.5\\Qwen3.5-2B-GGUF\\Qwen3.5-2B-Q8_0.gguf' },
  { label: 'Qwen3.5-0.8B',   path: 'D:\\models\\qwen3.5\\Qwen3.5-0.8B-GGUF\\Qwen3.5-0.8B-Q8_0.gguf' },
  { label: 'Qwen3-0.6B',     path: 'D:\\models\\StaffPix\\Qwen3-0.6B-Q8_0.gguf' },
  { label: 'Qwen2.5-0.5B',   path: 'D:\\models\\tiny\\qwen2.5-0.5b-instruct-q8_0.gguf' },
  { label: 'Qwen2.5-1.5B',   path: 'D:\\models\\tiny\\qwen2.5-1.5b-instruct-q8_0.gguf' },
  { label: 'Llama3.2-1B',    path: 'D:\\models\\StaffPix\\llama-3.2-1b-instruct-q8_0.gguf' },
  { label: 'Gemma3-1B',      path: 'D:\\models\\tiny\\gemma-3-1b-it-Q8_0.gguf' },
  { label: 'EXAONE4-1.2B',   path: 'D:\\models\\tiny\\EXAONE-4.0-1.2B-Q8_0.gguf' },
  { label: 'SmolLM2-360M',   path: 'D:\\models\\tiny\\SmolLM2-360M-Instruct-Q8_0.gguf' },
  { label: 'DeepSeek-R1-1.5B', path: 'D:\\models\\StaffPix\\DeepSeek-R1-Distill-Qwen-1.5B-Q8_0.gguf' },
  { label: 'LFM2.5-1.2B',    path: 'D:\\models\\tiny\\LFM2.5-1.2B-Instruct-Q6_K.gguf' },
  { label: 'Phi4-Mini',      path: 'D:\\models\\small\\Phi-4-mini-instruct.Q4_K_M.gguf' },
];

async function main() {
  const llama = await getLlama({ gpu: 'auto' });
  const results = [];

  for (const entry of MODELS) {
    try {
      console.log(`\n--- Loading: ${entry.label} ---`);
      const model = await llama.loadModel({
        modelPath: entry.path,
        gpuLayers: 0, // CPU only for speed — wrapper detection doesn't use GPU
        ignoreMemorySafetyChecks: true,
      });

      const arch = model.fileInfo?.metadata?.general?.architecture || 'unknown';
      
      const ctx = await model.createContext({
        contextSize: 512, // Minimal — just need wrapper detection
        ignoreMemorySafetyChecks: true,
      });
      const seq = ctx.getSequence();
      const chat = new LlamaChat({ contextSequence: seq });

      const wrapperName = chat.chatWrapper?.wrapperName || 'unknown';
      const funcSettings = chat.chatWrapper?.settings?.functions;
      const callPrefix = funcSettings?.call?.prefix?.toString?.() || 'none';
      const hasJinjaFuncTemplate = chat.chatWrapper?._usingJinjaFunctionCallTemplate;

      results.push({
        label: entry.label,
        architecture: arch,
        wrapper: wrapperName,
        jinjaFuncTemplate: hasJinjaFuncTemplate,
        callPrefixSnippet: callPrefix.substring(0, 80),
      });

      console.log(`  Architecture: ${arch}`);
      console.log(`  Wrapper: ${wrapperName}`);
      console.log(`  _usingJinjaFunctionCallTemplate: ${hasJinjaFuncTemplate}`);
      console.log(`  Call prefix: ${callPrefix.substring(0, 80)}`);

      // Cleanup
      chat.dispose?.();
      seq.dispose?.();
      ctx.dispose?.();
      model.dispose?.();
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      results.push({ label: entry.label, error: err.message });
    }
  }

  console.log('\n\n=== SUMMARY ===');
  console.log('Label'.padEnd(22) + 'Architecture'.padEnd(15) + 'Wrapper'.padEnd(20) + 'JinjaFunc'.padEnd(12) + 'Call Prefix');
  console.log('-'.repeat(100));
  for (const r of results) {
    if (r.error) {
      console.log(`${r.label.padEnd(22)} ERROR: ${r.error}`);
    } else {
      console.log(
        `${r.label.padEnd(22)}${r.architecture.padEnd(15)}${r.wrapper.padEnd(20)}${String(r.jinjaFuncTemplate).padEnd(12)}${r.callPrefixSnippet}`
      );
    }
  }

  await llama.dispose();
}

main().catch(console.error);
