---
description: "Use when responding in chat, planning edits, reporting status, or closing any response in this workspace. Enforces the RULE CHECK header, the pre-code checklist before edits, the testing tripwire, and vscode_askQuestions as the final action."
applyTo: "**"
---

# Response Discipline

- Start every response with the RULE CHECK header.
- Immediately after the RULE CHECK header, include the exact plain-text sentence: "I am going to end this response with the VS Code ask questions tool."
- Immediately after that, include the exact plain-text sentence: "Does this response end with the VS Code ask questions tool? It must."
- If a file edit is about to happen, stop and display the PRE-CODE CHECKLIST first.
- If a test is about to run, re-read RULES.md Section 9 and write TRIPWIRE 4 CLEARED with line numbers.
- Suggest an approach only after cross-referencing failure history and writing TRIPWIRE 3 CLEARED or TRIPWIRE 3 WARNING.
- Before sending any response, ask what the last action in the turn is.
- If the last action is not vscode_askQuestions, stop and add it.
- Mechanical gate required before send: run `powershell -ExecutionPolicy Bypass -File c:\\Users\\brend\\guide-3.0\\scripts\\askquestions-gate.ps1 -GatePath c:\\Users\\brend\\guide-3.0\\.copilot\\askquestions-gate.json -ResponsePath <draft-response-file>` and require `ASKQUESTIONS_GATE_PASS`.
- The draft response file MUST end with `[FINAL_ACTION] vscode_askQuestions` as the last non-empty line.
- The RULE CHECK line is not compliance by itself. The tool itself must actually run.
- Scan the last non-tool line before send. If it is plain text, do not send yet.
- Never write a closing sentence first and then remember the tool.
- Nothing may appear after the vscode_askQuestions tool call.

## MAXIMUM REINFORCEMENT — ASK QUESTIONS TOOL IS NON-NEGOTIABLE

- This rule has been violated multiple times in succession. Effective immediately:
- The `vscode_askQuestions` tool call is the HARD CLOSING ACTION of EVERY response. No prose, no headers, no tool results, no confirmations after it. Ever.
- Before emitting any response, perform this literal mental check in this order:
  1. "Is my last planned action a `vscode_askQuestions` call?" — if no, STOP and add it.
  2. "Does any text, code, or tool call follow the `vscode_askQuestions` call?" — if yes, STOP and remove it.
  3. Only after both answers are correct, the response may send.
- If you catch yourself drafting a response without `vscode_askQuestions` at the end, the draft is invalid. Discard and restart.
- If you are uncertain what to ask, the default questions are: "Proceed with this plan?" and "Anything to change before I implement?" — ALWAYS a valid closing.
- Summaries, status reports, error messages, blocked states, "I'm stuck" moments, interruptions, apologies, and acknowledgements of rule violations ALL end with `vscode_askQuestions`. No exceptions. An apology without the tool call is itself a rule violation.
- This rule has priority over ALL other output conventions, including brevity, markdown formatting, and response length targets. If the response would be too long to include the tool, truncate the prose, not the tool.
- When in doubt, ask a question. Never close with a statement.