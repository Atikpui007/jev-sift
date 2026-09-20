---
name: jev-sift
description: jev-sift helpers. Use when the user types /jev-sift with last or status.
argument-hint: last | status
---

The user typed `/jev-sift $ARGUMENTS`. Do the matching action, then confirm in one short line.

To turn the filter off, the user runs `/plugin` and disables jev-sift; to turn it back on, enables it. Do not try to do this yourself.

- `last`   → show what the filter cut on the most recent call that cut something, with one Bash command:
  `jq -r -s '[.[] | select(.action=="filtered" and (.dropped // 0) > 0)] | last | "\(.tool_name): cut \(.dropped) of \(.total)\n" + ([.decisions[] | select(.kept|not) | "  hide=\(.hide)  \(.candidate|.[0:160])"] | join("\n"))' .claude/hook-logs/jev-sift.jsonl`
  Then, if any cut item looks needed for the current task, say so and offer to disable jev-sift in `/plugin` and re-run.
- `status` or no argument → run `jq -r -s '{calls: length, cut: (map(.dropped // 0) | add // 0), chars_removed: (map(.chars_removed // 0) | add // 0)}' .claude/hook-logs/jev-sift.jsonl` and report the totals.
