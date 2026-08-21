# Credits

This setup stands on other people's work. Where I copied or adapted code, the file says so and keeps the original licence.

| Project | Author | Licence | What I use |
| --- | --- | --- | --- |
| [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | DeepSeek AI | MIT | the harness itself (`dsh`), its plugin system, `dsh-web-fetch-http`, the `standard` agent preset that `standard-web` copies |
| [DeepSeek-v4-Flash-DSpark-2x-DGX-Spark](https://github.com/MiaAI-Lab/DeepSeek-v4-Flash-DSpark-2x-DGX-Spark) | MiaAI-Lab | see repo | the server recipe the Sparks run (vLLM TP=2, 1M context, start/stop/status scripts, bench); this repo only talks to its endpoint |
| `ghcr.io/anemll/dspark-vllm-gx10` | Anemll | see image | the vLLM build for GB10 that the MiaAI recipe runs |
| [DeepSeek-v4-Flash-0731-Vision-DSpark-1M-NVFP4-KV-2x-DGX-Spark](https://github.com/tonyd2wild/DeepSeek-v4-Flash-0731-Vision-DSpark-1M-NVFP4-KV-2x-DGX-Spark) and [deepseek-v4-flash-dgx-spark](https://github.com/tonyd2wild/deepseek-v4-flash-dgx-spark) | tonyd2wild | see repos | the earlier two-Spark recipes and the co-located vision idea that shaped this setup |
| [DeepSeek-Harness-Vision-Tools](https://github.com/tonyd2wild/DeepSeek-Harness-Vision-Tools) | tonyd2wild | MIT | the two-door vision concept, `shim/vision_shim.py` (run unchanged by the proxy LaunchAgent), and `plugin/vision/index.js`, which `plugins/dsh-plugin-vision/index.js` adapts to the current tool DSL and the harness fs service |
| [DeepSeek-Harness-Web-Tools](https://github.com/tonyd2wild/DeepSeek-Harness-Web-Tools) | tonyd2wild | MIT | `shim/server.py` (DuckDuckGo shim, run unchanged by the ddg LaunchAgent) and `plugin/index.js`, which `plugins/dsh-plugin-web-tools/index.js` adapts into a bundle |
| [DeepSeek-Harness-Browser](https://github.com/tonyd2wild/DeepSeek-Harness-Browser) | tonyd2wild | MIT | the browser pane, its CDP driver, file, markdown and PDF rendering and the `open_preview` / `read_preview` / `close_preview` tools; `plugins/dsh-plugin-browser/` is that code with a bundle manifest, `link:` dependencies on the harness checkout and a headless Chrome launch |
| [llm-as-a-verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier), [llm-as-a-verifier.com](https://llm-as-a-verifier.com/) | Kwok et al. (arXiv 2607.05391) | MIT | the scoring method and prompts ported in [dsh-verifier-gate](https://github.com/DevRico003/dsh-verifier-gate) |
| [deepseek-harness-desktop](https://github.com/anywhere-labs/deepseek-harness-desktop) | anywhere-labs | MIT | DSH Desktop, the macOS app that shares `~/.dsh` |
| [dsh-preview](https://github.com/Viger1/dsh-preview) | Viger1 | MIT | `frontend-verify` skill and `browser_*` tools |
| [playwright-mcp](https://github.com/microsoft/playwright-mcp) | Microsoft | Apache-2.0 | `@playwright/mcp`, mounted through the built-in MCP client |
| [mlx-vlm](https://github.com/Blaizzy/mlx-vlm) | Prince Canuma and contributors | MIT | the local vision server |
| Qwen3.5-0.8B, Qwen3-VL-4B-Instruct (mlx-community conversions) | Alibaba Qwen team | Apache-2.0 | the two local vision models |
| [ddgs](https://github.com/deedy5/ddgs) | deedy5 | MIT | DuckDuckGo client inside the search shim |
| [dsh-context](https://github.com/bowenliang123/dsh-context) | bowenliang123 | Apache-2.0 | context dashboard plugin |
| [dsh-auto-continue](https://github.com/HsiangNianian/dsh-auto-continue) | HsiangNianian | MIT | auto-resume plugin |
| [dsh-market](https://github.com/dsh-market/dsh-market) | dsh-market | MIT | plugin market |
| [dsh-find-plugin](https://github.com/awesome-dsh-plugin/dsh-find-plugin) | awesome-dsh-plugin | MIT | plugin search tool |
| [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) | omdsh-dev | MIT | three-tier memory plugin (runtime memory, project documents, Memory Spaces) |
| [mnemon](https://github.com/mnemon-dev/mnemon) | mnemon-dev | Apache-2.0 | the local memory CLI and SQLite store behind dsh-mnemon's native Memory Spaces |
| [dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) | NanmiCoder | MIT | agent teams over continuable subagents |

If I missed someone, open an issue and I will add the line.
