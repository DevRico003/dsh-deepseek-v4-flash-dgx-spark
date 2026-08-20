#!/usr/bin/env bash
# Install this setup on a Mac. Idempotent where it can be; loud where it cannot.
#
#   ./scripts/install.sh            full install
#   ./scripts/install.sh --no-launchd   skip the LaunchAgents (eyes, proxy, ddg shim)
#
# Layout after install (next to this repo):
#   ../deepseek-harness   harness source checkout (master), built
#   ../dsh-verifier       the verifier plugin
#   ~/.dsh                settings, profiles, skills, AGENTS.md
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PARENT="$(dirname "$HERE")"
HARNESS="$PARENT/deepseek-harness"
VERIFIER="$PARENT/dsh-verifier"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DSH="$HERE/bin/dsh"
WITH_LAUNCHD=1
[ "${1:-}" = "--no-launchd" ] && WITH_LAUNCHD=0

step() { printf '\n==> %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
need node; need pnpm; need git; need uv; need curl; need python3

step "1/8 harness source checkout"
if [ ! -d "$HARNESS/.git" ]; then
  git clone --branch master https://github.com/deepseek-ai/deepseek-harness "$HARNESS"
fi
( cd "$HARNESS" && pnpm install --frozen-lockfile && pnpm run build )

step "2/8 verifier plugin"
if [ ! -d "$VERIFIER/.git" ]; then
  git clone https://github.com/DevRico003/dsh-verifier "$VERIFIER"
fi
( cd "$VERIFIER" && pnpm install && pnpm run build )

step "3/8 ~/.dsh settings, patches, AGENTS.md, preset"
mkdir -p "$DSH_HOME/profiles" "$DSH_HOME/skills" "$DSH_HOME/.agent-presets" "$DSH_HOME/vision/logs" "$DSH_HOME/web/logs" "$DSH_HOME/browser/shots"
if [ -e "$DSH_HOME/settings.yaml" ]; then
  echo "    $DSH_HOME/settings.yaml exists; not overwriting. Merge dsh-home/settings.yaml by hand."
else
  sed "s|/Users/YOUR_USER|$HOME|g" "$HERE/dsh-home/settings.yaml" > "$DSH_HOME/settings.yaml"
  echo "    wrote $DSH_HOME/settings.yaml; replace YOUR_SPARK_HOST with your vLLM host"
fi
[ -e "$DSH_HOME/.credentials.yaml" ] || ( umask 077; cp "$HERE/dsh-home/.credentials.yaml.example" "$DSH_HOME/.credentials.yaml" )
sed "s|/Users/YOUR_USER|$HOME|g" "$HERE/dsh-home/cordis.patch.yml" > "$DSH_HOME/cordis.patch.yml"
cp "$HERE/dsh-home/AGENTS.md" "$DSH_HOME/AGENTS.md"
rm -rf "$DSH_HOME/.agent-presets/standard-web"
cp -R "$HERE/dsh-home/.agent-presets/standard-web" "$DSH_HOME/.agent-presets/standard-web"
chmod 700 "$DSH_HOME/.agent-presets" "$DSH_HOME/.agent-presets/standard-web"; chmod 600 "$DSH_HOME/.agent-presets/standard-web"/*
for p in headless web desktop; do
  mkdir -p "$DSH_HOME/profiles/$p"
  cp "$HERE/dsh-home/profiles/$p/cordis.patch.yml" "$DSH_HOME/profiles/$p/cordis.patch.yml"
done

step "4/8 plugins into the profiles"
( cd "$HERE/plugins/dsh-plugin-vision" && pnpm install )
for p in headless web desktop; do
  "$DSH" plugin --profile "$p" add "$VERIFIER"
  "$DSH" plugin --profile "$p" add "$HERE/plugins/dsh-plugin-vision"
  "$DSH" plugin --profile "$p" add "$HERE/plugins/dsh-plugin-web-tools"
  "$DSH" plugin --profile "$p" add @deepseek-ai/dsh-web-fetch-http@0.1.0-rc.8
  "$DSH" plugin --profile "$p" add dsh-preview
done
for p in web desktop; do
  "$DSH" plugin --profile "$p" add dsh-context dsh-client-auto-continue dshmarket dsh-find-plugin @nanmicoder/dsh-agent-teams
done

step "5/8 skills"
ln -sfn "$VERIFIER/skills/graph-verified-coding" "$DSH_HOME/skills/graph-verified-coding"

step "6/8 local helpers: eyes (mlx-vlm), ddg shim, vision proxy source"
uv venv "$HOME/.venvs/eyes" --python 3.12 >/dev/null 2>&1 || true
uv pip install --python "$HOME/.venvs/eyes/bin/python" -U mlx-vlm jinja2
uv venv "$HOME/.venvs/ddg" --python 3.12 >/dev/null 2>&1 || true
uv pip install --python "$HOME/.venvs/ddg/bin/python" ddgs
mkdir -p "$DSH_HOME/vision/test"
python3 - "$DSH_HOME/vision/test" <<'EOF'
import zlib, struct, sys, os
def png(path, rgb, w=96, h=64):
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
d = sys.argv[1]
for name, rgb in (('green', (0, 200, 0)), ('blue', (0, 0, 220)), ('red', (220, 0, 0))):
    p = os.path.join(d, name + '.png')
    if not os.path.exists(p): png(p, rgb)
print('    solid-colour test PNGs in', d)
EOF
[ -d "$PARENT/DeepSeek-Harness-Vision-Tools" ] || git clone https://github.com/tonyd2wild/DeepSeek-Harness-Vision-Tools "$PARENT/DeepSeek-Harness-Vision-Tools"
[ -d "$PARENT/DeepSeek-Harness-Web-Tools" ] || git clone https://github.com/tonyd2wild/DeepSeek-Harness-Web-Tools "$PARENT/DeepSeek-Harness-Web-Tools"

if [ "$WITH_LAUNCHD" = 1 ]; then
  step "7/8 LaunchAgents"
  for f in "$HERE"/launchd/com.devrico003.dsh-*.plist; do
    label="$(basename "$f" .plist)"
    target="$HOME/Library/LaunchAgents/$label.plist"
    sed "s|/Users/YOUR_USER|$HOME|g" "$f" > "$target"
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$target" && echo "    loaded $label"
  done
else
  step "7/8 LaunchAgents skipped"
fi

step "8/8 done"
echo "    Edit $DSH_HOME/settings.yaml (baseURL, model) if your endpoint differs, then: ./scripts/check.sh"
