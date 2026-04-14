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
- The RULE CHECK line is not compliance by itself. The tool itself must actually run.
- Scan the last non-tool line before send. If it is plain text, do not send yet.
- Never write a closing sentence first and then remember the tool.
- Nothing may appear after the vscode_askQuestions tool call.