# guIDE 3.0 — Copilot Instructions (MANDATORY)

> **TRIPWIRE 0: If you are reading this, you MUST read RULES.md in its entirety BEFORE responding. No exceptions. No "I already read it." Read it NOW.**

## FORCED RULE READING

Before EVERY tool call, EVERY file edit, EVERY terminal command, EVERY suggestion, EVERY sentence you write:

1. Confirm you have read RULES.md this session (all 543 lines, all 16 sections)
2. Confirm you have read /memories/guide-master.md this session
3. If you have NOT read both files IN FULL this session, STOP and read them NOW

## RULE CHECK HEADER (MANDATORY — EVERY RESPONSE)

The FIRST thing in EVERY response MUST be:

```
RULE CHECK:
- Read RULES.md this session? [YES — all 543 lines / NO — reading now]
- Read guide-master.md this session? [YES — all 363 lines / NO — reading now]
- About to edit a file? → STOP. Display PRE-CODE CHECKLIST first. (RULES.md Section 7)
- About to run a test? → STOP. Re-read Section 9. Write TRIPWIRE 4 CLEARED with line numbers.
- About to suggest anything? → STOP. Cross-reference failure history. Write TRIPWIRE 3 CLEARED.
- This response ends with vscode_askQuestions? → [YES/NO — if NO, add it now]
```

If this header is missing from ANY response, the agent violated the rules.

## THE FIVE QUESTIONS (ask before EVERY code change)

Before writing ANY code, answer ALL FIVE in your response:

1. **Would a VS Code + Copilot engineer write this?** If this change would look out of place in Microsoft's VS Code codebase, do NOT make it.
2. **Does this work for ALL models (0.5B to 200B)?** If it only helps one model or one model size, do NOT make it.
3. **Does this work for ALL hardware (4GB to 128GB)?** If it has hardcoded numbers, thresholds, line counts, or token counts, do NOT make it.
4. **Does this work for ALL prompts?** If it only helps with the test prompt that revealed the bug, do NOT make it.
5. **Is this a band-aid or a root cause fix?** If it responds to a problem AFTER it happens instead of preventing it, do NOT make it.

If ANY answer is NO, do NOT write the code. Present the problem to the user and discuss alternatives.

## PLAN BEFORE CODE (MANDATORY)

- The plan and the implementation are ALWAYS two separate responses.
- Present the plan. Wait for approval. THEN implement.
- "Implementation loop mode" does NOT override this. The user revoked free-implementation permission.
- If you edit a file without presenting a plan and getting explicit "go ahead" first, you violated this rule.

## BANNED CHANGES (never make these)

- Hardcoded numbers (line counts, token counts, iteration limits, thresholds)
- Model-specific formats, prompts, or configurations
- Test-specific fixes that only help one test scenario
- Detection mechanisms, keyword detectors, regex heuristics, pattern matching
- Post-hoc remediation (fixing output AFTER bad generation instead of preventing it)
- Any code that checks for specific words, phrases, or file types
- Any parameter that names a specific model, context size, or hardware spec

## BANNED PHRASES (never say these)

- "Context window too small" — the pipeline exists to eliminate this constraint
- "Model capability issue" / "the 2B model can't" — fix the pipeline, not the model
- "A larger model would handle this" — optimize the pipeline first
- "Confirmed" / "fixed" / "resolved" / "ready" / "working" — these are lies without proof
- "This should fix it" — you cannot verify. Only the user can.

## RESPONSE ENDING (MANDATORY)

Every response MUST end with vscode_askQuestions. No exceptions. No prose endings. No summaries without the tool call. If the last action in your response is not vscode_askQuestions, you violated this rule.

## THE PROJECT GOAL (memorize this)

Context size must NOT matter. A model with a 2,000 token context window must be able to generate a MILLION lines of code coherently. The three pipeline systems (seamless continuation, context summarization, context rotation) exist to make this possible. If generation doesn't complete, the PIPELINE is broken — not the context window.

## TESTING

- Tests run through the BROWSER at http://localhost:3000. NEVER via scripts, WebSocket clients, or direct API calls.
- NEVER create test scripts. The frontend IS the test harness.
- NEVER copy from guide-2.0. Guide-2.0 is a failure. That's why guide-3.0 exists.

## MEMORY FILES

Read /memories/guide-master.md every session. It contains the complete rules reference, violation history, and project context. If your context rotates, re-read it.

## POST-CONTEXT-ROTATION RECOVERY

If you suspect your context has been summarized or rotated:
1. Re-read RULES.md (all of it)
2. Re-read /memories/guide-master.md (all of it)
3. Re-read CHANGES_LOG.md
4. Check git diff to see current state
5. THEN respond — not before
