/**
 * GLM thinking-capable models (GLM-4.6, GLM-4.7, etc.) use a Jinja chat template where
 * enable_thinking=true does NOT inject `<think>` in add_generation_prompt.
 * The model may emit reasoning text and only close with `</think>` (no open tag).
 *
 * node-llama-cpp's SegmentHandler routes bytes by open/close segment tokens. Without a forced-open
 * at generation start, reasoning leaks to onTextChunk (visible chat) until an orphan close tag.
 *
 * Fix: extend JinjaTemplateChatWrapper.generateContextState to set noPrefixTrigger — the same
 * mechanism HarmonyChatWrapper uses for gpt-oss. This is template-metadata wiring, not output sniffing.
 *
 * Ref: GLM-4.6 chat_template.jinja (zai-org), llama.cpp issue #21465, node-llama-cpp SegmentHandler.
 */

/**
 * @param {typeof import('node-llama-cpp').JinjaTemplateChatWrapper} JinjaTemplateChatWrapper
 * @param {typeof import('node-llama-cpp').LlamaText} LlamaText
 * @param {typeof import('node-llama-cpp').SpecialTokensText} SpecialTokensText
 */
export function createGlmThinkingJinjaChatWrapper(JinjaTemplateChatWrapper, LlamaText, SpecialTokensText) {
  return class GlmThinkingJinjaChatWrapper extends JinjaTemplateChatWrapper {
    generateContextState(options) {
      const state = super.generateContextState(options);
      const thinkingEnabled = this.additionalRenderParameters?.enable_thinking === true;
      const thoughtSeg = this.settings?.segments?.thought;
      if (!thinkingEnabled || thoughtSeg?.prefix == null) {
        return state;
      }

      // Force-open thought segment when generation starts without an explicit open tag.
      // inject uses the same prefix token(s) defined by thoughtTemplate / template auto-detect.
      return {
        ...state,
        noPrefixTrigger: {
          type: 'segment',
          segmentType: 'thought',
          inject: LlamaText(thoughtSeg.prefix),
        },
      };
    }
  };
}
