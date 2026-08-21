# For the agent installing this setup

You are installing DeepSeek Harness plus this repo's configuration on a macOS machine. Work in this checkout. The human gives you the vLLM endpoint; everything else is in this repo. Finish when `scripts/check.sh` exits 0 and the smoke tests in step 5 pass.

## Steps

1. **Preflight.** Confirm `node` (24+), `pnpm`, `uv`, `git`, `curl`, `python3`, Homebrew and Google Chrome exist, and that `curl <endpoint>/v1/models` lists a model. Ask the human for the endpoint and model id if `dsh-home/settings.yaml` does not already hold theirs. Done when every tool resolves on `PATH` and the endpoint answers.

2. **Adapt the config before installing.** In `dsh-home/settings.yaml` set `baseURL` and the model `id` under `llm-pi-ai.providers.spark` and `spark-vision`, and `agent-default-model`. In `plugins/dsh-plugin-vision/cordis.patch.yml` and `launchd/*.plist` replace `/Users/YOUR_USER` with the real home directory only if `install.sh` is not used (it substitutes `$HOME` itself). Done when `grep -n YOUR_SPARK_HOST dsh-home/settings.yaml` finds nothing.

3. **Install.** Run `./scripts/install.sh`. It clones `deepseek-harness` and `dsh-verifier-gate` next to this repo, builds both, writes `~/.dsh`, installs every plugin into the `headless`, `web` and `desktop` profiles (the verifier `dsh-verifier-gate` with its `ui_snapshot` tool, the vision and web-tools bundles, `dsh-preview`, the community plugins; the browser pane `dsh-plugin-browser` into `web` and `desktop` only, its host half needs the web server; the memory plugin `dsh-mnemon` into all three, with the `mnemon` CLI from Homebrew), links the verifier's skill `graph-verified-coding` into `~/.dsh/skills` (the skill is part of the plugin; without the link dsh cannot load it), creates the Python venvs (eyes, ddg, and `~/.dsh/venv` with PyMuPDF for PDF pages in the browser pane), clones tonyd2wild's vision and web tool repos for their shims, and loads the three LaunchAgents. It refuses to overwrite an existing `~/.dsh/settings.yaml`; if it does, merge by hand and rerun. Done when the script ends with "done".

4. **Check.** Run `./scripts/check.sh`. Every line must read `ok`. A `FAIL` names the broken helper; `launchctl print gui/$UID/<label>` and the log under `~/.dsh/vision/logs` or `~/.dsh/web/logs` show why. Done when the script exits 0.

5. **Smoke tests through the harness itself.** Run each and read the answer, do not infer it:
   - `bin/dsh --profile headless "Answer in one word: which model are you?"` answers with the model.
   - `bin/dsh --profile headless "Use analyze_image with backend fast on ~/.dsh/vision/test/blue.png and name the colour."` says blue (the test PNGs are created by the eyes setup; if missing, make a solid-colour PNG first).
   - `bin/dsh --profile headless "Use web_search for 'DeepSeek Harness' and return one URL."` returns a URL.
   - `bin/dsh --profile headless "Load the skill graph-verified-coding and reply only with the number of steps."` answers 7.
   - `bin/dsh --profile headless "Call ui_snapshot with url https://example.com/ and reply only with the number of shots and the browser field."` answers 4 and `chrome headless=true` (Google Chrome must be installed).
   - In an empty scratch directory: `bin/dsh --profile headless "Store in this workspace's runtime project memory via the mnemon tools: 'smoke: the test colour is teal'. Reply done."`, then in the same directory `bin/dsh --profile headless "From runtime project memory only: what is the test colour? One word."` answers teal (a `.mnemon/` directory appears there; delete the scratch directory afterwards).
   Done when all six answers are correct.

6. **Report.** List what was installed, the endpoint in use, the six smoke-test outputs verbatim, and anything you changed in `dsh-home/settings.yaml`. Done when the human can reproduce every claim from the report.

## Reference

**Profiles.** `headless` is the one-shot CLI (`bin/dsh --profile headless "task"`). `web` is `bin/dsh web`. `desktop` is DSH Desktop, installed separately from its DMG; it shares `~/.dsh`. Run `bin/dsh web` and the desktop app one at a time; a starting web host takes over the other one's in-flight sessions.

**Where things live.** Provider routes and plugin settings: `~/.dsh/settings.yaml` (hot-reloaded). Profile bundles: `~/.dsh/profiles/<p>/package.json`. Skills: `~/.dsh/skills` and `~/.agents/skills`. Helpers: LaunchAgents `com.devrico003.dsh-eyes` (:8081), `com.devrico003.dsh-vision-proxy` (:8900), `com.devrico003.dsh-ddg-shim` (:8899). Logs: `~/.dsh/vision/logs`, `~/.dsh/web/logs`, and for the desktop app `~/Library/Application Support/DSH Desktop/logs`.

**Known hazards.** Project memory is `<workspace>/.mnemon` (workspace scope); it is plain files and SQLite, so it must be in `.gitignore` and must never hold keys or tokens. The browser pane's Chrome (`~/.dsh/browser-profile`) keeps logins and the agent drives it; `dsh-home/AGENTS.md` tells the agent to ask before spending, sending, submitting or deleting, which is guidance, not enforcement. `web_fetch` has no SSRF protection; it is on in the `standard-web` preset and the headless host row. The verifier thinks at effort high and is never cut short: a gate at the end of every turn is three streamed calls and takes two to fifteen minutes on a long turn; the node gates the agent calls itself (`verifier_assess`) run at `low` with two repeats, one to two minutes; a checkpoint every forty steps adds one short call at `low`. `verifier: gate: enabled: false` and `verifier: checkpoint: enabled: false` in `settings.yaml` switch them off; `verifier: backend: reasoningEffort: low` or `none` makes them fast. Subagent reports are delivered at the parent's next step only because `tool-subagent-report: reportDelivery: quiet` is set; without it Desktop 2.0.1 (rc.7) holds them until the parent's turn ends. The plugins in `~/.dsh/profiles/*` are `link:` installs of the sibling checkouts; editing those checkouts changes the running harness after a host restart.

**Updating.** `git pull` in `../dsh-verifier-gate` and `../deepseek-harness` (then `pnpm run build` in each), `git pull` in this repo, rerun `./scripts/install.sh`. The two tonyd2wild shim repos are cloned at their current `main`; `git pull` them too, then `launchctl kickstart -k gui/$UID/<label>` to restart the helper.
