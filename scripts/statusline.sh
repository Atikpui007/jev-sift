#!/usr/bin/env bash
PLUGIN_ID="jev-sift@jev-sift"
input=$(cat)
sid=$(jq -r '.session_id // ""' <<<"$input")
dir=$(jq -r '.workspace.project_dir // .cwd // ""' <<<"$input")
cfg=$(jq -c --arg id "$PLUGIN_ID" '{enabled: (.enabledPlugins[$id] // false)}' ~/.claude/settings.json 2>/dev/null || echo '{"enabled":false}')
[[ "$(jq -r '.enabled' <<<"$cfg")" != "true" ]] && exit 0
[[ -f "$HOME/.claude/jev-sift/needs-key" ]] && { echo "jev-sift · add your TypeSafe key: /plugin configure jev-sift"; exit 0; }
log="$dir/.claude/hook-logs/jev-sift.jsonl"
filtered=0; removed=0
if [[ -n "$sid" && -f "$log" ]]; then
  read -r filtered removed < <(grep -F "\"session_id\":\"$sid\"" "$log" | jq -r -s '[ (map(.dropped // 0) | add // 0), (map(.chars_removed // 0) | add // 0) ] | @tsv')
fi
tokens=$(( ${removed:-0} * 2 / 7 ))
if (( tokens >= 1000 )); then tks=$(awk -v t="$tokens" 'BEGIN{printf "%.1fk", t/1000}'); else tks="$tokens"; fi
echo "jev-sift on · ${filtered:-0} cut · ${tks} tks saved"
