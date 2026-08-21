#!/usr/bin/env bash
# Health check for the whole setup. Exit 0 when every check passes.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# Endpoint: $SPARK_BASE_URL, else the `spark` route in ~/.dsh/settings.yaml without its /v1.
SPARK="${SPARK_BASE_URL:-$(python3 -c 'import yaml,os; d=yaml.safe_load(open(os.path.expanduser("~/.dsh/settings.yaml"))); print(d["llm-pi-ai"]["providers"]["spark"]["baseURL"].rstrip("/").removesuffix("/v1"))' 2>/dev/null || echo http://YOUR_SPARK_HOST:8000)}"
fail=0
ok()  { printf '  ok   %s\n' "$*"; }
bad() { printf '  FAIL %s\n' "$*"; fail=1; }

echo "Spark vLLM ($SPARK)"
if m=$(curl -s -m 8 "$SPARK/v1/models" | python3 -c 'import sys,json; print(",".join(x["id"] for x in json.load(sys.stdin)["data"]))' 2>/dev/null); then ok "models: $m"; else bad "no answer from $SPARK/v1/models"; fi
r=$(curl -s -m 8 "$SPARK/metrics" | grep -E '^vllm:num_requests_running\{' | awk '{print $2}'); [ -n "$r" ] && ok "requests running: $r"

echo "Local helpers"
curl -s -m 5 http://127.0.0.1:8081/v1/models >/dev/null 2>&1 && ok "eyes (mlx-vlm) on :8081" || bad "eyes not answering on :8081 (launchctl print gui/\$UID/com.devrico003.dsh-eyes)"
h=$(curl -s -m 30 http://127.0.0.1:8900/health 2>/dev/null); echo "$h" | grep -q '"ready": true' && ok "vision proxy ready on :8900" || bad "vision proxy not ready on :8900"
curl -s -m 5 http://127.0.0.1:8899/health 2>/dev/null | grep -q duckduckgo && ok "ddg shim on :8899" || bad "ddg shim not answering on :8899"

echo "Browser"
[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] && ok "Google Chrome (ui_snapshot, browser pane)" || bad "Google Chrome not installed"
"$HOME/.dsh/venv/bin/python" -c 'import pymupdf' >/dev/null 2>&1 && ok "PyMuPDF in ~/.dsh/venv (PDF pages in the browser pane)" || bad "PyMuPDF missing: uv venv ~/.dsh/venv && uv pip install --python ~/.dsh/venv/bin/python pymupdf"

echo "dsh home"
for f in "$HOME/.dsh/settings.yaml" "$HOME/.dsh/cordis.patch.yml" "$HOME/.dsh/AGENTS.md" "$HOME/.dsh/.agent-presets/standard-web/agent.cordis.yml" "$HOME/.dsh/skills/graph-verified-coding/SKILL.md"; do
  [ -e "$f" ] && ok "$f" || bad "missing $f"
done
python3 - <<'EOF' || fail=1
import yaml,os
d=yaml.safe_load(open(os.path.expanduser('~/.dsh/settings.yaml')))
p=d.get('llm-pi-ai',{}).get('providers',{})
print('  ok   providers:', ', '.join(p) if p else 'NONE')
print('  ok   default model:', d.get('agent-default-model'))
EOF

echo "Profiles"
for p in headless web desktop; do
  b=$(python3 -c "import json,sys; print(' '.join(json.load(open(sys.argv[1]))['dsh']['profile']['bundles']))" "$HOME/.dsh/profiles/$p/package.json" 2>/dev/null) && ok "$p: $b" || bad "profile $p missing"
done

echo "Harness"
if "$HERE/bin/dsh" --profile headless --dump-config >/dev/null 2>&1; then ok "headless profile composes"; else bad "headless profile does not compose (bin/dsh --profile headless --dump-config)"; fi

exit $fail
