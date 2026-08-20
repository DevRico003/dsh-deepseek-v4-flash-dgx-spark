# vLLM wire-format notes for DeepSeek-V4-Flash-0731

Measured on 2026-08-20 against the MiaAI-Lab recipe (Anemll `dspark-vllm-gx10:0.1.1`, vLLM 0.25.2.dev0, TP=2, 1M context). Every line below is a curl result, not a guess.

## Reasoning

- The model thinks by default (`DEFAULT_THINKING=max` on the server).
- Non-streaming responses carry the thinking in `message.reasoning`. Streaming deltas carry `delta.reasoning`. The DeepSeek API name `reasoning_content` never appears. This is why the route uses `dsh-llm-pi-ai` (reads `reasoning_content`, `reasoning` and `reasoning_text`) instead of `dsh-llm-deepseek` (reads only `reasoning_content`).
- `reasoning_effort` is accepted with the values `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `none` switches thinking off (2 completion tokens for "Sag nur: ok"). `off` returns HTTP 400 with the list of accepted values. `minimal` still thinks.
- `thinking: {type: "disabled"}` (DeepSeek API style) is accepted and ignored; the model keeps thinking.
- `chat_template_kwargs: {thinking: false}` also switches thinking off; the route does not need it because `reasoning_effort: none` does the same job and pi-ai sends that with `thinkingFormat: openai`.

The route therefore declares `reasoningEfforts: {off: none, low: low, high: high, max: max}` and `supportsReasoningEffort: true`.

## Request shape

- `developer` role is accepted. The route still sends `system` (`supportsDeveloperRole: false`) because the DeepSeek chat template was written for it.
- `max_completion_tokens` is accepted; the route sends `max_tokens` (`maxTokensField: max_tokens`). `max_tokens` counts thinking plus answer, so small caps end with `content: null`. The route sets 65536.
- Tool calls work (`finish_reason: tool_calls`, standard `tool_calls` array).
- `stream_options: {include_usage: true}` works; usage arrives on the last chunk.
- `logprobs: true, top_logprobs: 20` works in both modes. The verifier depends on it.

## Timing

- Time to first token for a 131k-token prompt is 77 to 87 seconds. `streamIdleTimeoutMs` on the route is 600000.
- Single stream decode is 77 to 87 tokens per second. Six concurrent streams give 161 to 190 tokens per second in aggregate, about 45 per stream. Two to three parallel subagents are the sweet spot; more than that only slows each stream.
- The first requests after a server start are slower (JIT); let it warm up before measuring.

## Settings that express all of this

See `dsh-home/settings.yaml`, provider `spark`. The `spark-vision` route is the same thing behind the local vision proxy (`http://127.0.0.1:8900/v1`) with `input: [text, image]`, which is true of the proxy, not of the model.
