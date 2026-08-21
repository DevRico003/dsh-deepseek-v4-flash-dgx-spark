# DeepSeek Harness on a Mac, DeepSeek-V4-Flash-0731 on two DGX Sparks

This repo is the complete client-side setup I run: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`, web UI, headless CLI and the DSH Desktop app) on a Mac, talking to DeepSeek-V4-Flash-0731 served by vLLM on a pair of DGX Sparks. The model is text-only and lives on the Sparks. Everything that makes it usable as a coding agent lives here: provider settings that match vLLM's wire format, a verifier plugin that gates every turn, local vision, keyless web search and fetch, browser self-checks, a browser pane beside the chat, per-project memory, and the launchd units that keep the helpers alive.

Nothing here touches the Spark side. The server recipe is [MiaAI-Lab/DeepSeek-v4-Flash-DSpark-2x-DGX-Spark](https://github.com/MiaAI-Lab/DeepSeek-v4-Flash-DSpark-2x-DGX-Spark) (vLLM TP=2, 1M context, Anemll image). The Mac only needs its OpenAI-compatible endpoint.

## What is in here

| Path | Purpose |
| --- | --- |
| `dsh-home/` | My `~/.dsh`: `settings.yaml` (provider routes, default model, plugin sections), `cordis.patch.yml` (home-level patch, currently empty), `AGENTS.md` (what every session is told), profile manifests and patches, the `standard-web` agent preset |
| `plugins/dsh-plugin-vision/` | `analyze_image` tool: local vision for the text-only model (adapted from tonyd2wild) |
| `plugins/dsh-plugin-web-tools/` | keyless `web_search` (DuckDuckGo shim) plus `web_fetch` wiring (provider adapted from tonyd2wild) |
| `plugins/dsh-plugin-browser/` | browser pane in the web UI and DSH Desktop with `open_preview`, `read_preview`, `close_preview` (adapted from tonyd2wild, Chrome runs headless here) |
| `launchd/` | LaunchAgents for the three local helpers: mlx-vlm eyes server, vision proxy, DuckDuckGo shim |
| `bin/dsh` | launcher that runs the harness source checkout from any directory |
| `scripts/` | `install.sh` (profiles, plugins, skills, launchd) and `check.sh` (is everything up) |
| `docs/` | vLLM wire-format notes, credits |

The verifier plugin is its own repo: [DevRico003/dsh-verifier-gate](https://github.com/DevRico003/dsh-verifier-gate). `scripts/install.sh` clones it next to this one.

## Let an agent install it

`AGENTS.md` in this repo is written for Claude Code, Codex or dsh itself: preflight, config edits, install, check, four smoke tests through the harness, report. Clone the repo, open an agent session in it, and paste:

```
Read AGENTS.md in this repo and install the setup on this Mac. My vLLM endpoint is http://<host>:8000/v1 and the served model id is <model>. Work through the six steps, run every command yourself, and finish with the report from step 6. Stop and ask me only for things you cannot decide (missing tools, an endpoint that does not answer).
```

Claude Code and Codex pick `AGENTS.md` up on their own when they work inside the checkout; the paste is for the endpoint and the go-ahead.

## The pieces, and why they are set the way they are

**Provider route.** `settings.yaml` defines `spark` on `dsh-llm-pi-ai` with `api: openai-completions`. The native `dsh-llm-deepseek` adapter would be the obvious choice, but vLLM streams the model's thinking in a field called `reasoning`, and the native adapter only reads `reasoning_content`; pi-ai reads both. A few more switches matter and I measured each against the server: `reasoning_effort` accepts `none|low|high|max` and `none` really turns thinking off (`off` returns HTTP 400, and `thinking: {type: disabled}` is ignored), so the route maps `off` to `none`. `supportsDeveloperRole: false`, `maxTokensField: max_tokens`, `streamIdleTimeoutMs: 600000` because a 131k-token prompt takes 77 to 87 seconds to first token on this hardware. Details in `docs/vllm-wire-format.md`.

**Verifier.** `dsh-verifier-gate` scores with the same model, thinking on, logprobs on, 20-letter scale. Three places: a gate at the end of every turn (`reasoning_effort: high`, the setting the llm-as-a-verifier authors used for DeepSeek V4 Flash; findings come back when the score is under 0.6), a checkpoint every forty steps inside a long turn (the reference progress prompt at `low`; when progress falls or stalls, an assessment with findings runs while the agent waits at the next step boundary, so the findings are fresh), and a reminder after twelve file edits without a verifier call, repeated every twelve further edits. The calls stream, so a long think never trips a transport timeout; an idle timer catches a dead stream. In the first real run the gate caught the agent declaring a project done while its subagents were still running; later runs caught a test that had been weakened to pass, a lint exit code masked by a pipe, and a TypeScript error introduced in the last edit. Cost at `high` is two to fifteen minutes per gate on a long turn, depending on how many streams share the Spark pair; `verifier: backend: reasoningEffort: low` cuts that to a third with verdicts within 0.06 on an A/B here, `none` brings chat sessions to 6 to 10 seconds. The node gates the agent calls itself through `verifier_assess` run at `low` with two repeats per criterion, six calls fanned out on eight slots, one to two minutes each; in a two-hour build at `high` they had taken five to eight minutes each and a `verifier_select` 22 minutes, about a third of the session.

The verifier is the same method the llm-as-a-verifier authors benchmarked with DeepSeek V4 Flash as generator and verifier (chart from their README, Terminal-Bench 2.1, OpenRouter prices of 2026-08-17): best-of-3 lifts the model from 78.7% to 86.5%, best-of-5 to 88.0%, at about a quarter of the cost per task of GPT-5.6 Sol in Codex. On the Sparks the cost per task is electricity, which is the point of running this at home.

![Terminal-Bench 2.1: success rate against cost per task, DeepSeek V4 Flash with LLM-as-a-Verifier versus Codex and Claude Code](docs/images/terminal-bench-2.1-cost-vs-success.png)

The framework behind it, from [llm-as-a-verifier.com](https://llm-as-a-verifier.com/): probability over logits, a fine-grained score token, repetition, decomposition into criteria.

![LLM-as-a-Verifier framework: uncertainty, granularity, repetition, decomposition](docs/images/llm-as-a-verifier-framework.png)

**Vision.** The model never sees pixels. Two local Qwen models on the Mac describe images through `mlx-vlm` (`launchd/com.devrico003.dsh-eyes.plist`): `Qwen3.5-0.8B` for layout and colour, `Qwen3-VL-4B` for text and detail. Door one is the vision proxy (`launchd/com.devrico003.dsh-vision-proxy.plist`) in front of the Spark, exposed as the `spark-vision` route, which rewrites chat image attachments into text. Door two is the `analyze_image` tool for files on disk. Running the eyes on the Spark instead would need a restart with a smaller KV pool, so they stay on the Mac.

**Web.** `web_search` goes through a local DuckDuckGo shim (`launchd/com.devrico003.dsh-ddg-shim.plist`, Python, port 8899) because the shipped search provider needs a DeepSeek cloud key. `web_fetch` uses the official `@deepseek-ai/dsh-web-fetch-http`, which ships disabled because it has no SSRF protection; the `standard-web` preset turns it on for web and desktop, the host-plane row for headless. Know what that means before running unattended agents with it.

**Browser self-checks.** Two headless tools, nothing opens on screen. `ui_snapshot` (part of `dsh-verifier-gate`) renders one URL across viewports (1440x900 and 390x844 by default) in light and dark mode through Playwright and the installed Google Chrome, writes the PNGs under `~/.dsh/verifier/snapshots/`, and reports console errors, page errors and failed requests; the agent hands the PNGs to `analyze_image` for the verdict and repeats that as design rounds. `dsh-preview` (a `frontend-verify` skill plus `browser_*` tools) covers clicking, typing, DOM reads and computed styles. I tried two other stacks first and removed both: the official Playwright MCP next to dsh-preview confused the agent with two browser APIs, and DSH Computer Use (a real, visible Chrome driven through macOS accessibility) was slow at `reasoningEffort: high` and kept taking over the screen. `dsh-home/AGENTS.md` keeps the one rule that still matters for browsing other sites: ask before anything that spends money, submits, sends or deletes.

**Browser pane.** `dsh-plugin-browser` (web and desktop profiles) adds a Browser column beside the chat, from tonyd2wild's DeepSeek-Harness-Browser. Web pages open in a separate Chrome with its own profile under `~/.dsh/browser-profile`, driven over the DevTools protocol; the pane streams its frames (pushed by `Page.startScreencast`, not polled) and sends clicks and keys back, so you can log in to a site once and the session stays. Local files render in the pane: markdown as a document, HTML as the page, images, PDFs as page images through PyMuPDF (`~/.dsh/venv`), code with line numbers, and a link or a file path clicked in the chat opens there. The model gets `open_preview(url)`, `read_preview()` (text from the live DOM, paged) and `close_preview()`. One change against upstream: upstream starts a real Chrome window moved off-screen, and macOS clamps that window back onto the desktop, so the copy here starts Chrome with `--headless=new` (screencast and input work the same, nothing appears on screen); `headless: false` in `plugins/dsh-plugin-browser/cordis.patch.yml` restores the upstream behaviour. The Chrome the pane drives holds whatever you logged in to, and the agent drives it; the rule in `dsh-home/AGENTS.md` about money, messages, orders and account settings applies there as much as anywhere.

**Subagent reports.** DSH Desktop 2.0.1 bundles harness rc.7, where a child's `report` is delivered as a next-turn followup: while the parent is busy, the report waits until its turn ends, and in a long goal turn that is hours. `dsh-home/settings.yaml` sets `tool-subagent-report: reportDelivery: quiet`, which injects the report into the parent's next-step lane, so the parent reads it at its next step; the settlement notice still wakes a parent that is idle. The harness source on `master` (0.1.1) delivers reports at the next step by default.

**Memory.** `dsh-mnemon` (all three profiles) gives each project a memory that outlives the session, in three tiers: a runtime `MEMORY.md`/`USER.md` that is projected into every turn (decisions, conventions, environment facts), project documents that are searched first and read in full on demand, and Memory Spaces for cross-task facts and entities, stored by the local `mnemon` CLI in SQLite. `settings.yaml` sets `storageScope: workspace`, so the memory lives in `<workspace>/.mnemon` and moves with the project (`dsh-home/AGENTS.md` tells the agent to add it to `.gitignore`), and the background task agents that distill and route memories inherit the Spark route. The web UI and DSH Desktop get a Memory System workbench in the sidebar (status, runtime, documents, Memory Spaces, recall, remember) and a turn-memory bar under replies; headless sessions get the same injection and tools without the UI. Checked here end to end: a headless session stored an invoice-numbering decision in runtime memory, a second session answered from it, a third stored a VAT decision in a `Project Decisions` Memory Space and a fourth recalled it by name. I looked at Hindsight's `coding-agents` plugin first; it is the stronger engine (fact extraction, consolidation, knowledge pages) but it defaults to Hindsight Cloud, its local daemon needs a Rust toolchain on macOS, and every retain costs Spark time, so a local SQLite memory that the agent writes deliberately was the better fit.

**Desktop.** [DSH Desktop](https://github.com/anywhere-labs/deepseek-harness-desktop) shares `~/.dsh`, so the same settings and plugins apply. One rule: do not run `dsh web` and the desktop app at the same time. A web host scans the sessions directory on start, marks in-flight turns of other processes as interrupted, and `dsh-client-auto-continue` then resumes them. Headless sessions therefore live in `~/.dsh/sessions-headless` (`dsh-home/profiles/headless/cordis.patch.yml`).

## Install

Requirements: macOS on Apple Silicon, Node 24, pnpm, `uv`, Homebrew (for the `mnemon` cask), Google Chrome (headless screenshots and the browser pane), a reachable vLLM endpoint. Edit `dsh-home/settings.yaml` first: replace `YOUR_SPARK_HOST` with your vLLM host and check the model id. Home-directory paths are written as `/Users/YOUR_USER` and `install.sh` substitutes your `$HOME`.

```sh
git clone https://github.com/DevRico003/dsh-deepseek-v4-flash-dgx-spark
cd dsh-deepseek-v4-flash-dgx-spark
./scripts/install.sh        # clones harness + dsh-verifier-gate next to this repo, builds, writes ~/.dsh, installs plugins, loads launchd units
./scripts/check.sh          # Spark API, eyes, proxy, ddg shim, profiles
bin/dsh --profile headless "Answer in one word: which model are you?"
```

`install.sh` refuses to overwrite an existing `~/.dsh/settings.yaml`; move yours aside or merge by hand.

## Updating, and what comes from where

Nothing in this repo is a copy of the verifier: `install.sh` clones [dsh-verifier-gate](https://github.com/DevRico003/dsh-verifier-gate) next to it and links the checkout into the profiles, so a `git pull` there plus `pnpm run build` and a host restart updates the running harness. The two shims from tonyd2wild (`vision_shim.py`, DuckDuckGo `server.py`) run unchanged from their repos, which `install.sh` clones at `main`; `git pull` them and `launchctl kickstart -k gui/$UID/<label>` to restart the helper. The three plugin bundles in `plugins/` are adapted copies of tonyd2wild's plugin code; they do not track upstream, and I port changes by hand when they matter. The harness itself is a source checkout on `master`; `git pull && pnpm install && pnpm run build`.

## The graph-verified-coding skill

`dsh-verifier-gate` ships a skill, `skills/graph-verified-coding/SKILL.md`, and `install.sh` links it into `~/.dsh/skills`, so every dsh session can load it with the `skill` tool (the line in `dsh-home/AGENTS.md` tells the agent when). It is the working method that ties the verifier tools, `ui_snapshot`, the headless browser and subagents together, written as a graph rather than a straight line:

1. Contract: restate the task as acceptance criteria with an observable artifact each.
2. Cut false edges: split into nodes, run independent ones in parallel (two to four branches on this server), dependent ones in sequence; each child writes its result to `.graph/<node>.md`.
3. Work node: implement one node, keep the proving output.
4. Gate, after every node that changed more than one file, before merges and before the final answer: tests first, then `ui_snapshot` plus `analyze_image` for anything rendered, then `verifier_assess` with the node's contract and the observed evidence.
5. Join: competing candidates go through `verifier_select`.
6. Cycle with a stop: repair, re-gate, two rounds at most, then report what is open.
7. Report with evidence, including every verifier call with its score.

Every step ends on a done-condition the agent can check. In the first real run the agent followed it end to end and the gate caught the one place it tried to skip ahead. The file is English, the rules are in the file, not here, so read it in the [dsh-verifier-gate repo](https://github.com/DevRico003/dsh-verifier-gate/blob/main/skills/graph-verified-coding/SKILL.md).

## Community plugins installed into the profiles

`dsh-mnemon` (project memory, see above), `dsh-context` (context dashboard for the 1M window), `dsh-client-auto-continue` (resume after network errors; the loop guard is off and the texts are English, see `settings.yaml`), `dshmarket` (plugin market), `dsh-find-plugin`, `dsh-preview`, `@nanmicoder/dsh-agent-teams` (captain and members over the built-in continuable subagents). The profile manifests in `dsh-home/profiles/*/package.json` list them.

## Credits

Everything that is not mine is credited in `docs/CREDITS.md`, with licences. The short version: the harness is DeepSeek's, the server recipe is MiaAI-Lab's, the vision and web tool concepts and the proxy are tonyd2wild's, the verifier method is from the llm-as-a-verifier authors and the desktop app is anywhere-labs'.

## License

MIT for my parts. Adapted files keep their original MIT notices.
