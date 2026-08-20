# DeepSeek Harness on a Mac, DeepSeek-V4-Flash-0731 on two DGX Sparks

This repo is the complete client-side setup I run: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`, web UI, headless CLI and the DSH Desktop app) on a Mac, talking to DeepSeek-V4-Flash-0731 served by vLLM on a pair of DGX Sparks. The model is text-only and lives on the Sparks. Everything that makes it usable as a coding agent lives here: provider settings that match vLLM's wire format, a verifier plugin that gates every turn, local vision, keyless web search and fetch, browser self-checks, and the launchd units that keep the helpers alive.

Nothing here touches the Spark side. The server recipe is [MiaAI-Lab/DeepSeek-v4-Flash-DSpark-2x-DGX-Spark](https://github.com/MiaAI-Lab/DeepSeek-v4-Flash-DSpark-2x-DGX-Spark) (vLLM TP=2, 1M context, Anemll image). The Mac only needs its OpenAI-compatible endpoint.

## What is in here

| Path | Purpose |
| --- | --- |
| `dsh-home/` | My `~/.dsh`: `settings.yaml` (provider routes, default model, plugin sections), `cordis.patch.yml` (home-level patch, Playwright MCP), `AGENTS.md` (what every session is told), profile manifests and patches, the `standard-web` agent preset |
| `plugins/dsh-plugin-vision/` | `analyze_image` tool: local vision for the text-only model (adapted from tonyd2wild) |
| `plugins/dsh-plugin-web-tools/` | keyless `web_search` (DuckDuckGo shim) plus `web_fetch` wiring (provider adapted from tonyd2wild) |
| `launchd/` | LaunchAgents for the three local helpers: mlx-vlm eyes server, vision proxy, DuckDuckGo shim |
| `bin/dsh` | launcher that runs the harness source checkout from any directory |
| `scripts/` | `install.sh` (profiles, plugins, skills, launchd) and `check.sh` (is everything up) |
| `docs/` | vLLM wire-format notes, credits |

The verifier plugin is its own repo: [DevRico003/dsh-verifier](https://github.com/DevRico003/dsh-verifier). `scripts/install.sh` clones it next to this one.

## Let an agent install it

`AGENTS.md` in this repo is written for Claude Code, Codex or dsh itself: preflight, config edits, install, check, four smoke tests through the harness, report. Clone the repo, open an agent session in it, and paste:

```
Read AGENTS.md in this repo and install the setup on this Mac. My vLLM endpoint is http://<host>:8000/v1 and the served model id is <model>. Work through the six steps, run every command yourself, and finish with the report from step 6. Stop and ask me only for things you cannot decide (missing tools, an endpoint that does not answer).
```

Claude Code and Codex pick `AGENTS.md` up on their own when they work inside the checkout; the paste is for the endpoint and the go-ahead.

## The pieces, and why they are set the way they are

**Provider route.** `settings.yaml` defines `spark` on `dsh-llm-pi-ai` with `api: openai-completions`. The native `dsh-llm-deepseek` adapter would be the obvious choice, but vLLM streams the model's thinking in a field called `reasoning`, and the native adapter only reads `reasoning_content`; pi-ai reads both. A few more switches matter and I measured each against the server: `reasoning_effort` accepts `none|low|high|max` and `none` really turns thinking off (`off` returns HTTP 400, and `thinking: {type: disabled}` is ignored), so the route maps `off` to `none`. `supportsDeveloperRole: false`, `maxTokensField: max_tokens`, `streamIdleTimeoutMs: 600000` because a 131k-token prompt takes 77 to 87 seconds to first token on this hardware. Details in `docs/vllm-wire-format.md`.

**Verifier.** `dsh-verifier` runs at the end of every turn. It scores the turn with the same model (no thinking, logprobs on) on a 20-letter scale and sends the findings back when the score is under 0.6. In the first real run it caught the agent declaring a project done while its subagents were still running. Cost is three short calls per turn, 6 to 10 seconds.

The verifier is the same method the llm-as-a-verifier authors benchmarked with DeepSeek V4 Flash as generator and verifier (chart from their README, Terminal-Bench 2.1, OpenRouter prices of 2026-08-17): best-of-3 lifts the model from 78.7% to 86.5%, best-of-5 to 88.0%, at about a quarter of the cost per task of GPT-5.6 Sol in Codex. On the Sparks the cost per task is electricity, which is the point of running this at home.

![Terminal-Bench 2.1: success rate against cost per task, DeepSeek V4 Flash with LLM-as-a-Verifier versus Codex and Claude Code](docs/images/terminal-bench-2.1-cost-vs-success.png)

The framework behind it, from [llm-as-a-verifier.com](https://llm-as-a-verifier.com/): probability over logits, a fine-grained score token, repetition, decomposition into criteria.

![LLM-as-a-Verifier framework: uncertainty, granularity, repetition, decomposition](docs/images/llm-as-a-verifier-framework.png)

**Vision.** The model never sees pixels. Two local Qwen models on the Mac describe images through `mlx-vlm` (`launchd/com.devrico003.dsh-eyes.plist`): `Qwen3.5-0.8B` for layout and colour, `Qwen3-VL-4B` for text and detail. Door one is the vision proxy (`launchd/com.devrico003.dsh-vision-proxy.plist`) in front of the Spark, exposed as the `spark-vision` route, which rewrites chat image attachments into text. Door two is the `analyze_image` tool for files on disk. Running the eyes on the Spark instead would need a restart with a smaller KV pool, so they stay on the Mac.

**Web.** `web_search` goes through a local DuckDuckGo shim (`launchd/com.devrico003.dsh-ddg-shim.plist`, Python, port 8899) because the shipped search provider needs a DeepSeek cloud key. `web_fetch` uses the official `@deepseek-ai/dsh-web-fetch-http`, which ships disabled because it has no SSRF protection; the `standard-web` preset turns it on for web and desktop, the host-plane row for headless. Know what that means before running unattended agents with it.

**Browser self-checks.** `dsh-preview` (a `frontend-verify` skill plus `browser_*` tools over local Chrome) and the official Playwright MCP through the built-in MCP client (`dsh-home/cordis.patch.yml`). The agent opens what it built, reads console and computed styles, screenshots it, and hands the screenshot to `analyze_image`.

**Desktop.** [DSH Desktop](https://github.com/anywhere-labs/deepseek-harness-desktop) shares `~/.dsh`, so the same settings and plugins apply. One rule: do not run `dsh web` and the desktop app at the same time. A web host scans the sessions directory on start, marks in-flight turns of other processes as interrupted, and `dsh-client-auto-continue` then resumes them. Headless sessions therefore live in `~/.dsh/sessions-headless` (`dsh-home/profiles/headless/cordis.patch.yml`).

## Install

Requirements: macOS on Apple Silicon, Node 24, pnpm, `uv`, Google Chrome, a reachable vLLM endpoint. Edit `dsh-home/settings.yaml` first: replace `YOUR_SPARK_HOST` with your vLLM host and check the model id. Home-directory paths are written as `/Users/YOUR_USER` and `install.sh` substitutes your `$HOME`.

```sh
git clone https://github.com/DevRico003/dsh-deepseek-v4-flash-dgx-spark
cd dsh-deepseek-v4-flash-dgx-spark
./scripts/install.sh        # clones harness + dsh-verifier next to this repo, builds, writes ~/.dsh, installs plugins, loads launchd units
./scripts/check.sh          # Spark API, eyes, proxy, ddg shim, profiles
bin/dsh --profile headless "Answer in one word: which model are you?"
```

`install.sh` refuses to overwrite an existing `~/.dsh/settings.yaml`; move yours aside or merge by hand.

## Updating, and what comes from where

Nothing in this repo is a copy of the verifier: `install.sh` clones [dsh-verifier](https://github.com/DevRico003/dsh-verifier) next to it and links the checkout into the profiles, so a `git pull` there plus `pnpm run build` and a host restart updates the running harness. The two shims from tonyd2wild (`vision_shim.py`, DuckDuckGo `server.py`) run unchanged from their repos, which `install.sh` clones at `main`; `git pull` them and `launchctl kickstart -k gui/$UID/<label>` to restart the helper. The two plugin bundles in `plugins/` are adapted copies of tonyd2wild's plugin code; they do not track upstream, and I port changes by hand when they matter. The harness itself is a source checkout on `master`; `git pull && pnpm install && pnpm run build`.

## The graph-verified-coding skill

`dsh-verifier` ships a skill, `skills/graph-verified-coding/SKILL.md`, and `install.sh` links it into `~/.dsh/skills`, so every dsh session can load it with the `skill` tool (the line in `dsh-home/AGENTS.md` tells the agent when). It is the working method that ties the verifier, the browser loop, subagents and the `workflow` tool together, written as a graph rather than a straight line:

1. Contract: restate the task as acceptance criteria with an observable artifact each.
2. Cut false edges: split into nodes, run independent ones in parallel (two to four branches on this server), dependent ones in sequence.
3. Work node: implement one node, keep the proving output.
4. Gate: tests first, then the `frontend-verify` browser loop plus `analyze_image` for anything rendered, then `verifier_assess` when evidence is ambiguous.
5. Join: competing candidates go through `verifier_select`.
6. Cycle with a stop: repair, re-gate, two rounds at most, then report what is open.
7. Report with evidence.

Every step ends on a done-condition the agent can check. In the first real run the agent followed it end to end and the gate caught the one place it tried to skip ahead. The file is English, the rules are in the file, not here, so read it in the [dsh-verifier repo](https://github.com/DevRico003/dsh-verifier/blob/main/skills/graph-verified-coding/SKILL.md).

## Community plugins installed into the profiles

`dsh-context` (context dashboard for the 1M window), `dsh-client-auto-continue` (resume after network errors; the loop guard is off and the texts are English, see `settings.yaml`), `dshmarket` (plugin market), `dsh-find-plugin`, `dsh-preview`, `@nanmicoder/dsh-agent-teams` (captain and members over the built-in continuable subagents). The profile manifests in `dsh-home/profiles/*/package.json` list them.

## Credits

Everything that is not mine is credited in `docs/CREDITS.md`, with licences. The short version: the harness is DeepSeek's, the server recipe is MiaAI-Lab's, the vision and web tool concepts and the proxy are tonyd2wild's, the verifier method is from the llm-as-a-verifier authors and the desktop app is anywhere-labs'.

## License

MIT for my parts. Adapted files keep their original MIT notices.
