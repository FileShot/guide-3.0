---
name: goal
description: Set a goal that guIDE will pursue to completion.
requires: args
---
# Goal

Use a durable, tool-driven flow. There is no deadline, token budget, or turn budget.

## Parse
Accept `/goal <objective>`. If the objective is empty, the caller shows usage and does not arm a goal. A leading time limit such as `30m` is not a deadline. Recurring work belongs to `/loop`.

## Start
Restate the objective, including every deliverable you will verify in the project. Do the first concrete unit of work in this turn. Do not stop after planning.

## Continuation
The goal stays active across turns. Do not shrink the objective to what fits in one reply. If you cannot finish now, make real progress and leave the goal active.

## Completion
Before you decide the goal is done, treat completion as unproven. For every requirement, inspect the current files or command output. A promise, a directory listing, or a plan is not completion. If any requirement is missing or unverified, keep calling tools. When every requirement is true in the project, reply with GOAL_COMPLETE and a short summary.
