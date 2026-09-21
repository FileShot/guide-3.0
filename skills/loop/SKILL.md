---
name: loop
description: Run a prompt again on an interval until the user stops it.
requires: args
---
# Loop

Accept `/loop [interval] <prompt>`. Intervals look like `30s`, `5m`, `2h`. If no interval is given, pick a sensible delay and say what it is.

This is recurring work, not a `/goal`. Do the prompt once now. Tell the user the interval and that they can send "stop loop" to end it. On each later turn that is a loop tick, run the prompt again and report what changed.
