---
name: automate
description: Create a script or scheduled workflow in this project.
requires: args
---
# Automate

The argument is the workflow to build in this project.

If trigger, action, or outcome is missing, ask one short question and wait. Otherwise:
1. Add the script or config with write_file.
2. Wire a way to run it (package.json script, or a documented command).
3. Run it once with run_command.
4. Report the command and the result.

Prefer a small script over a framework.
