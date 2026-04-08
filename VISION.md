# guIDE 3.0 — Vision

## What Is guIDE

guIDE is a **Visual Studio Code clone for offline local LLMs**. It is a local-first, offline-capable AI IDE. The entire value proposition is running language models locally with zero cloud dependency — no subscriptions, no API keys, no internet required for core functionality.

The quality target is **Visual Studio Code + GitHub Copilot**, but running entirely locally. It ships to real end users on all hardware configurations from 4GB GPU laptops to 128GB RAM workstations, running 0.5B to 200B parameter models.

Every piece of code in this project must be **production-grade, triple-A, $1,000,000 quality**. No shortcuts. No band-aids. No test-specific code. No model-specific code. No hardware-specific code.

---

## The Core Goal

**Context size should NOT matter.**

A model with a 2,000 token context window should be able to print a MILLION lines of code — coherently, from start to finish, without losing track, without restarting, without content regression.

The pipeline must make context size invisible to the user. Whether the model has 2K context or 128K context, the user experience must be identical: start a task, the model works through it, the output is complete and coherent.

---

## What Success Looks Like

- User asks for a large, complex file (e.g., "build me a complete web application")
- Model starts writing the file
- Model's context window fills up
- Context rotation fires — history is compressed, model continues from where it left off
- File grows monotonically — line count NEVER drops, NEVER restarts from scratch
- If the model hits maxTokens, seamless continuation picks up exactly where it left off
- Final output is ONE coherent, complete file with proper opening and closing structures
- The user never knows a context shift happened — it's invisible

---

## What Failure Looks Like

These are the specific failure modes that must NEVER occur:

1. **Line count drops** — content lost during continuation or rotation
2. **Model restarts from scratch** — loses awareness of what it already wrote
3. **Duplicate content** — same functions, sections, or code blocks repeated
4. **Model stalls** — generation hangs during continuation or rotation
5. **Model loses track** — forgets what it was building, switches topics
6. **Filename changes** — model creates a different file after rotation (lost context)
7. **Naked code in chat** — raw code appearing outside code blocks in the UI
8. **Multiple fragmented code blocks** — output split into disconnected pieces instead of one coherent block
9. **JSON/tool artifacts in file content** — pipeline metadata leaking into generated files
10. **Instruction echo** — pipeline instructions appearing verbatim in generated content
11. **Infinite loops** — model keeps generating without terminating
12. **Think tags in output** — internal reasoning tokens appearing in user-visible content

---

## The Pipeline — What Needs To Be Built

The pipeline is the system that sits between the user and the bare model. It has THREE jobs:

### 1. Seamless Continuation
When the model hits maxTokens mid-generation, the pipeline automatically continues the response without user intervention. The output must stitch together seamlessly — no visible seams, no duplicate content, no lost content.

### 2. Context Summarization
When conversation history grows long, the pipeline summarizes earlier turns to free up context space. The summary must preserve: the user's original goal, what files have been created, what work is done vs pending, key decisions made.

### 3. Context Rotation (Context Shift)
When the model's context window fills up during generation, the pipeline compresses history intelligently and lets the model continue from where it was. The model must remember what it was writing, where it left off, and what the structure of the file looks like.

**These three systems must work together seamlessly.** The entire pipeline should be simple — potentially one file. It should NOT be thousands of lines of over-engineered code with dozens of edge-case handlers, band-aid fixes, and defensive guards.

---

## Architecture Principle — Simplicity

The pipeline for context management should be SIMPLE. The problem is fundamentally straightforward:

1. Model generates tokens
2. Context fills up → compress history, keep current work context
3. Model continues generating from where it left off
4. Seamless to the user

This does not require 10 files and 5,000 lines of code. It requires ONE clean, well-designed system that handles all three jobs correctly from the start. If the implementation is complex, the design is wrong.

---

## Research-First Approach

Before writing ANY pipeline code:

1. **Research existing implementations** — find proven, working context rotation systems for local LLMs
2. **Study how others solved it** — look at open-source projects, academic papers, blog posts
3. **Find forkable implementations** — if someone already built a working system, use it or learn from it
4. **Understand the problem deeply** — before writing code, understand every edge case
5. **Build it right the first time** — no iteration loops, no fix cycles, no band-aids

The pipeline will implement **6 different context rotation strategies** behind a common interface. Test all 6. Whichever one passes the test battery cleanly gets shipped. The others get deleted.

---

## Non-Negotiable Standards

- **Production quality** — every line of code must be production-grade
- **Hardware-agnostic** — must work on 4GB GPU laptops through 128GB workstations
- **Model-agnostic** — must work with 0.5B through 200B parameter models
- **Context-agnostic** — must work with 2K through 128K context windows
- **No band-aids** — if a bug is found, the entire pipeline implementation gets rebuilt, not patched
- **No fix loops** — if the first implementation has bugs, it's destroyed and rebuilt from scratch with a different approach
- **No shortcuts** — quality over speed, always
- **No test-specific code** — every line must work for ALL users with ALL prompts
