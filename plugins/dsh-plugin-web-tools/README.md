# dsh-plugin-web-tools

Keyless `web_search` and `web_fetch` for DeepSeek Harness, packaged as one bundle.

- `web_search` goes to a local DuckDuckGo shim (`DeepSeek-Harness-Web-Tools/shim/server.py`, run by the LaunchAgent `com.devrico003.dsh-ddg-shim` on `127.0.0.1:8899`). The provider in `index.js` registers as `ddg-shim` on `ctx.web`.
- `web_fetch` is the official `@deepseek-ai/dsh-web-fetch-http`, which this bundle's patch mounts as `fetchProvider: http`.

Both the shim and the provider are adapted from [tonyd2wild/DeepSeek-Harness-Web-Tools](https://github.com/tonyd2wild/DeepSeek-Harness-Web-Tools) (MIT). The difference here is packaging: a `dsh.bundle` manifest, so one `dsh plugin add` wires the rows into every profile instead of hand-editing each profile patch.

## Install

Per profile, two adds (the fetch provider is a plain dependency the patch references by name):

```sh
dsh plugin --profile <p> add @deepseek-ai/dsh-web-fetch-http@0.1.0-rc.8
dsh plugin --profile <p> add /path/to/plugins/dsh-plugin-web-tools
```

`web_fetch` also needs `fetch: true` on the tool row the agent sees. Headless reads the host-plane row this patch sets. Web and desktop disable that row and use an agent preset instead, so they need the `standard-web` preset (a copy of the shipped `standard` preset with `fetch: true`) selected as default in `settings.yaml`:

```yaml
agent-presets:
  default: standard-web
```

## Security

`dsh-web-fetch-http` has no SSRF protection. The model chooses the URL, so an agent with fetch on can reach localhost, your LAN and any VPN host. DeepSeek ships it disabled for that reason. Turn it off again by setting `fetch: false` in the preset and in this bundle's `cordis.patch.yml` if you run unattended agents on an untrusted task.

MIT.
