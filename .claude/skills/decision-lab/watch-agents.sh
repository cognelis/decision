#!/bin/zsh
# Exit (and so notify the controller) as soon as any watched agent stops "working", any watched file
# appears, or after $1 seconds. $2: comma-separated agent names. $3: comma-separated files to wait for.
deadline=$(( $(date +%s) + ${1:-1800} ))
watch=${2:-}
files=(${(s:,:)${3:-}})
while (( $(date +%s) < deadline )); do
  for f in $files; do [[ -e "$f" ]] && { echo "$(date +%H:%M:%S) file $f"; exit 0; }; done
  if [[ -n "$watch" ]]; then
    out=$(herdr agent list 2>/dev/null | WATCH="$watch" python3 -c '
import json,os,sys
names=set(os.environ["WATCH"].split(","))
for a in json.load(sys.stdin)["result"]["agents"]:
    n=a.get("name")
    if n in names and a["agent_status"]!="working": print(n, a["agent_status"])')
    if [[ -n "$out" ]]; then echo "$(date +%H:%M:%S) $out"; exit 0; fi
  fi
  sleep 30
done
echo "$(date +%H:%M:%S) timeout"
