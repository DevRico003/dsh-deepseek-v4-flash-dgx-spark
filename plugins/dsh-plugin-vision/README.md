# dsh-plugin-vision

`analyze_image` tool for DeepSeek Harness, the "door 2" half of
[tonyd2wild/DeepSeek-Harness-Vision-Tools](https://github.com/tonyd2wild/DeepSeek-Harness-Vision-Tools),
adapted to the current harness tool DSL and to the local setup on this Mac:

- The brain (`deepseek-v4-flash-0731` on the DGX Sparks) stays text-only.
- The eyes are a local **mlx-vlm** server (`~/.venvs/eyes`, LaunchAgent `com.devrico003.dsh-eyes`,
  `http://127.0.0.1:8081`) that loads the model named in each request:
  - `fast` → `mlx-community/Qwen3.5-0.8B-MLX-8bit` (colours, layout, coarse content)
  - `detailed` → `mlx-community/Qwen3-VL-4B-Instruct-4bit` (small text, OCR, fine detail)
- Image bytes go only to the vision model; the brain receives text. Files are read through the
  harness `fs` service when mounted (workspace boundary + approval policy), else `node:fs`.

Door 1 (chat attachments) is the vision **proxy** from the same repo, run as LaunchAgent
`com.devrico003.dsh-vision-proxy` on `:8900` and exposed as the `spark-vision` route in
`~/.dsh/settings.yaml` (`input: [text, image]` is true of the proxy).

## Install

```sh
dsh plugin --profile <web|headless|desktop> add /Users/YOUR_USER/Coding/Projekte/ec/dsh-plugin-vision
```

Backends/timeouts live in `cordis.patch.yml` (`config.backends.<name>.{url,model,maxTokens,temperature}`,
`defaultBackend`, `timeoutMs`, `maxImageBytes`); env fallbacks `VISION_FAST_URL/_MODEL`,
`VISION_DETAILED_URL/_MODEL` apply when the config block has no backends.

## Verify

```sh
curl -s http://127.0.0.1:8081/v1/models            # eyes up
curl -s http://127.0.0.1:8900/health               # proxy: upstream_ok + vision_ok + ready
dsh --profile headless "Nutze analyze_image (backend fast) für ~/.dsh/vision/test/blue.png und nenne die Farbe."
```

Test images (solid colours a text model cannot guess) live in `~/.dsh/vision/test/`.

## Limits

- A description is lossy; use `detailed` for text-heavy screenshots.
- If the eyes server is down the tool fails naming the endpoint; the proxy degrades to
  `[Image: (image could not be analyzed: …)]` and the turn still completes.
- MIT, credits to tonyd2wild (original), Qwen, mlx-vlm.
