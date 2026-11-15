# Fanout implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `fanout`, one CLI that dispatches a chunk of bulk work to the right worker model from any agent harness, falls back automatically on quota and credit walls, records every job in an append-only ledger, tells the user about every fallback and every paid job, and keeps itself up to date without user tuning.

**Architecture:** A Bun and TypeScript CLI with zero runtime dependencies, living in the `fanout/` module of the `agent-ops` repo and installed as a built single-file copy. An append-only, schema-versioned JSONL ledger, a small `learned/` state folder and a layered catalog (private over repo default over auto) drive a ranking step; one small adapter per worker CLI builds the command, classifies the outcome and reads usage. DuckDB is used only by `report` and by the one-off transcript mining; the hot path (`run`, `pick`, `status`, `wait`) reads the last 30 days of JSONL in TypeScript. A systemd user timer and a lazy trigger run `upkeep`, which never spends paid credit.

**Tech Stack:** Bun 1.4 (`bun test`, `bun build`, `Bun.YAML`, plain `O_APPEND` writes), TypeScript, DuckDB CLI 2.0, systemd user units, bash for the shims, the installer and the hook wrappers.

**Spec:** [docs/superpowers/specs/2026-11-15-fanout-ledger-design.md](/docs/superpowers/specs/2026-11-15-fanout-ledger-design.md). Read all of it. Its last section, "Review revisions (Fable consultant, 2026-11-15)", overrides any earlier section it contradicts. Where the spec still says `~/CS/fanout-ledger` or `~/.local/share/fanout`, this plan's paths win (the repo is `agent-ops`).

This is the second edition of the plan. It implements every item of "Review revisions", adds the transcript seed task, and makes every test state its input and its expected stdout, exit code or ledger line.

Contents:

1.  [Open questions](#open-questions)
1.  [Calls this plan makes](#calls-this-plan-makes)
1.  [Global constraints](#global-constraints)
1.  [Review focus](#review-focus)
1.  [File structure](#file-structure)
1.  [Shared contracts](#shared-contracts)
1.  [Phase 1: core](#phase-1-core)
    1.  [Task 1: Module scaffold and test sandbox](#task-1-module-scaffold-and-test-sandbox)
    1.  [Task 2: Public repo hygiene](#task-2-public-repo-hygiene)
    1.  [Task 3: Catalog layers and the pick skeleton](#task-3-catalog-layers-and-the-pick-skeleton)
    1.  [Task 4: Data class](#task-4-data-class)
    1.  [Task 5: Estimate, price-aware ranking and the PAID line](#task-5-estimate-price-aware-ranking-and-the-paid-line)
    1.  [Task 6: Ledger writer and the first run](#task-6-ledger-writer-and-the-first-run)
    1.  [Task 7: Process runner, chain lease, environment allowlist and depth guard](#task-7-process-runner-chain-lease-environment-allowlist-and-depth-guard)
    1.  [Task 8: Detach and wait](#task-8-detach-and-wait)
    1.  [Task 9: Workspaces per attempt](#task-9-workspaces-per-attempt)
    1.  [Task 10: Outcome classification and reset parsing](#task-10-outcome-classification-and-reset-parsing)
    1.  [Task 11: Fallback chain](#task-11-fallback-chain)
    1.  [Task 12: Cooldowns](#task-12-cooldowns)
    1.  [Task 13: Half-open trial and waiting](#task-13-half-open-trial-and-waiting)
    1.  [Task 14: Retry, timeout and worker-error rules](#task-14-retry-timeout-and-worker-error-rules)
    1.  [Task 15: job_error and no_effect](#task-15-job_error-and-no_effect)
    1.  [Task 16: Starting model, pinning, expected model and private refusal](#task-16-starting-model-pinning-expected-model-and-private-refusal)
    1.  [Task 17: Escalation and climb lists](#task-17-escalation-and-climb-lists)
    1.  [Task 18: Effort, no-paid, dry-run and passthrough flags](#task-18-effort-no-paid-dry-run-and-passthrough-flags)
    1.  [Task 19: Cost lines](#task-19-cost-lines)
    1.  [Task 20: Fail open and scrubbing](#task-20-fail-open-and-scrubbing)
    1.  [Task 21: Status](#task-21-status)
    1.  [Task 22: Ack, verdict and the cost history](#task-22-ack-verdict-and-the-cost-history)
    1.  [Task 23: The reaper](#task-23-the-reaper)
    1.  [Task 24: Desktop notification](#task-24-desktop-notification)
    1.  [Task 25: Stop and SessionStart hooks](#task-25-stop-and-sessionstart-hooks)
    1.  [Task 26: Seed patterns and fixtures from transcripts](#task-26-seed-patterns-and-fixtures-from-transcripts)
    1.  [Task 27: Codex adapter](#task-27-codex-adapter)
    1.  [Task 28: Agy adapter](#task-28-agy-adapter)
    1.  [Task 29: Claude CLI base and Meta adapter](#task-29-claude-cli-base-and-meta-adapter)
1.  [Phase 2: upkeep](#phase-2-upkeep)
    1.  [Task 30: Upkeep skeleton and lazy trigger](#task-30-upkeep-skeleton-and-lazy-trigger)
    1.  [Task 31: Doctor](#task-31-doctor)
    1.  [Task 32: Discovery, auto-tiering and learned state](#task-32-discovery-auto-tiering-and-learned-state)
    1.  [Task 33: Smoke tests and promotion on first use](#task-33-smoke-tests-and-promotion-on-first-use)
    1.  [Task 34: Pattern learning](#task-34-pattern-learning)
    1.  [Task 35: Housekeeping](#task-35-housekeeping)
1.  [Phase 3: benchmarks, adapters, report](#phase-3-benchmarks-adapters-report)
    1.  [Task 36: Artificial Analysis refresh](#task-36-artificial-analysis-refresh)
    1.  [Task 37: Benchmark import and benchmark-aware ranking](#task-37-benchmark-import-and-benchmark-aware-ranking)
    1.  [Task 38: The user's results outrank benchmarks](#task-38-the-users-results-outrank-benchmarks)
    1.  [Task 39: River and OpenRouter adapters, and the data class from the upstream](#task-39-river-and-openrouter-adapters-and-the-data-class-from-the-upstream)
    1.  [Task 40: ModelScope adapter](#task-40-modelscope-adapter)
    1.  [Task 41: OpenCode adapter](#task-41-opencode-adapter)
    1.  [Task 42: Report with DuckDB](#task-42-report-with-duckdb)
1.  [Phase 4: go-live](#phase-4-go-live)
    1.  [Task 43: The shared skill and the public README](#task-43-the-shared-skill-and-the-public-readme)
    1.  [Task 44: Build the single-file copy](#task-44-build-the-single-file-copy)
    1.  [Task 45: The installer](#task-45-the-installer)
    1.  [Task 46: Systemd units](#task-46-systemd-units)
    1.  [Task 47: Verify script](#task-47-verify-script)
    1.  [Task 48: Pointer lines in the old skills](#task-48-pointer-lines-in-the-old-skills)
    1.  [Task 49: Go live](#task-49-go-live)
1.  [Spec coverage](#spec-coverage)

## Open questions

The design answers the four questions the first edition asked (estimate before a paid fallback, the agy effort rung, benchmark sources, new paid models). They are built in as Tasks 5, 17, 36 to 38 and 33. One question is new.

1.  **Artificial Analysis free-tier endpoint.** The spec names `GET https://artificialanalysis.ai/api/v2/language/models` for the free tier. The vendor's data API reference (read 2026-11-15) marks that path "Pro+ only" and says free integrations use `GET /api/v2/language/models/free`, which has the same `slug`, `evaluations` and `pricing` paths, a `page` query parameter and 100 requests per 24 hours. Default in this plan: Task 36 calls the `/free` path, as the project convention says to follow the official docs. If the user's key is Pro, setting `FANOUT_AA_URL` to the spec's path switches it. The user may confirm or overrule.

## Calls this plan makes

Where the design says "left to the builder", or is silent. A builder who disagrees changes the call here first.

1.  **Layout and the built copy.** Module code is in `~/CS/agent-ops/fanout/`; shared tooling stays at the repo root. Runtime data is in `~/.local/share/agent-ops/fanout/` (`events/`, `learned/`, `run/`, `logs/`, `worktrees/`, `patches/`, `smoke/`, `mined/`, `status.json`, `errors.log`); `FANOUT_HOME` overrides it. The installed CLI is a **built copy** in `~/.local/lib/agent-ops/fanout/<build-id>/` (one bundled `fanout.js` plus the shims, the skill and the unit files), reached through the symlink `~/.local/lib/agent-ops/fanout/current`. The checkout is never on the live path. Every command in this plan runs from the repo root unless it says otherwise.
2.  **Skill location.** `sync-harnesses.sh` builds its canonical set from `~/.claude/skills`, not `~/.agents/skills` (the design says the opposite). The skill source is `fanout/skill/SKILL.md`; the build copies it to `<build>/skill/`. `~/.claude/skills/fanout` and `~/.agents/skills/fanout` are symlinks to `~/.local/lib/agent-ops/fanout/current/skill`, so the sync script links agy, antigravity and hermes, and codex, gemini, copilot, opencode and devin scan the shared folder.
3.  **PATH.** `~/.bashrc` returns early for non-interactive shells, so a PATH line there does not reach agent subshells. The installer adds a marked block to `~/.profile` and before the interactivity guard in `~/.bashrc`, and links `~/.agents/bin/fanout` and `~/.local/bin/fanout` (already on PATH everywhere) to `current/fanout`.
4.  **Additive schema fields (`v` stays 1).** Events: `root` (first attempt id of a chain), `reason: "retry"`, `expected` (`<harness>/<model>` the caller approved), `workspace`, `base_sha`, `pattern` (id of the rule that classified a job end), `detail`, `calls`, `cost_mc`, `cost_est_mc`, `calls_est`, `until`, `outcome` on `limit_hit`, and the event types `smoke` and `trial`. `cost_source` is `computed` or `unknown` only. Catalog columns beyond the design: `family`, `price_call`, `min_brief_bytes`, `aa_slug`, `climb`, `upstream`. Billing value `per_call` (unit MC). The `learned/` folder holds `state.jsonl` (append-only lines `{ts, kind, key, ...}` with kind `gone`, `back`, `smoke`, `first_use`, `judged`), `catalog.auto.json`, `patterns.json` and `benchmarks.json`.
5.  **One job id per attempt; one lease per chain.** `root` links a chain and equals the first attempt's id. `fanout ack <job>` marks the whole chain of that job reported. Jobs whose caller is `upkeep` never block the Stop hook. The lease `run/<root>.lease` lives for the whole chain, not for one attempt, so a chain between two attempts is still "running".
6.  **Workspace base.** Each chain snapshots the caller's working tree (tracked and untracked, not ignored) into an unreferenced commit made with a temporary index, kept alive by `refs/fanout/<root>`. Every attempt checks out a new worktree of that commit under `worktrees/`. The caller's checkout, index and stash are never touched. The worker sees no ignored files (no `node_modules`, no `.env`).
7.  **Output hand-back.** `run` stages the final worktree and writes `patches/<job>.patch` (`git diff --cached --binary <base>`). The block prints `WORKTREE=` and `PATCH=`. The caller reviews, then runs `git apply`.
8.  **Outcome rules.** `ok` ends. `rate_limited`, `quota_exhausted`, `credits_exhausted`, `auth_error`, `model_unavailable`: no retry, `limit_hit` and cooldown, fall back. `unknown`: retry once on the same model; a repeat cools down and falls back. `worker_error` (including learned patterns, a missing CLI, an interrupted or orphaned run): no retry, backoff cooldown except for interrupted and orphaned runs, fall back. `timeout`: no cooldown, fall back; a second timeout in one chain stops it. `job_error` (context length, 413, 422, turn cap): no cooldown, no fallback; the chain stops and reports. `no_effect` (a kind with `writes: true` ended `ok` and changed no file): no cooldown, no fallback; the chain stops and reports, because the brief may be at fault and a retry on a paid model repeats the spend. A chain stops after 8 attempts.
9.  **Finished chain and stale lease.** A chain is finished when no live lease exists for its root and its last `job_start` has a `job_end`. A lease is stale when its pid is dead, or alive with a different start time (`/proc/<pid>/stat` field 22), so a reused pid is never killed. Heartbeat age does not matter, so a WSL suspend does not reap live jobs. A stale lease is reaped: its worker process group is killed when the pid still matches, the job ends `worker_error` with `detail: orphaned lease`, and the cost is computed from the worker log.
10. **Ranking.** Candidates are sorted by: tier; preferred harness (`--harness`); billing rank (`free` and `subscription` 0, `paid` 1, `per_call` 2); estimated job cost in USD (paid rows only; lower first); the user-result band (Call 11); benchmark score over the metrics every scored row of the tier shares (higher first; rows with no benchmark data after rows with data); recent success rate (accepted over accepted plus rejected when verdicts exist, else ok-rate, else 0.5); then `harness/model`. `--model` moves that row first; `--pin` forbids fallback. `per_call` rows rank after paid rows because MC and USD do not compare.
11. **The user's own results win over time.** For a (model, kind) pair with at least 20 judged jobs (`judged` lines in `learned/state.jsonl`, the last verdict per job counts), the pair has a user score: success rate, then cost per accepted job. The band key puts rows with a user score of at least 0.5 first (`USER_FLOOR = 0.5`), rows with no user score next, rows with a user score below 0.5 last; within a user band rows sort by success rate then cost per accepted job, and benchmarks apply only inside the no-score band.
12. **Proven models and promotion.** A row is routable when it is `active` (default or private catalog), or has a `smoke` pass, or has a `first_use` pass, or has 5 accepted `judged` lines (graduation). A `trial` row is routable only as the last candidate of its tier, with at most one live lease, and never first while a proven row of its tier is free. Free, subscription and per-call rows are proven by an upkeep smoke test (per-call at most 2 calls). A paid row has no smoke test: its first real `ok` job that changed a file records `first_use` and promotes it. An explicit `--model` may start on an unproven row (with a `NOTE`); fallbacks use routable rows only.
13. **Chunk size for per-call rows.** Rows with `min_brief_bytes > 0` (ModelScope: 6000) are skipped for smaller briefs. Brief size is the only "bundled" signal.
14. **Per-kind defaults** (`fanout/catalog/kinds.json`: `tier`, `writes`, `prior`). `transcribe`, `reformat`, `rename`, `summarize`, `extract`, `smoke`: tier 1, `writes` true; `inventory`: tier 1, `writes` false (stdout only); `edit`, `refactor`, `test`, `issue`: tier 2, `writes` true; any other kind: tier 2, `writes` true, the edit prior. Priors (tokens in, cached, out): mechanical kinds 100k, 200k, 10k; `edit`, `refactor`, `test`, `issue` 300k, 600k, 30k; `extract` and `smoke` 30k, 0, 3k. Estimates switch to history after 5 accepted jobs of the same kind and `family`.
15. **ModelScope cost.** The user's answer overrides the old skill's "no turn-based estimate" rule; the label "upper-bound guess" keeps its intent. Estimate = turn allowance (adapter default, else 8) times `price_call`. Actual = the `POST /v1/messages` lines in the proxy log inside the job window, only when no other proxy-backed job overlapped; otherwise "unmeasured".
16. **Data class.** A repo with a private remote, or none, is `private`; a public remote (anonymous `git ls-remote` succeeds, cached 24 h) is `public`; `--public` and `--private` override. For proxied harnesses (`claude-fanout`, `river`, `modelscope`) the class comes from the **upstream model name** in the CLIProxyAPI config, never from the alias: an upstream containing `contributor`, starting `stealth/` or ending `:free` is `public-only`, and an OpenRouter upstream whose name is not in the catalog's `upstream` column is `public-only`. The stricter of the catalog class and the upstream class wins.
17. **Climb lists and escalation.** A catalog row's `climb` column is an ordered `|` list of `<model>@<effort>` steps on the same harness. The steps of a row are `[<model>@<efforts[0]>] + climb`. `--escalate-from <job>` starts the step after the job's `<model>@<effort>`, skipping steps that are ineligible; when the steps are spent it starts the best row one tier above, and from tier 3 it refuses. agy climbs effort before tier: Hydrogen `medium`, Hydrogen `xhigh`, Argon `high`. Fallback never uses `climb`.
18. **Learned patterns.** They map to `worker_error`, rank below every built-in rule, need 3 matches across at least 2 chains, and expire after 60 days without a match. The signature is the last stderr line of an `unknown` job end that is not in `patterns/denylist.json`, with numbers, hex, UUIDs and paths normalised. The window is the 30 days the hot path reads; the 24-hour window of the first spec is dropped.
19. **Hooks.** Stop uses `{"decision":"block","reason":...}` and exits 0 when `stop_hook_active` is true; Task 25 confirms the field names against the official hooks page. `CLAUDE_CODE_SESSION_ID` equals the transcript file name, so it equals the payload `session_id`. The two fanout hooks keep `[ -n "$CLAUDE_PROJECT_DIR" ] || exit 0` and drop the `$HOME` guard, because they are keyed to the session and a session started in `$HOME` still owes its report. The exception is recorded in `~/.agents/docs/06-hooks.md` (Task 49).
20. **Notifications.** After a chain is final, every `FALLBACK` and `COST` line is also sent as a desktop notification, best effort. The notifier is `FANOUT_NOTIFY_CMD` (receives title and body as two arguments), else `notify-send`, else `powershell.exe` with a toast script. Failure or a hang past 3 s is ignored. Toast support on this WSL install is verified in Task 49.
21. **Detach and wait.** `run --detach` returns `JOB <id>` once the chain lease exists. `wait <job>` blocks up to 540 seconds (9 minutes, under the 10-minute Bash tool limit), prints the result block and exits like `run`, or prints `RUNNING` and exits 4 so the caller can call it again. The result block is persisted in `logs/<root>.block` and can be printed again.
22. **Keys.** `FANOUT_SECRETS` names the secrets file (default `~/.config/tolong/secrets.env`, where the Meta and Artificial Analysis keys live today). Keys are parsed from `^(export )?NAME=(.*)$` lines, never sourced, and never printed or logged.
23. **Test seams.** Tests drive the `fanout` CLI, the hook wrappers, the installer and the mining script through their public interface and assert on stdout, exit code, files and ledger lines. No unit tests of single functions, no mocked collaborators. Worker CLIs are replaced at the process boundary: the **fake adapter** (`FANOUT_FAKE=1`, harnesses `fake`, `fake2`, `fake3`) replays scripted outputs, and **stub executables** first on `PATH` replay scrubbed output for the real adapters. Test-only knobs: `FANOUT_HOME`, `FANOUT_CATALOG_FILE` (replaces the repo default catalog layer), `FANOUT_NOW`, `FANOUT_NO_SLEEP`, `FANOUT_NO_LAZY`, `FANOUT_PROBE`, `FANOUT_FAKE_SCRIPT`, `FANOUT_FAKE_MODELS`, `FANOUT_CALLER`, `FANOUT_SESSION`, `FANOUT_PROXY_DIR`, `FANOUT_SECRETS`, `FANOUT_NOTIFY_CMD`, `FANOUT_WAIT_MAX_S`, `FANOUT_AA_URL`, `FANOUT_AA_TIMEOUT_S`, `FANOUT_META_URL`, `FANOUT_OPENROUTER_URL`, `FANOUT_DRYRUN`, `FANOUT_INSTALL_NO_SYSTEMD`, `CLIPROXY_BIN`, `FANOUT_LAZY_LOG`, `FANOUT_TEST_STEPS`, `FANOUT_FAKE_WORKER`, plus the `FAKE_*` variables read by the fake worker. The private catalog needs no knob: it is `$HOME/.config/agent-ops/catalog.csv` and the sandbox `HOME` is a temp dir.
24. **Added beyond the design's command table.** `pick --all` (every candidate in chain order; the seam for ranking tests), `run --dry-run`, `--no-paid`, `--effort`, `--max-turns`, `--allow`, `--bypass`, `--expect`, `--max-attempts`, `doctor --notify-test`, and the internal `hook <stop|session-start>` command that the hook wrappers call. `fanout smoke` of the first edition is gone: paid models promote on first use.

## Global constraints

- Bun is the runtime and package manager; tests are `bun test`, run and read before any claim of done. No runtime dependencies (dev: `typescript`, `@types/bun`, plus what the repo already has).
- **Conventional Commits, header at most 50 characters**, passing `commitlint.config.mjs`; check each title with `echo "<title>" | bunx commitlint`. The pre-commit hook runs prettier on staged files (no semicolons, single quotes, width 120), so code samples in this plan are not style-normative.
- **This repo is public.** No secrets, keys, ledger data, transcripts or personal data in any tracked file. Use `~` or `$HOME` in committed text and code, never an absolute home path. Test fixtures are synthetic or scrubbed. Runtime data stays under `~/.local/share/agent-ops/`; the user's catalog stays in `~/.config/agent-ops/catalog.csv`; mined raw output stays outside the repo.
- Read the official docs page before relying on behaviour not confirmed in this session, and link the pages you followed in the PR body. Tasks list "Official docs".
- **Fail open:** a ledger, DuckDB, notifier or upkeep failure never blocks or breaks a worker run.
- Works from every harness: Claude Code, Codex, Gemini CLI, Antigravity, Copilot, OpenCode. The caller is detected from environment variables, `unknown` as the fallback.
- No daily or per-task spend cap. The calling agent must tell the user about every fallback, including a pre-start reroute, and about every paid or per-call job with an estimate before and the actual after. Every `FALLBACK` and `COST` line is also sent as a desktop notification.
- Ledger: append-only JSONL at `~/.local/share/agent-ops/fanout/events/YYYY-MM.jsonl`, one object per line, `v: 1`, written with a single `O_APPEND` `write` per line (no `flock`, no `bun:ffi`), corrupt lines skipped on read, readers ignore unknown fields and skip events with `v > 1`.
- DuckDB is for analytics (`report`) and the one-off transcript mining only. `run`, `pick`, `status` and `wait` read the last 30 days of JSONL in TypeScript.
- Never in the ledger: prompt text, file content, secrets. The ledger holds `brief_sha` only.
- A `public-only` model (any `-contributor` model, `stealth/`, `:free`, unknown OpenRouter upstreams) never receives private data.
- Workers get an environment allowlist, not the caller's environment; `FANOUT_DEPTH` is set and a nested `run` is refused; at most 6 workers run at once and append concurrently.
- Catalog layers: `~/.config/agent-ops/catalog.csv` (private) over `fanout/catalog/catalog.default.csv` (public data only) over auto rows. User tier choices stand (`gemini-4-argon` is tier 3; the retirements of kd, respan, devin and gonka) and live in the private file, never in the repo.
- Benchmarks: the Artificial Analysis Data API (free tier, key `AA_API_KEY`, attribution in the README) refreshes daily; Arena WebDev and FrontierCode 2.0 come only through `fanout benchmarks import`. No HTML scraping, no extraction by a worker.
- Upkeep uses only `free` or `subscription` models, plus at most 2 calls per smoke test on per-call billing. It never spends paid USD credit and never asks the user.
- No multi-account rotation. No login or key-entry automation. No dashboard.
- The two fanout hooks keep the empty-context guard and drop the `$HOME` guard (Call 19). Every other global hook keeps both guards. `settings.json` changes go through the `update-config` skill, after a backup.
- Go-live is the last task; docs, policy, hooks and PATH are touched only there, and the installed CLI is a built copy.
- **Tests never run a real worker CLI and never spend quota.** Listing commands (`agy models`, `codex debug models`, `opencode models`) are free and may be run to capture fixtures; review a capture for account, email or organisation ids before committing it.
- Never print or log a key. The CLIProxyAPI token, the Meta key and the Artificial Analysis key are read inside the process and passed through env or headers only.

## Review focus

Inputs and conditions the spec implies that a user will meet, most likely first. Each has a test in the task named.

1.  A worker that exits 0 and whose output merely mentions `429`, `quota` or `rate limit` (a summary of API docs) must stay `ok`: no fallback, no cooldown. (Task 10)
2.  The alias `muse-spark-1.3` looks safe but maps to `meta/muse-spark-1.3-contributor`: a private chunk must never reach it through the proxy, even when the user types the alias. (Task 39)
3.  The agent stops its turn while a fallback chain is still running: the Stop hook stays silent, and `fanout ack` is refused until the chain ends. (Tasks 22, 25)
4.  Six runs hit the same rate limit within a minute: the backoff steps once (15 to 30 minutes), not six times. (Task 12)
5.  The Artificial Analysis key is missing or the API is down: the upkeep step is skipped, old benchmark values stay, `status` says so, and no run is affected. (Task 36)

## File structure

Paths are relative to the repo root `~/CS/agent-ops/`. Responsibilities, not signatures; the builder chooses internal function names.

```text
package.json  tsconfig.base.json  .gitignore          modified at the root (Tasks 1, 2)
fanout/tsconfig.json  fanout/README.md                module config; public README (Task 43)
fanout/bin/fanout                    bash shim: resolve symlinks, run fanout.js when present, else src/cli.ts
fanout/bin/fanout-stop-hook          bash: empty-context guard, then `fanout hook stop`
fanout/bin/fanout-session-hook       bash: empty-context guard, then `fanout hook session-start`
fanout/catalog/catalog.default.csv   public models, efforts, public prices, data class, aa_slug, climb, upstream
fanout/catalog/catalog.private.example.csv   template for ~/.config/agent-ops/catalog.csv (Task 49 fills the real one)
fanout/catalog/benchmarks.seed.json  seed scores (public numbers)
fanout/catalog/kinds.json            tier, writes and prior per kind
fanout/catalog/discovery-ignore.txt  regexes discovery must not add
fanout/patterns/*.json               shipped error patterns: generic, denylist and one per adapter
fanout/skill/SKILL.md                the one shared skill
fanout/systemd/fanout-upkeep.service  fanout-upkeep.timer
fanout/install/{build.sh,install.sh,verify.sh}   build the copy; install it; five-minute end-to-end check
fanout/sql/report.sql
fanout/tools/mine/{mine.ts,pairs.sql}   one-off transcript mining (dev tool, not shipped)
fanout/src/cli.ts                    argv dispatch, caller detection, lazy upkeep trigger
fanout/src/{clock,paths,ulid,events,scrub,csv,catalog,benchmarks,state,caller,dataclass,pick,rank,cost,classify,exec,workspace,lease,reaper,run,result,notify,status,duckdb}.ts
fanout/src/commands/{run,wait,pick,status,ack,verdict,report,doctor,upkeep,benchmarks,hook}.ts
fanout/src/adapters/{types,index,fake,codex,agy,claude-cli,proxy,meta,river,claude-fanout,modelscope,opencode}.ts
fanout/src/upkeep/{index,lock,lazy,doctor,discover,smoke,benchmarks,patterns,housekeeping}.ts
fanout/tests/*.test.ts               CLI-level tests, one file per task
fanout/tests/helpers/{sandbox,fake-worker}.ts   fanout/tests/fixtures/...
```

Outside the repo, created by Task 49: `~/.local/lib/agent-ops/fanout/`, `~/.agents/bin/fanout`, `~/.local/bin/fanout`, `~/.agents/skills/fanout`, `~/.claude/skills/fanout`, `~/.config/agent-ops/catalog.csv`, `~/.config/systemd/user/fanout-upkeep.{service,timer}`, `~/.agents/docs/24-fanout-ledger.md`. Edited by Task 49: `~/.agents/docs/{06-hooks.md,08-fanout.md}`, `~/.agents/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.claude/settings.json`, `~/.bashrc`, `~/.profile`. Edited by Task 48: the `SKILL.md` of the seven old `*-fanout` skills.

## Shared contracts

Defined once. Tasks refer to them by name.

**Adapter contract** (`fanout/src/adapters/types.ts`, created in Task 4, extended only by adding optional members):

```ts
export type Outcome =
  | 'ok'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'credits_exhausted'
  | 'auth_error'
  | 'model_unavailable'
  | 'timeout'
  | 'worker_error'
  | 'job_error'
  | 'no_effect'
  | 'unknown'
export type Billing = 'subscription' | 'free' | 'paid' | 'per_call'
export interface BuildInput {
  model: string
  effort?: string
  cwd: string
  briefPath: string
  job: string
  outDir: string
  timeoutS: number
  maxTurns: number
  bypass: boolean
  allow: string[]
}
export interface BuiltCommand {
  argv: string[]
  cwd: string
  env: Record<string, string | null> // null = unset
  stdinPath?: string
  stdinText?: string
  secrets: string[]
  reportPath?: string
}
export interface RunOutput {
  exit: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}
export interface Classified {
  outcome: Outcome
  scope?: 'model' | 'account'
  until?: number
  cooldownS?: number
  pattern?: string
}
export interface Usage {
  tokensIn: number
  tokensOut: number
  tokensCached: number
} // in = uncached input + cache creation; cached = cache reads. Cost is always computed from the catalog.
export interface ModelInfo {
  model: string
  efforts?: string[]
  billing?: Billing
  priceIn?: number
  priceCached?: number
  priceOut?: number
  priceCall?: number
  dataClass?: 'any' | 'public-only'
}
export type Preflight = { ok: true } | { ok: false; outcome: Outcome; detail: string }
export class SkipCandidate extends Error {
  constructor(
    public reason: string,
    public outcome: Outcome = 'model_unavailable'
  ) {
    super(reason)
  }
}
export interface Adapter {
  name: string
  defaults?: { timeoutS?: number; maxTurns?: number }
  envAllow?: string[] // extra caller env names copied to the worker; a trailing * is a prefix
  build(i: BuildInput): BuiltCommand // may throw SkipCandidate
  classify(r: RunOutput, nowMs: number): Classified
  usage(stdout: string): Usage | undefined
  listModels(): Promise<ModelInfo[]>
  preflight(o?: { quick?: boolean }): Promise<Preflight> // quick = no network and no auth call
  upstream?(model: string): string | undefined // proxied adapters: upstream model name from the proxy config
  proxyBacked?: boolean // jobs share one proxy log, so per-call counts cannot be attributed when they overlap
  measure?(w: {
    startMs: number
    endMs: number
    route: string
    overlapped: boolean
  }): Promise<{ calls: number } | 'unmeasured'>
  probe?(): Promise<{ remainingPct?: number; resetsAt?: number } | undefined>
}
```

Model ids may contain `/` (`Qwen/Qwen3.8-27B`), so a catalog key is `<harness>/<model>` and splits at the first `/` only.

**Catalog columns** (all three layers): `harness,model,efforts,tier,billing,price_in,price_cached,price_out,price_call,min_brief_bytes,data_class,status,family,aliases,aa_slug,climb,upstream,note`. `efforts` is `|`-separated, the first is the default, empty means pass no effort flag. A private row overrides only its non-empty cells; a `model` of `*` applies to every model of the harness (used for retirements). Status: `active`, `trial`, `retired`.

**`pick` output** (built up in Tasks 3 and 5; exit 3 with `REFUSED <reason>` when nothing is eligible):

```text
PICK harness=<h> model=<m> tier=<t> billing=<b> effort=<e> data=<public|private>
THEN <h>/<m>, <h>/<m>, <h>/<m>
PAID <h>/<m> ESTIMATE <amount> (<basis>)
```

`THEN` lists the next up to 3 candidates. `PAID` names the first `paid` or `per_call` candidate in the whole chain (it may be the pick itself) with its estimate, or reads `PAID none (no paid or per-call model in the chain)`. The basis is `prior; fewer than 5 samples`, `history; 5 samples` (any count of 5 or more) or, for per-call rows, `8 turns x 2 MC, upper-bound guess`. `pick --all` adds one `CAND <n> <h>/<m> tier=<t> effort=<e> billing=<b> class=<any|public-only> status=<s>` line per candidate in chain order.

**Result block** (exact text, built up in Tasks 6, 11, 16, 19):

```text
FANOUT job=<id> harness=<h> model=<m> outcome=<o> attempt=<n>
FALLBACK <h>/<m> <outcome> (resets HH:MM) -> <h2>/<m2>. Tell the user, then run: fanout ack <job>
FALLBACK <h>/<m> not started (<reason>) -> <h2>/<m2>. Tell the user, then run: fanout ack <job>
COST paid API (<h>/<m>): estimated $0.40, actual $0.31 (computed from tokens). Tell the user, then run: fanout ack <job>
COST per-call (<h>/<m>): estimated 16 MC (8 turns x 2 MC, upper-bound guess), actual 6 calls = 12 MC (counted from proxy log). Tell the user, then run: fanout ack <job>
```

`(resets HH:MM)` appears only when a reset time is known, in local time. `actual unknown` (paid) and `actual unmeasured` (per-call) replace the actual when usage is missing. After those lines: `RETRY ...`, `NOTE ...`, `DENIALS=<n>`, `WORKTREE=<path>`, `PATCH=<path>`, `LOG=<path>`, `REPORT=<path>`. A failed chain adds `FAILED ...` (Tasks 11, 15). Progress lines that must appear before the end (`ESTIMATE`, `WAIT`) go to stderr as they happen. Exit codes: 0 ok, 1 chain failed, 2 usage error, 3 refused (policy, or no eligible candidate), 4 chain still running (`wait` only).

**Learned state** (`~/.local/share/agent-ops/fanout/learned/state.jsonl`, append-only, one JSON object per line, the last line per `(kind, key)` wins; `judged` is keyed by `job`): `{"ts","kind":"gone|back","key":"<h>/<m>"}`, `{"kind":"smoke","key","result":"pass|fail|skipped","detail"}`, `{"kind":"first_use","key","result":"pass|fail"}`, `{"kind":"judged","key","job","task_kind","accepted":bool,"cost_usd":n}`.

**Test sandbox** (`fanout/tests/helpers/sandbox.ts`, Task 1): `sandbox()` returns `{ home, repo, env, brief(text?, bytes?), catalog(csv), catalogPrivate(csv), script(map), at(iso), bin(name, shellBody), pathWithout(names), seed(events), seedLearned(file, lines), fanout(args, opts?), start(args, opts?), ledger(), learned(file) }`. `home` is a temp dir used as both `HOME` and `FANOUT_HOME`; `repo` is a temp git repo with one commit and no remote; `fanout()` spawns `bun fanout/src/cli.ts` with the sandbox env (`FANOUT_FAKE=1`, `FANOUT_NO_LAZY=1`, `FANOUT_NO_SLEEP=1`, `FANOUT_CALLER=test`, `FANOUT_SESSION=S1`, `TZ=Asia/Kuala_Lumpur`, `FANOUT_CATALOG_FILE` = the fake catalog) and resolves `{ code, stdout, stderr }`; `start()` returns `{ pid, stdoutSoFar(), stderrSoFar(), done() }`; the module also exports `waitFor(predicate, timeoutMs)`; `script(map)` writes `FANOUT_FAKE_SCRIPT` and resets the fake counters for the keys it names; `seed(events)` writes ledger lines into the month file of each event's `ts`; `ledger()` returns every parsed event across month files sorted by `ts` then `id`; `learned(file)` parses a file under `learned/` and `seedLearned(file, lines)` writes one; `bin()` writes an executable stub into a directory placed first on `PATH`; `pathWithout(names)` returns a `PATH` built from a temp directory of symlinks to every executable on the current `PATH` except the named ones (so a test can hide `notify-send`).

**Fake catalog** (`fanout/tests/fixtures/catalog.fake.csv`, all `active` unless stated, `data_class` `any` unless stated; `efforts` is `medium|low` on every `fake` and `fake2` row except where stated, and empty on every `fake3` row): tier 1 subscription `fake/f1-a` and `fake/f1-b` (efforts `medium|low`), `fake2/f1-c`; tier 2 subscription `fake/f2-a` (efforts `medium|high`, `climb` `f2-a@high|f3-z@high`), `fake2/f2-b`; tier 3 subscription `fake/f3-z` (efforts `high`), `fake3/f3-a`; tier 1 paid `fake2/f1-paid` (1.00 / 0.10 / 2.00, `family` `fam-paid`) and `fake3/f1-paid-b` (0.50 / 0.05 / 1.00, `family` `fam-b`); tier 1 free `public-only` `fake3/f1-pub`; tier 1 `per_call` `fake3/f1-call` (`price_call` 2, `min_brief_bytes` 6000); tier 1 free `trial` `fake3/f1-trial`.

**Test notation.** In test lists, `RUN` is `run --brief <B> --dir <repo> --kind transcribe` where `B` is the brief `Rename foo to bar in a.txt, nothing else.`; `script({k: [..]})` is `FANOUT_FAKE_SCRIPT`; `at(t)` is `FANOUT_NOW`; clock times are local (`Asia/Kuala_Lumpur`, UTC+8, so `at('2026-11-15T01:00:00Z')` is 09:00 and `18:00` is `10:00Z`); `<26>` is a 26-character ULID; `job_start(...)` and `job_end(...)` are ledger events matched with `toMatchObject`.

## Phase 1: core

Phase 1 builds the hot path and the three first adapters. Nothing in it touches the user's global config.

### Task 1: Module scaffold and test sandbox

The repo is already initialised (do not run `git init`). This task adds the module folder, the shared TypeScript config and the test sandbox.

**Files:**

- Modify: `package.json` (root): devDependencies `typescript`, `@types/bun`; scripts `"test": "bun test fanout"`, `"typecheck": "tsc --noEmit -p fanout"`
- Create: `tsconfig.base.json`, `fanout/tsconfig.json` (extends the base: `strict`, `module ESNext`, `moduleResolution bundler`, `target ESNext`, `types ["bun"]`), `fanout/src/version.ts` (`VERSION = '0.1.0'`), `fanout/src/cli.ts`, `fanout/bin/fanout`, `fanout/tests/helpers/sandbox.ts`
- Test: `fanout/tests/cli.test.ts`

**Interfaces:**

- Produces: `sandbox()` and `waitFor()` as in "Shared contracts"; `cli.ts` dispatches `argv[2]` to a command table that later tasks extend.

Official docs: https://bun.sh/docs/cli/test

- [ ] **Step 1: Write the failing tests** `fanout/tests/cli.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sandbox } from './helpers/sandbox'

test('--version prints the version and exits 0', async () => {
  const r = await sandbox().fanout(['--version'])
  expect(r.code).toBe(0)
  expect(r.stdout.trim()).toBe('fanout 0.1.0')
})
test('unknown command exits 2 with usage on stderr', async () => {
  const r = await sandbox().fanout(['frobnicate'])
  expect(r.code).toBe(2)
  expect(r.stderr).toMatch(/usage: fanout <command>/i)
})
test('the bin shim works through a symlink from another cwd', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fanout-link-'))
  symlinkSync(resolve(import.meta.dir, '../bin/fanout'), join(tmp, 'linked'))
  const p = Bun.spawnSync([join(tmp, 'linked'), '--version'], { cwd: tmp })
  expect(p.exitCode).toBe(0)
  expect(p.stdout.toString().trim()).toBe('fanout 0.1.0')
})
```

- [ ] **Step 2: Run it.** `bun test fanout/tests/cli.test.ts`. Expected: FAIL, "Cannot find module './helpers/sandbox'".
- [ ] **Step 3: Implement module scaffold and test sandbox.** `bun add -d typescript @types/bun`, then write the files above.
  - `sandbox.ts` follows "Shared contracts" (temp `home`, temp git `repo` with one commit, env, `fanout()` via `Bun.spawn`).
  - `cli.ts`: `--version` prints `fanout <VERSION>`; an unknown or missing command prints `usage: fanout <command> [options]` to stderr and exits 2.
  - `bin/fanout` (bash, `chmod +x`): resolve its own symlink chain with `readlink -f`; if `fanout.js` sits beside it run `exec bun "$ROOT/fanout.js" "$@"`, else `exec bun "$ROOT/../src/cli.ts" "$@"`; find bun with `command -v bun`, else `$HOME/.bun/bin/bun`.
- [ ] **Step 4: Run.** `bun test fanout` prints `3 pass`, `0 fail`. `bun run typecheck` exits 0.
- [ ] **Step 5: Commit.** Title `chore(fanout): scaffold module and test sandbox`. `git add -A && git commit -m "chore(fanout): scaffold module and test sandbox"`.

### Task 2: Public repo hygiene

The repo is public. This task adds ignore rules for everything the runtime produces and a test that fails when a tracked file carries a secret, a ledger, or a personal path.

**Files:**

- Modify: `.gitignore` (append a `# fanout` block)
- Test: `fanout/tests/hygiene.test.ts`

The root `.gitignore` already ignores `*.jsonl`, `events/`, `*.duckdb`, `.env*`, `node_modules/` and `.worktrees/`. Append: `*.log`, `*.lease`, `*.patch`, `*.block`, `status.json`, `learned/`, `worktrees/`, `patches/`, `smoke/`, `secrets.env`, `*.pem`, `*.key`, `fanout/.tmp/`, `fanout/dist/`.

- [ ] **Step 1: Write the failing tests** `fanout/tests/hygiene.test.ts` (runs `git` as a child process):

```ts
test('runtime artefacts are git-ignored', () => {
  for (const p of [
    'fanout/.tmp/x',
    'fanout/dist/fanout.js',
    'x/status.json',
    'a/errors.log',
    'run/J.lease',
    'logs/J.block',
    'patches/J.patch',
    'secrets.env',
    'k.pem',
    'events/2026-11.jsonl',
    'learned/state.jsonl',
    'mined/pairs.jsonl',
    'a.duckdb'
  ])
    expect(spawnSync('git', ['check-ignore', '-q', p]).status).toBe(0)
})
test('no tracked file carries a secret, an email, or an absolute home path', () => {
  const files = gitLsFiles().filter(
    (f) => !/^(\.agents|\.claude)\//.test(f) && !['bun.lock', 'skills-lock.json'].includes(f)
  )
  const bad: string[] = []
  for (const f of files) for (const [name, re] of RULES) if (re.test(readFileSync(f, 'utf8'))) bad.push(`${f}: ${name}`)
  expect(bad).toEqual([])
})
test('no ledger, database, log or env file is tracked', () => {
  expect(
    gitLsFiles().filter(
      (f) =>
        /\.(jsonl|duckdb|log|lease|patch|block)$|(^|\/)(status\.json|\.env[^/]*|secrets\.env)$/.test(f) &&
        !f.endsWith('.env.example')
    )
  ).toEqual([])
})
```

`RULES` (written with escaped slashes so the rule text does not match itself): absolute home paths in Linux, macOS and Windows form (`\/home\/[a-z]|\/Users\/|C:\\Users`); emails (`[\w.+-]+@[\w-]+\.[a-z]{2,}` except `@users.noreply.github.com` and `@example.com` and `@example.invalid`); key shapes (`\bAIza[\w-]{30,}`, `\bsk-[\w-]{16,}`, `Bearer [\w.-]{16,}`, `-----BEGIN [A-Z ]*PRIVATE KEY`, and `(api[_-]?key|token|secret|password)\s*[=:]\s*["']?[\w-]{20,}`). Test fixtures that need a fake key build it at runtime (`'sk-' + 'x'.repeat(24)`), so the source never matches.

- [ ] **Step 2: Run it.** `bun test fanout/tests/hygiene.test.ts`. Expected: the first test FAILS (`status.json`, `.lease`, `.block` and the other new patterns are not ignored yet); the other two pass on the current tree.
- [ ] **Step 3: Implement** the `.gitignore` block.
- [ ] **Step 4: Run.** Expected: `3 pass`. If the second test finds a violation in an existing tracked file, fix the file (do not weaken the rule). This plan and the design spec must pass it: use `~` and `$HOME` in text.
- [ ] **Step 5: Commit.** Title `chore(fanout): ignore runtime data, scan for leaks`.

### Task 3: Catalog layers and the pick skeleton

`fanout pick` is the dispatch question's data source and the seam for every ranking and catalog test. This task builds the layered catalog, the eligibility filters and the first ordering.

**Files:**

- Create: `fanout/src/{csv,clock,paths,catalog,pick}.ts`, `fanout/src/commands/pick.ts`, `fanout/catalog/catalog.default.csv`, `fanout/catalog/catalog.private.example.csv`, `fanout/catalog/kinds.json`, `fanout/catalog/discovery-ignore.txt`, `fanout/tests/fixtures/catalog.fake.csv`
- Modify: `fanout/src/cli.ts` (register `pick`)
- Test: `fanout/tests/pick.test.ts`

**Interfaces:**

- Produces: `loadCatalog(): { rows: CatalogRow[]; warnings: string[] }` (rows are merged and validated; `CatalogRow` has the catalog columns as typed fields); `candidates(input): Candidate[]` where `input = { kind, startTier?, harness?, briefBytes, dataClass, noPaid? }`; `kindInfo(kind): { tier, writes, prior }`.

**Behaviour.**

- Layers, lowest to highest: auto rows (`learned/catalog.auto.json`, shape `{ "rows": [<row object with the catalog column names>] }`, written by Task 32), the default catalog, the private catalog. The default is imported as text (`import csv from '../catalog/catalog.default.csv' with { type: 'text' }`) so the built copy needs no sidecar file; `FANOUT_CATALOG_FILE` replaces it in tests. The private catalog is `$HOME/.config/agent-ops/catalog.csv`. A private row overrides only its non-empty cells. A row with `model` `*` applies its non-empty cells to every model of that harness, auto rows included.
- Validation: a row whose `tier` is not 1, 2 or 3, whose `billing` or `status` is unknown, or whose price is missing (`paid` needs `price_in` and `price_out`; `per_call` needs `price_call`) is skipped with a warning `WARN catalog row skipped: <h>/<m>: <reason>` on stderr, and the command carries on. An **auto** row that is unpriced is expected (discovery cannot always price a model) and is skipped silently.
- Eligible: status `active` (rows with status `trial` are not routable until Task 33), not retired, brief at least `min_brief_bytes`, tier at or above the start tier (`--tier`, else the kind's default from `kinds.json`). Data class and cooldowns arrive in Tasks 4 and 12.
- Order: tier, then `--harness` preference, then billing rank (`free` and `subscription` 0, `paid` 1, `per_call` 2), then `harness/model`. Tasks 5, 37 and 38 add keys.
- `pick --brief <f> --dir <d> --kind <k> [--harness h] [--tier n] [--all]` prints `PICK` and `THEN` per "Shared contracts"; exit 3 with `REFUSED no eligible candidate` when the list is empty.
- `catalog.default.csv` holds public data only: harness, model, efforts, public prices, data class, `family`, `climb`, `upstream`. Its rows are in the table below.
- A specific row beats a wildcard row of the same layer. The private file may use any subset of the columns, as long as `harness` and `model` are present.

**Default catalog rows.** Prices are USD per 1M tokens in / cached / out, taken from the old skills and `~/.local/share/cc-duckdb/fanout_models.csv`; the `ref` rows there are not workers and are not seeded.

| harness       | model                        | efforts               | tier | billing      | prices / call                          | class       | status | notes                                                                   |
| ------------- | ---------------------------- | --------------------- | ---- | ------------ | -------------------------------------- | ----------- | ------ | ----------------------------------------------------------------------- |
| codex         | gpt-6-luna                   | medium\|low\|high     | 1    | subscription | none                                   | any         | active | cheapest, bulk mechanical                                               |
| codex         | gpt-6.1-sol                  | medium\|low\|high     | 2    | subscription | none                                   | any         | active | best value                                                              |
| codex         | gpt-6-astra                  | medium\|low\|high     | 3    | subscription | none                                   | any         | active | strongest fanout model                                                  |
| agy           | gemini-3.8-flash             | low\|medium           | 1    | subscription | none                                   | any         | active | trivial high-volume                                                     |
| agy           | gemini-4-hydrogen            | medium\|xhigh         | 2    | subscription | none                                   | any         | active | `climb` `gemini-4-hydrogen@xhigh\|gemini-4-argon@high`                  |
| agy           | gemini-4-argon               | high\|medium\|low     | 2    | subscription | none                                   | any         | active | effort ceiling `high`; the user's private catalog sets tier 3 (Task 49) |
| meta          | muse-ember-1.0               | xhigh\|high\|low      | 1    | paid         | 0.10 / 0.10 / 0.50                     | any         | active | cached price unknown, set to the input price                            |
| meta          | muse-spark-1.3-contributor   | xhigh\|high\|low      | 1    | paid         | 0.10 / 0.002 / 0.20                    | public-only | active | Meta trains on it; `family` `muse-spark`                                |
| meta          | muse-spark-1.3               | xhigh\|max\|high\|low | 1    | paid         | 1.25 / 0.15 / 4.25                     | any         | active | for private data; `family` `muse-spark`                                 |
| meta          | muse-wonder-1.0              | xhigh\|max\|high      | 2    | paid         | 4.00 / 0.20 / 20.00                    | any         | active | preview                                                                 |
| river         | deepseek-v4.1-flash-river    | low\|high\|max\|none  | 1    | paid         | 0.12 / 0.0024 / 0.48                   | any         | active | `upstream` `deepseek-ai/DeepSeek-V4.1-Flash`                            |
| river         | glm-5.3-flash-river          | low\|high\|max        | 1    | paid         | 0.12 / 0.024 / 0.40                    | any         | active | `upstream` `zai-org/GLM-5.3-Flash`                                      |
| claude-fanout | glm-5.3-flash                | low\|medium\|high     | 1    | paid         | 0.075 / 0.075 / 0.25                   | any         | active | OpenRouter through the proxy; `upstream` `z-ai/glm-5.3-flash`           |
| claude-fanout | qwen3.7-flash                | (empty)               | 1    | paid         | 0.03 / 0.03 / 0.13                     | any         | trial  | `upstream` `qwen/qwen3.7-flash`                                         |
| claude-fanout | deepseek-v4-flash            | (empty)               | 1    | paid         | 0.08 / 0.08 / 0.16                     | any         | trial  | `upstream` `deepseek/deepseek-v4-flash`                                 |
| claude-fanout | minimax-m3                   | (empty)               | 2    | paid         | 0.30 / 0.30 / 1.20                     | any         | trial  | the step-up; `upstream` `minimax/minimax-m3`                            |
| opencode      | opencode/space-bunny-free    | (empty)               | 1    | free         | none                                   | any         | trial  | zero-retention per the old skill                                        |
| opencode      | opencode/step-5-preview-free | (empty)               | 1    | free         | none                                   | any         | trial  | zero-retention per the old skill                                        |
| modelscope    | Qwen/Qwen3.8-27B             | (empty)               | 2    | per_call     | `price_call` 1, `min_brief_bytes` 6000 | any         | active | 1 MC per call, the old skill's default                                  |

`family` equals `model` unless stated. `kinds.json` is the map in Call 14. `discovery-ignore.txt` holds `^agy/claude-`. `catalog.private.example.csv` is the same header plus two commented-out example lines. `tests/fixtures/catalog.fake.csv` is the "Fake catalog" of "Shared contracts" (without `fake3/f1-paid-b`, which Task 5 adds).

- [ ] **Step 1: Write the failing tests** `fanout/tests/pick.test.ts` (sandbox; `sb.brief()` is a 40-byte brief; the default catalog is used where stated by passing `{ noCatalog: true }`, which removes `FANOUT_CATALOG_FILE`):

```ts
test('transcribe starts at tier 1 and prints PICK and THEN lines', async () => {
  const r = await sb.fanout(['pick', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toBe(
    'PICK harness=fake model=f1-a tier=1 billing=subscription effort=medium data=private'
  )
  expect(r.stdout).toMatch(/^THEN fake\/f1-b, fake2\/f1-c/m)
})
test('a private catalog row overrides only its non-empty cells', async () => {
  sb.catalogPrivate('harness,model,tier\nfake,f2-a,1\n')
  const r = await sb.fanout(['pick', '--all', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
  expect(r.stdout).toMatch(/^CAND \d+ fake\/f2-a tier=1 effort=medium /m) // efforts still from the default layer
})
```

- `edit starts at tier 2`. Input: `pick --kind edit`. Expect: first line `PICK harness=fake model=f2-a tier=2 billing=subscription effort=medium data=private`.
- `--tier overrides the kind`. Input: `pick --kind transcribe --tier 3`. Expect: first line starts `PICK harness=fake model=f3-z tier=3`; `pick --all` lists no tier 1 or 2 rows.
- `manual trial rows are not routed`. Input: `pick --all` on the fake catalog. Expect: no `fake3/f1-trial` line; every `CAND` ends `status=active`.
- `per_call rows need a large brief`. Input: `pick --all` with `sb.brief(undefined, 100)` then with `sb.brief(undefined, 7000)`. Expect: `fake3/f1-call` absent, then present after every tier 1 `paid` row (billing rank 2).
- `retired private row hides a model`. Input: private csv `harness,model,status\nfake2,f1-c,retired`. Expect: no `fake2/f1-c` in `pick --all`.
- `a wildcard row retires a whole harness`. Input: private csv `harness,model,status\nfake3,*,retired`. Expect: no `fake3/` line in `pick --all` (the auto rows of `fake3` too).
- `a specific private row beats a wildcard row`. Input: private csv `harness,model,status\nfake3,*,retired\nfake3,f1-pub,active` and `--public`. Expect: `fake3/f1-pub` listed, other `fake3/` rows absent.
- `layer order is private over default over auto`. Input: `learned/catalog.auto.json` = `{"rows":[{"harness":"fake","model":"f2-a","tier":1,"billing":"subscription","status":"active"},{"harness":"fake","model":"f2-new","tier":2,"billing":"subscription","status":"active"}]}`. Expect: `fake/f2-a` keeps `tier=2` (the default wins over auto) and `fake/f2-new` is listed at `tier=2` (an auto-only row).
- `a bad row is skipped with a warning and pick still works`. Input: default catalog line `fake,bad,,9,subscription,...` (tier 9). Expect: exit 0, stderr contains `WARN catalog row skipped: fake/bad: tier must be 1, 2 or 3`, `fake/bad` not listed.
- `an unpriced paid row is skipped`. Input: a `paid` row with an empty `price_out`. Expect: stderr `WARN catalog row skipped: <h>/<m>: paid row needs price_in and price_out`; row not listed.
- `--harness prefers within a tier and never changes the tier`. Input: `pick --kind transcribe --harness fake2`. Expect: first line `harness=fake2 model=f1-c tier=1`; `THEN` starts `fake/f1-a`. Input: `--harness fake3` (its tier 1 rows are excluded here). Expect: first line `harness=fake model=f1-a tier=1`.
- `nothing eligible exits 3`. Input: private csv retiring `fake,*`, `fake2,*` and `fake3,*`. Expect: exit 3, stdout `REFUSED no eligible candidate`.
- `default catalog: argon is tier 2 until the user's private catalog says 3`. Input: `{ noCatalog: true }`, `pick --all --kind edit --harness agy`; then private csv `harness,model,tier\nagy,gemini-4-argon,3`. Expect: first run lists `agy/gemini-4-argon tier=2`, second `tier=3`; neither lists `kd/`, `respan/`, `devin/` or `gonka/`; `meta/muse-spark-1.3-contributor` shows `class=public-only`.

- [ ] **Step 2: Run.** `bun test fanout/tests/pick.test.ts`. Expected: FAIL, "unknown command pick".
- [ ] **Step 3: Implement catalog layers and the pick skeleton.**
  - `csv.ts`: `parseCsv(text): Record<string, string>[]` (quoted cells, `#` comment lines).
  - `catalog.ts`: `loadCatalog()` merging the three layers, the wildcard rule and the validation above; `kindInfo(kind)` from `kinds.json` (an unknown kind gets tier 2, `writes` true and the edit prior).
  - `pick.ts`: `candidates(input)` applying the eligibility rules and the order above.
  - `commands/pick.ts`: print `PICK`, `THEN` and, with `--all`, `CAND` lines; register in `cli.ts`.
  - Write `catalog.default.csv`, `catalog.private.example.csv`, `kinds.json`, `discovery-ignore.txt` and the fake catalog from the table above.
- [ ] **Step 4: Run.** `bun test fanout` passes, 0 fail. `bun run typecheck` exits 0.
- [ ] **Step 5: Commit.** Title `feat(fanout): layered catalog and pick command`.

### Task 4: Data class

A private chunk must never reach a `public-only` model. This task detects the chunk's class, takes the stricter of the catalog class and the upstream class, and filters.

**Files:**

- Create: `fanout/src/dataclass.ts`, `fanout/src/adapters/{types,index,fake}.ts` (only `upstream()` of the fake adapter is exercised here; Task 6 completes it)
- Modify: `fanout/src/{pick,paths}.ts`, `fanout/src/commands/pick.ts` (`--public`, `--private`, the `data=` field)
- Test: `fanout/tests/dataclass.test.ts`

**Interfaces:**

- Produces: `chunkClass(dir, flags): 'public' | 'private'`; `rowClass(row, adapter): 'any' | 'public-only'`; `candidates(input)` now filters on `input.dataClass`.

**Behaviour** (Call 16).

- Chunk class: no remote, or any remote whose anonymous `git ls-remote --exit-code <url> HEAD` fails (`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=true`, 5 s timeout), is `private`; all remotes reachable anonymously is `public`. Results are cached 24 h in `run/dataclass-cache.json` (`{ "<url>": { "public": bool, "ts": ISO } }`). `FANOUT_PROBE=public|private` forces the probe result. `--public` and `--private` override; both together exit 2.
- Row class: the stricter of the catalog `data_class` and the upstream class. `adapter.upstream(model)` returns the upstream name; an upstream containing `contributor`, starting `stealth/` or ending `:free` is `public-only`. The fake adapter returns `JSON.parse(process.env.FAKE_UPSTREAM ?? '{}')['<h>/<m>']`.
- A private chunk drops `public-only` rows; `REFUSED no eligible candidate (private chunk; public-only rows skipped: <n>)` when that leaves nothing.

- [ ] **Step 1: Write the failing tests** `fanout/tests/dataclass.test.ts`:
- `no remote is private`. Input: `pick` in the sandbox repo (no remote). Expect: first line ends `data=private`.
- `an unreachable remote is private and the probe does not hang`. Input: `git remote add origin https://example.invalid/x.git`, no `FANOUT_PROBE`. Expect: `data=private`, finished in under 10 s.
- `FANOUT_PROBE forces the answer`. Input: `FANOUT_PROBE=public` then `private`, `pick --all`. Expect: `data=public` with `fake3/f1-pub` listed; `data=private` without it.
- `overrides`. Input: `--private` with `FANOUT_PROBE=public`; `--public` with no remote. Expect: `data=private`; `data=public`. Input: `--public --private`. Expect: exit 2, stderr `--public and --private conflict`.
- `a fresh cache entry is used and a stale one is not`. Input: remote `https://example.invalid/x.git`, `run/dataclass-cache.json` = `{"https://example.invalid/x.git":{"public":true,"ts":"2026-11-15T00:00:00.000Z"}}`, `at('2026-11-15T01:00:00Z')`. Expect: `data=public`. Input: same with `ts` `2026-11-13T00:00:00.000Z`. Expect: `data=private`.
- `the upstream class is stricter than the catalog class`. Input: `FAKE_UPSTREAM={"fake2/f1-c":"meta/muse-x-contributor"}`, private chunk, `pick --all`. Expect: no `fake2/f1-c`; with `--public` it is listed.
- `stealth and :free upstreams are public-only`. Input: `FAKE_UPSTREAM={"fake2/f1-c":"stealth/alpha","fake/f1-b":"acme/model:free"}`. Expect: both absent for a private chunk, present with `--public`.
- `a public-only catalog row stays public-only whatever the upstream`. Input: `FAKE_UPSTREAM={"fake3/f1-pub":"acme/ok"}`, private chunk. Expect: `fake3/f1-pub` absent.
- `only public-only rows left`. Input: private csv `harness,model,status\nfake,*,retired\nfake2,*,retired\nfake3,*,retired\nfake3,f1-pub,active`, private chunk. Expect: exit 3, stdout `REFUSED no eligible candidate (private chunk; public-only rows skipped: 1)`.

- [ ] **Step 2: Run.** `bun test fanout/tests/dataclass.test.ts`. Expected: FAIL (`--public` is not a known option).
- [ ] **Step 3: Implement data class.**
  - `dataclass.ts`: `chunkClass()` with the probe, cache and overrides; `rowClass()` with the upstream rule.
  - `adapters/types.ts` and `adapters/index.ts`: the contract and a registry `adapterFor(harness)`; `adapters/fake.ts`: `name` from the harness, `upstream()` from `FAKE_UPSTREAM`.
  - `pick.ts` and `commands/pick.ts`: filter, flags, the `REFUSED` text.
- [ ] **Step 4: Run.** `bun test fanout` passes. `bun run typecheck` exits 0.
- [ ] **Step 5: Commit.** Title `feat(fanout): data class from remote and upstream`.

### Task 5: Estimate, price-aware ranking and the PAID line

The user must hear a number before any spend, so `pick` prints the estimate of the first paid candidate in the chain. The same estimate ranks paid rows.

**Files:**

- Create: `fanout/src/{cost,rank}.ts`
- Modify: `fanout/src/{pick,catalog}.ts`, `fanout/src/commands/pick.ts`, `fanout/catalog/kinds.json` (priors), `fanout/tests/fixtures/catalog.fake.csv` (add `fake3/f1-paid-b`)
- Test: `fanout/tests/rank.test.ts`

**Interfaces:**

- Produces: `estimate(row, kind, o?: { maxTurns?: number }): { usd?: number; mc?: number; calls?: number; basis: 'prior' | 'history' | 'per_call'; samples: number } | undefined` (history arrives in Task 22); `formatUsd(n): string` (two decimals from $0.01, four below); `compareRows(a, b, ctx): number` used by `candidates()`.

**Behaviour.**

- `paid` estimate: the kind's prior tokens (Call 14) times the row's prices, `(in x price_in + cached x price_cached + out x price_out) / 1e6`. `per_call`: calls = `--max-turns` (default 8) times `price_call` MC. `free` and `subscription`: no estimate.
- Order keys now: tier, `--harness`, billing rank, estimated USD ascending (paid rows only), `harness/model`.
- `PAID <h>/<m> ESTIMATE <amount> (<basis>)` names the first `paid` or `per_call` candidate of the whole chain; `PAID none (no paid or per-call model in the chain)` otherwise.

- [ ] **Step 1: Write the failing tests** `fanout/tests/rank.test.ts` (fake catalog, `transcribe` unless stated):
- `PAID names the first paid candidate and its prior estimate`. Input: `pick`. Expect: a line `PAID fake3/f1-paid-b ESTIMATE $0.07 (prior; fewer than 5 samples)` (the cheaper paid row: `(100000 x 0.50 + 200000 x 0.05 + 10000 x 1.00) / 1e6 = 0.07`).
- `paid rows are ordered by estimated cost`. Input: `pick --all`. Expect: `fake3/f1-paid-b` has a lower `CAND` number than `fake2/f1-paid`, and both come after `fake2/f1-c` and before every tier 2 row.
- `the estimate follows the kind`. Input: `pick --kind extract` (prior 30k, 0, 3k). Expect: `PAID fake3/f1-paid-b ESTIMATE $0.02 (prior; fewer than 5 samples)` (`(30000 x 0.50 + 3000 x 1.00) / 1e6 = 0.018`).
- `no paid row in the chain`. Input: `pick --kind edit` (tier 2 and up has only subscription rows). Expect: `PAID none (no paid or per-call model in the chain)`.
- `the pick itself is paid`. Input: private csv retiring `fake,*` and `fake2,*`. Expect: first line `PICK harness=fake3 model=f1-paid-b tier=1 billing=paid`; the `PAID` line names `fake3/f1-paid-b`.
- `per-call estimate in MC`. Input: private csv `harness,model,status\nfake,*,retired\nfake2,*,retired\nfake3,f1-paid-b,retired`, brief of 7000 bytes. Expect: `PAID fake3/f1-call ESTIMATE 16 MC (8 turns x 2 MC, upper-bound guess)`. Input: add `--max-turns 4`. Expect: `ESTIMATE 8 MC (4 turns x 2 MC, upper-bound guess)`.
- `usd formatting`. Input: private csv `harness,model,price_in,price_cached,price_out\nfake2,f1-paid,0.1,0,0.1`, `pick --kind extract`. Expect: `PAID fake2/f1-paid ESTIMATE $0.0033 (prior; fewer than 5 samples)` (`(30000 x 0.1 + 3000 x 0.1) / 1e6 = 0.0033`, four decimals below $0.01) and `fake2/f1-paid` now ranks before `fake3/f1-paid-b` in `pick --all`.
- `pick accepts --max-turns`. Input: `pick --max-turns 4 --kind transcribe`. Expect: exit 0 (the flag only matters for per-call estimates).

- [ ] **Step 2: Run.** `bun test fanout/tests/rank.test.ts`. Expected: FAIL (`PAID` line missing).
- [ ] **Step 3: Implement estimate, price-aware ranking and the PAID line.**
  - `cost.ts`: `estimate()` and `formatUsd()` as above.
  - `rank.ts`: `compareRows()` with the keys above; `candidates()` in `pick.ts` sorts with it.
  - `commands/pick.ts`: print the `PAID` line from the first paid or per-call candidate; accept `--max-turns <n>`.
  - Add the `prior` arrays to `kinds.json`; add `fake3/f1-paid-b` to the fake catalog.
- [ ] **Step 4: Run.** `bun test fanout` passes. `bun run typecheck` exits 0.
- [ ] **Step 5: Commit.** Title `feat(fanout): estimate and price-aware ranking`.

### Task 6: Ledger writer and the first run

The first end-to-end slice: `fanout run` dispatches one chunk through the fake adapter, writes the ledger and prints the first line of the result block. Appends are plain `O_APPEND` writes; six runs at once must not corrupt the ledger.

**Files:**

- Create: `fanout/src/{ulid,events,scrub,exec,run,result,caller}.ts`, `fanout/src/commands/run.ts`, `fanout/tests/helpers/fake-worker.ts`
- Modify: `fanout/src/adapters/{index,fake}.ts` (complete the fake adapter), `fanout/src/cli.ts` (register `run`)
- Test: `fanout/tests/run-basic.test.ts`

**Interfaces:**

- Consumes: `candidates(input)` (Tasks 3 to 5), `adapterFor(harness)` (Task 4).
- Produces: `appendEvent(event: Record<string, unknown>): void` (never throws); `newId(): string` (ULID); `readEvents(sinceMs: number): Event[]` (30-day window, skips corrupt lines and `v > 1`); `detectCaller(env): { caller: string; session?: string }`; `runChain(opts): Promise<ChainResult>` (the attempt loop that later tasks extend).

Official docs: https://bun.sh/docs/api/spawn, https://man7.org/linux/man-pages/man2/open.2.html (`O_APPEND`)

**Behaviour.**

- `run --brief <f> --dir <d> --kind <k>` (all required; a missing flag exits 2 with `usage: fanout run --brief <file> --dir <dir> --kind <kind> [options]`). One attempt: rank, take the first candidate, quick `preflight`, build the command, append `job_start` {harness, model, effort, tier, kind, `data_class` (the chunk class), attempt, reason `initial`, billing, `brief_sha` (sha256 of the brief file), `root`}, run the process, append `job_end` {harness, model, outcome, exit, `duration_s`, `tokens_in`, `tokens_out`, `tokens_cached`, `cost_source`} (the harness and model repeat the `job_start` so a `job_end` is self-describing). For now an exit of 0 is `ok` and anything else `unknown`; Task 10 classifies. `cost_source` is `computed` when the adapter reported usage, else `unknown`. `stderr_tail` is stored only when the outcome is not `ok`. The worker runs in `--dir` itself until Task 9.
- Ledger: every event has `v: 1`, `ts` (ISO, honouring `FANOUT_NOW`), `event`, `id` (ULID: 26 Crockford characters, monotonic within a process), `caller`, `session`, `repo` (the base name of the git top-level directory, never a path). The month file comes from the event's UTC date. An append opens the file with `O_APPEND | O_CREAT | O_WRONLY` (mode 0600), writes the whole line and its newline in one `write`, and closes it. Directories are mode 0700. Any failure goes to `errors.log` and never throws.
- Caller detection (best effort; only Claude Code was verified): `FANOUT_CALLER` (with `FANOUT_SESSION`) wins when non-empty; `CLAUDECODE=1` gives `claude-code` with `CLAUDE_CODE_SESSION_ID`; `CODEX_THREAD_ID`, `CODEX_SANDBOX` or `CODEX_CI` gives `codex`; `GEMINI_CLI=1` gives `gemini`; `OPENCODE=1` gives `opencode`; any `ANTIGRAVITY_*` gives `antigravity`; any `COPILOT_*` gives `copilot`; else `unknown`.
- Fake adapter: `FANOUT_FAKE_SCRIPT` is a JSON file `{ "<harness>/<model>": ["rate_limited", "ok"] }`; each `build()` consumes the next scenario for that key (the counter lives in `$FANOUT_HOME/fake-counters.json`; no entry means `ok`). `build()` returns argv `["bun", <FANOUT_FAKE_WORKER or tests/helpers/fake-worker.ts>, <scenario>, <briefPath>]`, `envAllow` `['FAKE_*']`. `usage()` parses a `USAGE in=<n> cached=<n> out=<n>` line. `listModels()` returns `JSON.parse(FANOUT_FAKE_MODELS ?? "[]")`. `preflight()` is `{ok:true}`.
- Scenarios written now in `fake-worker.ts` (later tasks add more in their own Modify lines): `ok` (writes `out.txt`, writes `seen.txt` listing the names visible in its cwd, prints `done` and `USAGE in=1000 cached=0 out=200`, exit 0), `ok_slow` (as `ok` after `FAKE_SLEEP_S` seconds, default 3), `ok_mentions_429` (exit 0, stdout says "see the 429 Too Many Requests section"), `rate_limited` (stderr `HTTP 429 Too Many Requests`, exit 1), `rate_limited_reset` (adds `resets at 18:00`), `quota_exhausted` (`You have exhausted your quota; try again in 2 hours`, exit 1), `credits_exhausted` (`HTTP 402 insufficient funds`, exit 1), `auth_error` (`HTTP 401 unauthorized`, exit 1), `model_unavailable` (`model x is not recognized`, exit 1), `unknown_error` (`kaboom 42`, exit 1), `custom_error` (stderr `$FAKE_STDERR`, exit 1), `timeout` (starts a grandchild `sleep 60`, writes its pid to `$FAKE_PIDFILE`, sleeps 60 s), `echo_brief` (stderr echoes the first 200 characters of the brief and `key=$FAKE_SECRET`, exit 1), `writes_then_limit` (writes `partial.txt`, then `HTTP 429`, exit 1).

- [ ] **Step 1: Write the failing tests** `fanout/tests/run-basic.test.ts`:

```ts
test('ok run: block, ledger and exit code', async () => {
  const r = await sb
    .at('2026-11-15T01:00:00Z')
    .fanout([
      'run',
      '--brief',
      sb.brief('Rename foo to bar in a.txt, nothing else.'),
      '--dir',
      sb.repo,
      '--kind',
      'transcribe'
    ])
  expect(r.code).toBe(0)
  expect(r.stdout.split('\n')[0]).toMatch(
    /^FANOUT job=[0-9A-HJKMNP-TV-Z]{26} harness=fake model=f1-a outcome=ok attempt=1$/
  )
  const [start, end] = sb.ledger()
  expect(start).toMatchObject({
    v: 1,
    ts: '2026-11-15T01:00:00.000Z',
    event: 'job_start',
    harness: 'fake',
    model: 'f1-a',
    tier: 1,
    kind: 'transcribe',
    attempt: 1,
    reason: 'initial',
    billing: 'subscription',
    data_class: 'private',
    caller: 'test',
    session: 'S1'
  })
  expect(start.brief_sha).toMatch(/^[0-9a-f]{64}$/)
  expect(end).toMatchObject({
    event: 'job_end',
    outcome: 'ok',
    exit: 0,
    tokens_in: 1000,
    tokens_out: 200,
    tokens_cached: 0,
    cost_source: 'computed'
  })
  expect(end.job).toBe(start.job)
  expect(end.root).toBe(start.job)
})
```

- `edit kind starts at tier 2`. Input: `run --kind edit`. Expect: first line has `model=f2-a`; `job_start` has `tier: 2`.
- `caller detection`. Input (each run with `FANOUT_CALLER` and `FANOUT_SESSION` set to the empty string): `CLAUDECODE=1` and `CLAUDE_CODE_SESSION_ID=abc`; then `GEMINI_CLI=1`; then `OPENCODE=1`; then `CODEX_CI=1`; then `ANTIGRAVITY_AGENT=1`; then `COPILOT_CLI=1`; then none. Expect: `job_start` `caller`/`session` of `claude-code`/`abc`, `gemini`, `opencode`, `codex`, `antigravity`, `copilot`, `unknown`.
- `the brief text never reaches the ledger`. Input: a 40-character brief sentence. Expect: no file under `events/` and no `errors.log` contains it (a `grep -r` finds nothing).
- `six concurrent runs leave 12 valid, unique-id lines`. Input: `start()` six `RUN` with script `{'fake/f1-a': ['ok_slow', 'ok_slow', 'ok_slow', 'ok_slow', 'ok_slow', 'ok_slow']}` and `FAKE_SLEEP_S=1`, then `Promise.all`. Expect: `ledger()` has 12 events, 12 distinct `id`, and the month file has no unparsable line.
- `no eligible candidate exits 3`. Input: private csv retiring `fake,*`, `fake2,*`, `fake3,*`. Expect: exit 3, stdout `REFUSED no eligible candidate`, no ledger file.
- `a missing flag or an unreadable brief exits 2`. Input: `run --dir <repo> --kind transcribe` (no brief); then `--brief /nope`. Expect: exit 2 with `usage: fanout run --brief`; exit 2 with stderr `cannot read brief /nope`.
- `modes`. Input: one run. Expect: `events/2026-11.jsonl` mode `0600`, the data dir mode `0700`, every file under `logs/` mode `0600`.
- `repo is a name, not a path`. Input: one run in the sandbox repo. Expect: `job_start.repo` equals the base name of `sb.repo` and contains no `/`.

- [ ] **Step 2: Run.** `bun test fanout/tests/run-basic.test.ts`. Expected: FAIL, "unknown command run".
- [ ] **Step 3: Implement ledger writer and the first run.**
  - `ulid.ts` `newId()`; `events.ts` `appendEvent()` and `readEvents()` as above; `paths.ts` gains `dataDir()` (`FANOUT_HOME` or `~/.local/share/agent-ops/fanout`).
  - `caller.ts` `detectCaller()`; `scrub.ts` `scrubTail(text, secrets, brief)` (masks the secrets, `Bearer …`, `sk-…`, `AIza…` and `key=value` shapes; keeps the last 400 characters; Task 20 tests it).
  - `exec.ts` `runProcess(cmd, timeoutS)` minimal (spawn, collect); Task 7 hardens it.
  - `run.ts` `runChain()` and `result.ts` `renderBlock()` (first line only for now); `commands/run.ts` argument parsing, exit codes; register in `cli.ts`.
  - Complete `adapters/fake.ts` and write `tests/helpers/fake-worker.ts` with the scenarios above.
- [ ] **Step 4: Run.** `bun test fanout` passes. `bun run typecheck` exits 0.
- [ ] **Step 5: Commit.** Title `feat(fanout): run one attempt and write the ledger`.

### Task 7: Process runner, chain lease, environment allowlist and depth guard

A worker is a process group. The runner must be able to kill it, the lease must describe it, the worker must not inherit the caller's secrets, and a worker must not start another fanout.

**Files:**

- Create: `fanout/src/lease.ts`
- Modify: `fanout/src/{exec,run,paths}.ts`, `fanout/src/adapters/fake.ts` (scenarios `print_env` and `nested_run`), `fanout/tests/helpers/fake-worker.ts`
- Test: `fanout/tests/process.test.ts`

**Interfaces:**

- Produces: `acquireLease(chain): Lease` (file `run/<root>.lease`), `Lease.setWorker(pid, pgid)`, `Lease.release()`; `workerEnv(adapter, built, depth): Record<string, string>`; the signal trap inside `runChain()`.

**Behaviour.**

- Process runner: spawn detached (own process group); stream stdout and stderr to `logs/<job>.log` and `logs/<job>.err` (mode 0600) and keep 256 KB and 64 KB tails in memory; on timeout send `SIGTERM` to the group, then `SIGKILL` after 5 s; a timed-out attempt ends with outcome `timeout`.
- Chain lease `run/<root>.lease` (JSON, mode 0600): `{ root, job, pid, startTicks, pgid, workerTicks, harness, model, started, heartbeat }`. `pid` is the `fanout run` process, `startTicks` is field 22 of `/proc/<pid>/stat` (parse after the last `)` because the command name may contain spaces), `pgid` is the current worker's process group (the worker is its leader) and `workerTicks` is the worker's own start ticks. It is written before the first `job_start`, updated for each attempt, refreshed every 15 s (`unref`'d interval, for display only) and removed when the chain ends or is interrupted.
- Environment allowlist: the worker gets `PATH HOME USER LOGNAME SHELL LANG LC_ALL LC_CTYPE TERM TMPDIR TZ XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy` from the caller, plus the names the adapter lists in `envAllow`, plus the `env` the adapter's `build()` returns (a `null` value unsets), plus `FANOUT_DEPTH` set to the caller's depth plus one. Nothing else is passed.
- Depth guard: when the caller's `FANOUT_DEPTH` is 1 or more, `run` exits 3 with `REFUSED nested fanout (FANOUT_DEPTH=<n>)` and writes no event.
- Signals: `run` traps `SIGTERM` and `SIGINT`: kill the worker group (`SIGTERM`, then `SIGKILL` after 2 s), append `job_end` {outcome `worker_error`, detail `interrupted by SIGTERM` or `interrupted by SIGINT`}, release the lease, exit 143 or 130.

- [ ] **Step 1: Write the failing tests** `fanout/tests/process.test.ts`:
- `the lease describes the chain while the worker runs and is gone afterwards`. Input: `start(RUN)` with script `{'fake/f1-a': ['ok_slow']}`, `FAKE_SLEEP_S=2`; poll `run/` for `*.lease`. Expect: while running, one lease file whose JSON has `root` equal to the first `job_start.job`, `pid` equal to `p.pid`, numeric `startTicks`, `pgid` and `workerTicks`, `harness: 'fake'`, `model: 'f1-a'`; after `done()` no `.lease` file remains.
- `a timeout kills the whole process group`. Input: `RUN --timeout 1` with script `{'fake/f1-a': ['timeout']}`, `FAKE_PIDFILE=<tmp>/pid`. Expect: the first `job_end` has `outcome: 'timeout'` and `duration_s` between 1 and 4; `process.kill(Number(readFileSync(pidfile)), 0)` throws `ESRCH` (the grandchild `sleep 60` died with the group).
- `the worker environment is the allowlist and nothing else`. Input: `RUN` with scenario `print_env` (writes `process.env` as `NAME=value` lines to `$FAKE_OUT`), caller env `SECRET_PROBE=1`, `ANTHROPIC_API_KEY=x`, `FAKE_OUT=<tmp>/env.txt`, `FAKE_FLAG=1`. Expect: `env.txt` contains `FANOUT_DEPTH=1`, `FAKE_FLAG=1` and a `PATH=` line, and contains no line starting `SECRET_PROBE`, `ANTHROPIC_API_KEY`, `FANOUT_HOME`, `FANOUT_FAKE_SCRIPT`.
- `a nested run is refused`. Input: `RUN` with `FANOUT_DEPTH=1` in the caller env. Expect: exit 3, stdout `REFUSED nested fanout (FANOUT_DEPTH=1)`, no ledger file.
- `a worker that calls fanout run is refused`. Input: `RUN` with scenario `nested_run` (the worker runs `bun $FAKE_CLI run --brief $FAKE_BRIEF --dir . --kind transcribe` with its own environment and writes that command's stdout to `$FAKE_OUT`), `FAKE_CLI` and `FAKE_BRIEF` set. Expect: `$FAKE_OUT` contains `REFUSED nested fanout (FANOUT_DEPTH=1)`.
- `SIGTERM stops the chain cleanly`. Input: `start(RUN)` with scenario `timeout` and `FAKE_PIDFILE`; wait for the lease; `process.kill(p.pid, 'SIGTERM')`. Expect: exit code 143 within 8 s; the grandchild pid dead; the last event is `job_end` {outcome: 'worker_error', detail: 'interrupted by SIGTERM'}; no `.lease` file.
- `SIGINT stops the chain cleanly`. Input: as above with `SIGINT`. Expect: exit code 130; `job_end` detail `interrupted by SIGINT`.

- [ ] **Step 2: Run.** `bun test fanout/tests/process.test.ts`. Expected: FAIL (no lease file appears).
- [ ] **Step 3: Implement process runner, chain lease, environment allowlist and depth guard.**
  - `exec.ts`: `runProcess()` with detached spawn, log files, tails, the timeout kill and the `timedOut` flag.
  - `lease.ts`: `acquireLease()` and the start-ticks reader; wire it into `runChain()` before the first `job_start`.
  - `exec.ts` `workerEnv()`: the allowlist and the depth value; `run.ts`: the depth refusal and the signal trap.
  - Add the `print_env` and `nested_run` scenarios.
- [ ] **Step 4: Run.** `bun test fanout` passes. `bun run typecheck` exits 0.
- [ ] **Step 5: Commit.** Title `feat(fanout): process groups and env allowlist`.

### Task 8: Detach and wait

An agent's shell call dies at 10 minutes, so a long chain must outlive its caller. `run --detach` starts the chain and returns at once; `fanout wait` blocks for up to 9 minutes per call.

**Files:**

- Create: `fanout/src/commands/wait.ts`
- Modify: `fanout/src/{run,result,cli}.ts`, `fanout/src/commands/run.ts` (`--detach`, internal `--root`)
- Test: `fanout/tests/detach.test.ts`

**Interfaces:**

- Consumes: `acquireLease()` (Task 7).
- Produces: `findChain(job): { root: string; state: 'running' | 'finished' | 'unknown' }`; the persisted block `logs/<root>.block` (mode 0600) that `run` writes when the chain ends, before it releases the lease.

**Behaviour** (Call 21).

- `run --detach <run options>`: check the options and the candidate list in the parent (a refusal exits 3 here, before anything starts); generate the root id; spawn `bun <cli> run <same options> --root <id>` detached, with stdout and stderr appended to `logs/<root>.chain`, `unref()`; wait up to 5 s for `run/<root>.lease`; print `JOB <root>` and `WAIT run: fanout wait <root>` and exit 0. If the lease never appears, print `FAILED detach: the chain did not start (see logs/<root>.chain)` and exit 1. The hidden `--root` makes the first attempt's job id equal to the root.
- `wait <job> [--max <s>]`: resolve the chain of any job id in it. When the lease is gone, print the block from `logs/<root>.block` and exit with the chain's code (0 when the final `job_end` is `ok`, else 1). While the lease lives, poll every 500 ms; at the limit (`--max`, else `FANOUT_WAIT_MAX_S`, else 540) print `RUNNING job=<root> elapsed=<n>s; run again: fanout wait <root>` and exit 4 (`elapsed` is the time this call waited). An unknown id exits 2 with `unknown job <id>`. A chain that ended without a block file (Task 23 rebuilds it) prints `NOTE no result block for <root>` and exits 1.

- [ ] **Step 1: Write the failing tests** `fanout/tests/detach.test.ts` (script `{'fake/f1-a': ['ok_slow']}`):
- `detach returns the job id at once and the chain keeps running`. Input: `run --detach` with `FAKE_SLEEP_S=5`. Expect: exit 0 in under 3 s; stdout is `JOB <26>` then `WAIT run: fanout wait <the same 26>`; `run/<id>.lease` exists and `process.kill(lease.pid, 0)` does not throw; the ledger has a `job_start` and no `job_end` yet.
- `wait prints the result block and exits like run`. Input: detach (`FAKE_SLEEP_S=2`), then `wait <id>`. Expect: exit 0; first stdout line `FANOUT job=<id> harness=fake model=f1-a outcome=ok attempt=1`; no `.lease` file; `logs/<id>.block` mode `0600`.
- `wait times out with RUNNING and exit 4, and can be called again`. Input: detach with `FAKE_SLEEP_S=6`; `wait <id>` with `FANOUT_WAIT_MAX_S=1`; then `wait <id>` with `FANOUT_WAIT_MAX_S=30`. Expect: first call exit 4 and stdout `RUNNING job=<id> elapsed=1s; run again: fanout wait <id>`; second call exit 0 and the `FANOUT` line.
- `wait on a finished chain prints the same block again`. Input: `wait <id>` twice after the chain ended. Expect: identical stdout, exit 0 both times.
- `wait on an unknown job exits 2`. Input: `wait 01HZZZZZZZZZZZZZZZZZZZZZZZ`. Expect: exit 2, stderr `unknown job 01HZZZZZZZZZZZZZZZZZZZZZZZ`.
- `a refused chain is refused before detaching`. Input: private csv retiring every fake harness, `run --detach`. Expect: exit 3, stdout `REFUSED no eligible candidate`, no `logs/*.chain` file.
- `run options reach the detached chain`. Input: `run --detach --kind edit`, then `wait`. Expect: the ledger `job_start` has `model: 'f2-a'` and `tier: 2`.
- `a block that is missing`. Input: delete `logs/<id>.block` after the chain ended, `wait <id>`. Expect: exit 1, stdout `NOTE no result block for <id>`.

- [ ] **Step 2: Run.** `bun test fanout/tests/detach.test.ts`. Expected: FAIL (`--detach` is not a known option).
- [ ] **Step 3: Implement detach and wait.**
  - `commands/run.ts`: `--detach` (parent path) and `--root` (child path).
  - `run.ts`: write `logs/<root>.block` at the end of the chain, then release the lease.
  - `commands/wait.ts`: `findChain()` and the polling loop; register in `cli.ts`.
- [ ] **Step 4: Run.** `bun test fanout` passes. `bun run typecheck` exits 0.
- [ ] **Step 5: Commit.** Title `feat(fanout): detach a chain and wait for it`.

### Task 9: Workspaces per attempt

Every attempt gets a fresh workspace. In a git repo that is a worktree of a snapshot of the caller's tree; outside git the worker runs in place and fallback needs a clean slate.

**Files:**

- Create: `fanout/src/workspace.ts`
- Modify: `fanout/src/{run,result}.ts`
- Test: `fanout/tests/workspace.test.ts`

**Interfaces:**

- Produces: `openWorkspace(dir, root, job, attempt): Workspace` with `{ cwd, mode: 'git' | 'plain', worktree?, baseSha?, changedFiles(): string[] | 'unknown', finish(job): { patch?: string } }`.

Official docs: https://git-scm.com/docs/git-worktree

**Behaviour** (Calls 6 and 7).

- Git mode: `git rev-parse --show-toplevel`; snapshot commit with a temporary index (`GIT_INDEX_FILE`; `read-tree HEAD` unless unborn; `add -A` honouring `.gitignore`; `write-tree`; `commit-tree -p HEAD`, author `fanout <fanout@localhost>`); `git update-ref refs/fanout/<root> <sha>`. Each attempt: `git worktree add --detach <home>/worktrees/<job>-a<attempt> <sha>` plus a sibling marker file `<worktree>.fanout-repo` holding the repo path (outside the worktree, so `git add -A` never stages it). The worker's cwd is the worktree plus the `--dir` path relative to the repo root.
- On the final attempt: `git add -A` in the worktree, `git diff --cached --binary <sha> > patches/<job>.patch`; the block prints `WORKTREE=<path>` and `PATCH=<path>`. `job_start` gets `workspace` and `base_sha`.
- Non-git mode: the worker runs in `--dir`; before the first attempt record a manifest (`path` to `size:mtimeMs`, skipping `.git` and `node_modules`, capped at 5000 files); `changedFiles()` compares it afterwards and returns `unknown` when capped. No `WORKTREE` or `PATCH` lines.

- [ ] **Step 1: Write the failing tests** `fanout/tests/workspace.test.ts` (a temp repo with `dirty.txt` committed then edited, an untracked `untracked.txt`, and an ignored `ignored.log` listed in `.gitignore`; script `ok`, whose `seen.txt` lists the names the worker could see; `run()` is `RUN` and `line(r, 'PATCH=')` reads a block line):

```ts
test('worker sees tracked-modified and untracked files, not ignored ones', async () => {
  const r = await run()
  const patch = readFileSync(line(r, 'PATCH='), 'utf8')
  expect(patch).toContain('+++ b/seen.txt')
  expect(patch).toMatch(/\+dirty\.txt/)
  expect(patch).toMatch(/\+untracked\.txt/)
  expect(patch).not.toMatch(/ignored\.log/)
})
```

- `the caller checkout is untouched`. Input: `git status --porcelain=v2`, `git rev-parse HEAD` and `git stash list` before and after one run. Expect: identical output; `dirty.txt` still has the uncommitted edit.
- `layout`. Input: one run. Expect: the `WORKTREE=` path is under `<home>/worktrees/` and ends `-a1`; the file `<worktree>.fanout-repo` holds the repo path; the patch text has no `.fanout-repo`; `git for-each-ref refs/fanout/` lists exactly `refs/fanout/<root>`.
- `the patch applies to the original repo`. Input: `git apply --check` of the patch in the original repo. Expect: exit 0.
- `--dir inside a subfolder`. Input: `RUN` with `--dir <repo>/sub`. Expect: the patch header `+++ b/sub/seen.txt` (the worker's cwd was the subfolder of the worktree).
- `a non-git directory runs in place`. Input: `RUN` with `--dir` a temp directory that is not a repo. Expect: `out.txt` exists in that directory; stdout has no `WORKTREE=` and no `PATCH=` line.
- `job_start records the workspace`. Input: one run. Expect: `job_start.workspace` matches `/worktrees\/.+-a1$/` and `job_start.base_sha` equals `git rev-parse refs/fanout/<root>`.
- `an unborn repo works`. Input: `git init` in a temp dir with one untracked file and no commit, `RUN`. Expect: exit 0 and a `PATCH=` line whose patch lists `seen.txt` and the untracked file.

- [ ] **Step 2: Run.** `bun test fanout/tests/workspace.test.ts`. Expected: FAIL (no `PATCH=` line in the block).
- [ ] **Step 3: Implement workspaces per attempt.**
  - `workspace.ts`: `openWorkspace()` for git (snapshot, worktree, marker, patch) and plain (manifest) modes, with `changedFiles()`.
  - `run.ts`: open a workspace per attempt, run the worker in `ws.cwd`, add `workspace` and `base_sha` to `job_start`; `result.ts`: print `WORKTREE=` and `PATCH=`.
- [ ] **Step 4: Run.** `bun test fanout` passes. `bun run typecheck` exits 0.
- [ ] **Step 5: Commit.** Title `feat(fanout): worktree per attempt and patches`.

### Task 10: Outcome classification and reset parsing

Every later rule hangs on the outcome class. This task classifies an attempt from its exit code and output, parses stated reset times, and records `limit_hit` events. Fallback itself comes in Task 11.

**Files:**

- Create: `fanout/src/classify.ts`, `fanout/patterns/generic.json`, `fanout/tests/fixtures/patterns/fake.json`
- Modify: `fanout/src/run.ts`, `fanout/src/adapters/fake.ts` (load `fake.json` as the adapter's rules), `fanout/tests/helpers/fake-worker.ts` (scenarios `rate_limited_soon`: stderr `HTTP 429 try again in 10 minutes`, exit 1; `stdout_limit`: `HTTP 429 Too Many Requests` on stdout only, exit 1; `ok_hidden_failure`: prints `FAKE_HIDDEN_FAILURE`, exit 0)
- Test: `fanout/tests/classify.test.ts`

**Interfaces:**

- Produces: `classify(adapter, out: RunOutput, nowMs): Classified` (rule order: the adapter's rules, then `generic.json`, then learned rules from Task 34); `parseReset(text, nowMs): number | undefined` (epoch ms); rule file shape `{ "rules": [{ "id", "re", "outcome", "scope"?, "onExit0"?, "cooldownS"? }] }` (case-insensitive regex).

**Behaviour.**

- A timed-out attempt is `timeout`. With exit 0 only rules flagged `onExit0` apply, so a worker that merely quotes an error stays `ok`. With a non-zero exit the first matching rule wins, scanning stderr and the last 2 KB of stdout; no match gives `unknown`. Default scope: `credits_exhausted` and `auth_error` are `account`, the rest `model`. `job_end` gets `pattern` (the rule id) when a rule matched.
- `generic.json` ids and regexes: `gen-429` (`\b429\b|rate.?limit|too many requests`) `rate_limited`; `gen-quota` (`quota|usage limit|exhausted your|RESOURCE_EXHAUSTED`) `quota_exhausted`; `gen-credits` (`insufficient (account )?funds|credit|\b402\b|payment`) `credits_exhausted`, scope account; `gen-auth` (`\b401\b|\b403\b|unauthorized|not logged in|auth_unavailable|invalid api key`) `auth_error`; `gen-model` (`model .* (not found|is not recognized|unavailable|deprecated)|invalid model`) `model_unavailable`; `gen-overload` (`overloaded|model_concurrency|\b503\b`) `rate_limited` with `cooldownS` 30.
- `fake.json` holds two rules: `fake-special` (`special-quota`) `quota_exhausted`, and `fake-hidden` (`FAKE_HIDDEN_FAILURE`) `worker_error` with `onExit0`.
- Reset parsing (local zone from `TZ`): `retry-after: 120`, `try again in 2 hours 5 minutes`, `resets in 3h 20m`, `resets at 18:00`, `resets 6:00 PM` (the next occurrence: a time already past today means tomorrow), ISO timestamps.
- On `rate_limited`, `quota_exhausted`, `credits_exhausted`, `auth_error` or `model_unavailable`: append `limit_hit` {harness, model, scope, outcome, source, until}. `until` is the stated reset (source `stated`), else a `cooldownS` from the rule, else now plus 15 minutes (source `backoff`; Task 12 adds the doubling).

- [ ] **Step 1: Write the failing tests** `fanout/tests/classify.test.ts` (each test runs `RUN` with `script({'fake/f1-a': [<scenario>]})` and reads the first `job_end` and the `limit_hit`; the exit code of the chain is not asserted because fallback arrives in Task 11; `at('2026-11-15T01:00:00Z')` unless stated):

```ts
test('a limit with a stated clock reset is recorded as stated', async () => {
  sb.at('2026-11-15T01:00:00Z').script({ 'fake/f1-a': ['rate_limited_reset'] })
  await sb.fanout(['run', '--brief', sb.brief(), '--dir', sb.repo, '--kind', 'transcribe'])
  const end = sb.ledger().find((e) => e.event === 'job_end')
  const hit = sb.ledger().find((e) => e.event === 'limit_hit')
  expect(end).toMatchObject({ outcome: 'rate_limited', pattern: 'gen-429' })
  expect(hit).toMatchObject({
    harness: 'fake',
    model: 'f1-a',
    scope: 'model',
    outcome: 'rate_limited',
    source: 'stated',
    until: '2026-11-15T10:00:00.000Z'
  })
})
```

- `rate_limited without a time backs off 15 minutes`. Input: scenario `rate_limited`. Expect: `limit_hit` {source: 'backoff', until: '2026-11-15T01:15:00.000Z'}.
- `quota_exhausted states a relative reset`. Input: scenario `quota_exhausted`. Expect: `job_end.outcome` `quota_exhausted`, pattern `gen-quota`; `limit_hit` {source: 'stated', until: '2026-11-15T03:00:00.000Z'}.
- `credits and auth are account scope; model errors are model scope`. Input: scenarios `credits_exhausted`, `auth_error`, `model_unavailable` in three runs. Expect: `limit_hit.scope` `account`, `account`, `model`; patterns `gen-credits`, `gen-auth`, `gen-model`.
- `unknown errors record no limit`. Input: scenario `unknown_error`. Expect: `job_end.outcome` `unknown`, no `pattern` field, no `limit_hit` event.
- `exit 0 that mentions 429 stays ok` (Review focus 1). Input: scenario `ok_mentions_429`. Expect: `job_end.outcome` `ok`, no `limit_hit`.
- `stdout is scanned too`. Input: scenario `stdout_limit`. Expect: `job_end.outcome` `rate_limited`.
- `adapter rules rank before generic rules`. Input: scenario `custom_error` with `FAKE_STDERR='HTTP 429 special-quota'`. Expect: `job_end` {outcome: 'quota_exhausted', pattern: 'fake-special'}.
- `an onExit0 rule applies to a clean exit`. Input: scenario `ok_hidden_failure`. Expect: `job_end` {outcome: 'worker_error', pattern: 'fake-hidden', exit: 0}.
- `overload backs off 30 seconds`. Input: scenario `custom_error`, `FAKE_STDERR='model overloaded'`. Expect: `job_end.pattern` `gen-overload`; `limit_hit` {source: 'backoff', until: '2026-11-15T01:00:30.000Z'}.
- `reset phrases`. Input: scenario `custom_error` with `FAKE_STDERR` = `HTTP 429 ` plus each phrase, one run each. Expect (`limit_hit.until`, source `stated`): `retry-after: 120` at 01:00Z gives `2026-11-15T01:02:00.000Z`; `try again in 2 hours 5 minutes` gives `T03:05:00.000Z`; `resets in 3h 20m` gives `T04:20:00.000Z`; `resets at 18:00` at 01:00Z (09:00 local) gives `T10:00:00.000Z`; `resets at 18:00` at 12:00Z (20:00 local) gives `2026-11-16T10:00:00.000Z`; `resets 6:00 PM` at 01:00Z gives `T10:00:00.000Z`; `resets 2026-11-16T03:00:00Z` gives that instant.

- [ ] **Step 2: Run.** `bun test fanout/tests/classify.test.ts`. Expected: FAIL (`job_end.pattern` is undefined and no `limit_hit` event exists).
- [ ] **Step 3: Implement outcome classification and reset parsing.**
  - `classify.ts`: `classify()` with the exit-0 rule, the stdout window, scope defaults, rule order; `parseReset()` for the phrases above.
  - `generic.json` and the fake adapter's rule file; wire `classify()` into `run.ts` and append `limit_hit` after a limit outcome.
  - Add the three scenarios to `fake-worker.ts`.
- [ ] **Step 4: Run.** `bun test fanout` passes. `bun run typecheck` exits 0.
- [ ] **Step 5: Commit.** Title `feat(fanout): classify outcomes, parse resets`.

### Task 11: Fallback chain

Limits, auth and unavailable-model failures fall back to the next candidate in the same tier, then up, with a fresh workspace each time. The result block reports every hop.

**Files:**

- Modify: `fanout/src/{run,result,pick}.ts`, `fanout/src/adapters/fake.ts` (env `FAKE_MISSING=<harness>` makes that harness's quick preflight fail with `CLI missing`)
- Test: `fanout/tests/fallback.test.ts`

**Interfaces:**

- Produces: `nextCandidate(chain, tried): Candidate | undefined` (re-rank excluding tried `harness/model` keys and the harnesses skipped by preflight); the `FALLBACK` and `FAILED` lines of "Shared contracts".

**Behaviour.**

- After `rate_limited`, `quota_exhausted`, `credits_exhausted`, `auth_error` or `model_unavailable`: start a new attempt on the next candidate (`reason: "fallback"`, `from_job` the previous job, same `root`, `attempt` plus 1, a fresh workspace). Never below the start tier.
- A failed quick `preflight` skips every remaining row of that harness for this chain, prints `NOTE <harness>: <detail>`, and appends one `limit_hit` {scope account, outcome worker_error, source backoff} for the harness.
- Result block: one `FALLBACK <h>/<m> <outcome> (resets HH:MM) -> <h2>/<m2>. Tell the user, then run: fanout ack <finalJob>` line per hop, in order, after the `FANOUT` line (which describes the final attempt). When no candidate is left: `FAILED all candidates exhausted. Tried: <h>/<m> (<outcome>), ...` and exit 1 (Task 13 adds the wait).
- Non-git directory: continue to the next attempt only when `changedFiles()` is empty; otherwise stop with `NOTE attempt <n> changed files outside git; not retrying` and exit 1.

- [ ] **Step 1: Write the failing tests** `fanout/tests/fallback.test.ts` (tests that need only the subscription rows of tier 1 start with a private catalog retiring the two paid rows: `harness,model,status\nfake2,f1-paid,retired\nfake3,f1-paid-b,retired`; `at('2026-11-15T01:00:00Z')`):

```ts
test('rate_limited_reset falls back, states the reset, tells the caller to ack', async () => {
  sb.script({ 'fake/f1-a': ['rate_limited_reset'] })
  const r = await sb.fanout(RUN)
  const l = r.stdout.split('\n')
  expect(r.code).toBe(0)
  expect(l[0]).toMatch(/^FANOUT job=\w{26} harness=fake model=f1-b outcome=ok attempt=2$/)
  expect(l[1]).toMatch(
    /^FALLBACK fake\/f1-a rate_limited \(resets 18:00\) -> fake\/f1-b\. Tell the user, then run: fanout ack \w{26}$/
  )
  const [s1, s2] = sb.ledger().filter((e) => e.event === 'job_start')
  expect(s2).toMatchObject({ attempt: 2, reason: 'fallback', from_job: s1.job, root: s1.root })
})
```

- `tier 1 exhausted climbs to tier 2`. Input: script `f1-a`, `f1-b` and `fake2/f1-c` each `['rate_limited']`. Expect: first line `harness=fake model=f2-a outcome=ok attempt=4`; exactly three `FALLBACK` lines: `fake/f1-a rate_limited -> fake/f1-b`, `fake/f1-b rate_limited -> fake2/f1-c`, `fake2/f1-c rate_limited -> fake/f2-a` (no `resets` text, the cooldowns are backoffs).
- `starting at tier 2 never touches tier 1`. Input: `run --kind edit`, script `fake/f2-a` `['rate_limited']`. Expect: first line `model=f2-b attempt=2`; no `job_start` has `tier: 1`.
- `all candidates exhausted`. Input: `run --tier 3`, script `fake/f3-z` and `fake3/f3-a` each `['quota_exhausted']`. Expect: exit 1; stdout contains `FAILED all candidates exhausted. Tried: fake/f3-z (quota_exhausted), fake3/f3-a (quota_exhausted)`; first line `outcome=quota_exhausted attempt=2`.
- `each attempt gets a fresh worktree` (git). Input: script `fake/f1-a` `['writes_then_limit']`. Expect: the patch does not contain `partial.txt`; `worktrees/` holds two folders ending `-a1` and `-a2`; the `-a1` folder contains `partial.txt`.
- `a non-git directory stops after a dirty attempt`. Input: `RUN` with `--dir` a non-git temp dir, script `fake/f1-a` `['writes_then_limit']`. Expect: exit 1; stdout contains `NOTE attempt 1 changed files outside git; not retrying`; one `job_start`.
- `a non-git directory falls back after a clean attempt`. Input: same dir, script `['rate_limited']`. Expect: two `job_start` events and `outcome=ok attempt=2`.
- `a missing CLI skips its whole harness once`. Input: `FAKE_MISSING=fake`. Expect: stdout contains one line `NOTE fake: CLI missing`; the first `job_start` is `fake2/f1-c`; exactly one `limit_hit` {harness: 'fake', scope: 'account', outcome: 'worker_error', source: 'backoff'}.
- `a detached chain reports its fallback through wait`. Input: script `fake/f1-a` `['rate_limited_reset']`, `run --detach`, then `wait <id>`. Expect: the `wait` stdout has `FALLBACK fake/f1-a rate_limited (resets 18:00) -> fake/f1-b`.

- [ ] **Step 2: Run.** `bun test fanout/tests/fallback.test.ts`. Expected: FAIL (the chain stops after the first attempt).
- [ ] **Step 3: Implement fallback chain.**
  - `run.ts`: the attempt loop, `nextCandidate()`, `from_job`, `root`, a fresh workspace per attempt, the preflight skip and the non-git rule.
  - `result.ts`: `FALLBACK` and `FAILED` lines; `adapters/fake.ts`: `FAKE_MISSING`.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): fall back on limits`.

### Task 12: Cooldowns

A model that hit a limit is skipped until its cooldown ends. The backoff doubles on repeated hits, and a burst of concurrent hits counts once.

**Files:**

- Create: `fanout/src/state.ts`
- Modify: `fanout/src/{run,pick,clock}.ts`
- Test: `fanout/tests/cooldown.test.ts`

**Interfaces:**

- Produces: `readState(nowMs): State` with `cooldowns: Map<key, { until, outcome, scope, source }>` (key `<h>/<m>`; an `account` hit cools the key `<h>/*`) derived in one pass over the last 30 days of events; `isCooling(state, row): { until, outcome } | undefined`.

**Behaviour.**

- A key is skipped while its latest `until` is in the future (an `account` cooldown skips every model of that harness). `pick` and `run` both honour it.
- Backoff: when a limit has no stated reset, `until` is now plus `min(4 h, 15 min x 2^k)`, where `k` counts the `limit_hit` events for that key since its last `job_end` with outcome `ok`, counting at most one per 60 seconds (events less than 60 s after the previous counted one are ignored). A rule's `cooldownS` replaces the backoff. A stated reset always wins.
- After `until` the key is eligible again (Task 13 makes that one trial job).

- [ ] **Step 1: Write the failing tests** `fanout/tests/cooldown.test.ts` (private catalog retiring the paid rows as in Task 11; `limit_hit` events are seeded with `sb.seed()` where stated):
- `backoff doubles across runs`. Input: three runs at `at('2026-11-15T01:00:00Z')`, `01:16:00Z`, `01:47:00Z`, script `fake/f1-a` `['rate_limited', 'rate_limited', 'rate_limited']`. Expect: the three `limit_hit.until` values are `2026-11-15T01:15:00.000Z`, `2026-11-15T01:46:00.000Z`, `2026-11-15T02:47:00.000Z` (15, 30, 60 minutes).
- `the backoff caps at 4 hours`. Input: seed 8 `limit_hit` events for `fake/f1-a` (outcome `rate_limited`, source `backoff`, `until` 15 minutes after each `ts`) two hours apart from `2026-11-14T00:00:00Z`, no `ok` after them; run at `01:00Z` with `['rate_limited']`. Expect: `limit_hit.until` `2026-11-15T05:00:00.000Z`.
- `a burst counts once` (Review focus 4). Input: seed six `limit_hit` events for `fake/f1-a` (each with `until` `01:15:00Z`) at `01:00:00Z`, `01:00:10Z`, `01:00:20Z`, `01:00:30Z`, `01:00:40Z`, `01:00:50Z`; run at `01:16Z` with `['rate_limited']`. Expect: `limit_hit.until` `2026-11-15T01:46:00.000Z` (k is 1, so 30 minutes, not the 4 hour cap).
- `a cooled model is skipped without a fallback line`. Input: run at `01:00Z` with `['rate_limited']`, then run at `01:05Z`. Expect: the second run's first `job_start` is `fake/f1-b`; its stdout has no `FALLBACK` line; no new `limit_hit` event; `pick --all` at `01:05Z` has no `fake/f1-a` line and one at `01:16Z` does.
- `account scope skips the whole harness`. Input: run at `01:00Z` with `['credits_exhausted']`; run at `01:01Z`. Expect: the second run's first `job_start` is `fake2/f1-c`; `pick --all` at `01:01Z` lists no `fake/` row.
- `a success resets the backoff`. Input: run at `01:00Z` with `['rate_limited']`; run at `01:16Z` with `['ok']` on `fake/f1-a`; run at `01:17Z` with `['rate_limited']`. Expect: the last `limit_hit.until` is `2026-11-15T01:32:00.000Z` (15 minutes again).
- `a stated reset overrides the backoff`. Input: seed one `limit_hit` for `fake/f1-a` (expired), run at `01:16Z` with `['rate_limited_reset']`. Expect: `limit_hit` {source: 'stated', until: '2026-11-15T10:00:00.000Z'}.

- [ ] **Step 2: Run.** `bun test fanout/tests/cooldown.test.ts`. Expected: FAIL (the second run still starts `fake/f1-a`).
- [ ] **Step 3: Implement cooldowns.**
  - `state.ts`: `readState()` (one pass; skips corrupt lines and `v > 1`), `isCooling()`.
  - `run.ts`: compute `until` with the backoff, the 60-second dedup and `cooldownS`; `pick.ts`: drop cooling rows.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): cooldowns with backoff and dedup`.

### Task 13: Half-open trial and waiting

After a cooldown ends, exactly one job may try the model. When nothing else is left, a run may wait for a short stated reset.

**Files:**

- Modify: `fanout/src/{run,state,clock,result}.ts`
- Test: `fanout/tests/trial.test.ts`

**Interfaces:**

- Produces: `takeTrial(key): Trial | undefined` (exclusive-create `run/trial-<encodeURIComponent(key)>.lock` holding `{ pid, startTicks }`); a `trial` event {harness, model, job}; `waitForReset(state, candidates): { until } | undefined`.

**Behaviour.**

- A key whose cooldown has ended is half-open: a run needs the trial token to start it; without the token it skips the key. A lock whose owner is dead (Call 9) is taken over. A successful `job_end` clears the cooldown; a failure re-arms it with the doubled backoff; the lock is removed at job end.
- Nothing left to try: take the earliest `until` among otherwise eligible keys whose cooldown `source` is `stated`. When it is under 30 minutes away and this run has not waited yet, print `WAIT <n>s until HH:MM` to stderr, sleep (`FANOUT_NO_SLEEP=1` advances a virtual clock in `clock.ts` instead), rank again, and add `NOTE waited <n>s for <h>/<m> to reset (HH:MM)` to the block. Otherwise exit 1 with the `FAILED` line.

- [ ] **Step 1: Write the failing tests** `fanout/tests/trial.test.ts` (private catalog retiring the paid rows; `limit_hit` events seeded with `sb.seed()` as `{ts, harness: 'fake', model: 'f1-a', scope: 'model', outcome: 'rate_limited', source: 'backoff', until}`):
- `a half-open success clears the cooldown`. Input: seed a hit at `01:00Z` with `until` `01:15Z`; run at `01:16Z` with script `fake/f1-a` `['ok']`. Expect: first line `model=f1-a outcome=ok attempt=1`; a `trial` event for `fake/f1-a`; no `run/trial-*.lock` file left; a later run at `01:17Z` with `['rate_limited']` gets a `limit_hit.until` of `01:32:00.000Z`.
- `a half-open failure re-arms with double the backoff`. Input: seed one hit (`until` `01:15Z`); run at `01:16Z` with `['rate_limited']`. Expect: the new `limit_hit.until` is `2026-11-15T01:46:00.000Z`; the run falls back to `fake/f1-b`; no lock file left.
- `six concurrent runs on an expired cooldown: exactly one takes the trial`. Input: seed a hit with `until` `01:15Z`; `at('2026-11-15T01:20:00Z')`; script `fake/f1-a` `['ok_slow']`, `FAKE_SLEEP_S=1`; `start()` six `RUN`, then wait for all. Expect: all six exit 0; the `job_start` events with `model: 'f1-a'` number exactly one; the other five are `fake/f1-b`.
- `a stale trial lock is taken over`. Input: seed the file `run/trial-fake%2Ff1-a.lock` with `{"pid": <a dead pid>, "startTicks": 1}` and an expired hit. Expect: the run starts `fake/f1-a`.
- `wait under 30 minutes, then the trial succeeds`. Input: private catalog also retiring `fake,f3-z`; `RUN --tier 3`, script `fake3/f3-a` `['rate_limited_soon', 'ok']`, `at('2026-11-15T01:00:00Z')`. Expect: stderr contains `WAIT 600s until 09:10`; first line `harness=fake3 model=f3-a outcome=ok attempt=2`; stdout contains `NOTE waited 600s for fake3/f3-a to reset (09:10)`; the second `job_start` has `ts` `2026-11-15T01:10:00.000Z` and `reason: 'fallback'`.
- `a reset over 30 minutes is not waited for`. Input: same catalog, script `fake3/f3-a` `['quota_exhausted']` (resets in 2 hours). Expect: exit 1; stdout `FAILED all candidates exhausted. Tried: fake3/f3-a (quota_exhausted)`; stderr has no `WAIT`.
- `a backoff cooldown is never waited for`. Input: same catalog, script `['rate_limited']`. Expect: exit 1 with the `FAILED` line; no `WAIT`.
- `a run waits at most once`. Input: same catalog, script `['rate_limited_soon', 'rate_limited_soon']`. Expect: exit 1; stderr has exactly one `WAIT` line.

- [ ] **Step 2: Run.** `bun test fanout/tests/trial.test.ts`. Expected: FAIL (no `trial` event; six runs start `fake/f1-a`).
- [ ] **Step 3: Implement half-open trial and waiting.**
  - `run.ts`: `takeTrial()` with stale-lock takeover, the `trial` event, lock removal; `waitForReset()` and the single wait with the `NOTE`.
  - `clock.ts`: the virtual clock for `FANOUT_NO_SLEEP`; `state.ts`: half-open detection.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): half-open trials and reset waits`.

### Task 14: Retry, timeout and worker-error rules

Anything that is not a limit follows Call 8: unknown errors retry once, worker errors and timeouts have their own paths, and a chain has a cap.

**Files:**

- Modify: `fanout/src/{run,result}.ts`, `fanout/patterns/generic.json` (add `gen-worker`: `context canceled|worker crashed|segmentation fault` as `worker_error`), `fanout/tests/helpers/fake-worker.ts` (scenario `worker_crash`: stderr `worker crashed: context canceled`, exit 1)
- Test: `fanout/tests/retry-rules.test.ts`

**Behaviour.**

| outcome        | same-model retry                                                                         | cooldown                                            | next                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `unknown`      | once (`reason: "retry"`, a `RETRY <h>/<m> unknown; retried once on the same model` line) | after the repeat: `limit_hit` with source `backoff` | fall back                                                                                                         |
| `worker_error` | no                                                                                       | `limit_hit` with source `backoff`                   | fall back                                                                                                         |
| `timeout`      | no                                                                                       | none                                                | fall back; a second timeout in one chain stops it with `NOTE timed out twice; split the chunk or raise --timeout` |

`--timeout <s>` (default 1500) is enforced by the process runner. `--max-attempts <n>` (default 8) caps a chain; when it stops the chain the block ends `FAILED stopped after <n> attempts. Tried: <h>/<m> (<outcome>), ...` and the exit code is 1. A chain stopped by a second timeout ends `FAILED timed out twice. Tried: ...`.

- [ ] **Step 1: Write the failing tests** `fanout/tests/retry-rules.test.ts` (private catalog retiring the paid rows; `at('2026-11-15T01:00:00Z')`):
- `unknown is retried once on the same model`. Input: script `fake/f1-a` `['unknown_error', 'ok']`. Expect: exit 0; first line `model=f1-a outcome=ok attempt=2`; a line `RETRY fake/f1-a unknown; retried once on the same model`; no `FALLBACK` line; no `limit_hit`; the second `job_start` has `reason: 'retry'` and `from_job` of the first.
- `unknown twice backs off and falls back`. Input: script `['unknown_error', 'unknown_error']`. Expect: one `limit_hit` {source: 'backoff', until: '2026-11-15T01:15:00.000Z'}; stdout has `FALLBACK fake/f1-a unknown -> fake/f1-b.`; first line `model=f1-b outcome=ok attempt=3`.
- `worker_error is not retried`. Input: script `['worker_crash']`. Expect: exactly one `job_start` for `fake/f1-a`; one `limit_hit` with source `backoff`; `FALLBACK fake/f1-a worker_error -> fake/f1-b.`.
- `a timeout falls back without a cooldown`. Input: `RUN --timeout 1`, script `['timeout']`, `FAKE_PIDFILE`. Expect: no `limit_hit`; `FALLBACK fake/f1-a timeout -> fake/f1-b.`; the grandchild pid is dead.
- `a second timeout stops the chain`. Input: `RUN --timeout 1`, script `fake/f1-a` and `fake/f1-b` each `['timeout']`. Expect: exit 1; stdout contains `NOTE timed out twice; split the chunk or raise --timeout` and `FAILED timed out twice. Tried: fake/f1-a (timeout), fake/f1-b (timeout)`; two `job_start` events.
- `--max-attempts caps the chain`. Input: `RUN --max-attempts 2`, script `fake/f1-a` and `fake/f1-b` each `['rate_limited']`. Expect: exit 1; `FAILED stopped after 2 attempts. Tried: fake/f1-a (rate_limited), fake/f1-b (rate_limited)`; two `job_start` events.
- `a bad --max-attempts is a usage error`. Input: `--max-attempts 0`. Expect: exit 2, stderr `--max-attempts must be 1 or more`.

- [ ] **Step 2: Run.** `bun test fanout/tests/retry-rules.test.ts`. Expected: FAIL (no `RETRY` line).
- [ ] **Step 3: Implement retry, timeout and worker-error rules.**
  - `run.ts`: the rule table above, the single same-model retry, the second-timeout stop and `--max-attempts`.
  - `result.ts`: the `RETRY`, `NOTE` and `FAILED` lines; add `gen-worker` and the `worker_crash` scenario.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): retry, timeout and cap rules`.

### Task 15: job_error and no_effect

Two failures are not the model's limit and must not cool a model or spend a second paid attempt: a chunk the model cannot take (`job_error`), and a worker that exits clean having done nothing (`no_effect`). The chain stops and reports.

**Files:**

- Modify: `fanout/src/{run,result,classify}.ts`, `fanout/patterns/generic.json` (add `gen-job`: `context.length|context_length_exceeded|prompt is too long|\b413\b|\b422\b|error_max_turns|max.turns` as `job_error`), `fanout/tests/helpers/fake-worker.ts` (scenarios `job_error_ctx`: stderr `context_length_exceeded: prompt is too long`, exit 1; `ok_no_write`: prints `done` and a `USAGE` line, writes nothing, exit 0)
- Test: `fanout/tests/job-errors.test.ts`

**Behaviour** (Call 8).

- `job_error`: no `limit_hit`, no cooldown, no fallback. The block ends `FAILED job_error: <first 120 characters of the matching stderr line>. The chunk is too large or malformed for this model; split it, or run: fanout run --escalate-from <job>`; exit 1. `gen-job` is checked before the limit rules.
- `no_effect`: when the kind's `writes` flag is true, the attempt exited 0 and was classified `ok`, and `ws.changedFiles()` is empty, the outcome becomes `no_effect`. No cooldown, no fallback. The block ends `FAILED no_effect: the worker exited 0 but changed no file. Read LOG=<path>, then re-brief, or run: fanout run --escalate-from <job>`; exit 1. A kind with `writes: false` (`inventory`) stays `ok`. When `changedFiles()` is `unknown` (a capped manifest) the outcome stays `ok`.

- [ ] **Step 1: Write the failing tests** `fanout/tests/job-errors.test.ts`:
- `a context-length error stops the chain`. Input: `RUN`, script `fake/f1-a` `['job_error_ctx']`. Expect: exit 1; first line `outcome=job_error attempt=1`; a line matching `^FAILED job_error: context_length_exceeded`; exactly one `job_start`; no `limit_hit`; `job_end.pattern` `gen-job`.
- `413, 422 and a turn cap are job errors`. Input: scenario `custom_error` with `FAKE_STDERR` `HTTP 413 Payload Too Large`, `HTTP 422 Unprocessable Entity`, `error_max_turns`, one run each. Expect: each `job_end.outcome` is `job_error` and the chain has one `job_start`.
- `job_error does not cool the model`. Input: a `job_error_ctx` run at `01:00Z`, then a run at `01:01Z`. Expect: the second run's first `job_start` is `fake/f1-a`; no `limit_hit` events at all.
- `a clean exit that changed nothing is no_effect`. Input: `RUN`, script `['ok_no_write']`, git repo. Expect: exit 1; first line `outcome=no_effect attempt=1`; stdout line `FAILED no_effect: the worker exited 0 but changed no file. Read LOG=`; one `job_start`; no `limit_hit`.
- `no_effect in a non-git directory`. Input: `RUN` with `--dir` a temp non-git dir, script `['ok_no_write']`. Expect: the same `outcome=no_effect`.
- `a stdout-only kind stays ok`. Input: `run --kind inventory`, script `['ok_no_write']`. Expect: exit 0, `outcome=ok`.
- `a capped manifest stays ok`. Input: non-git dir holding 5001 small files, script `['ok_no_write']`. Expect: exit 0, `outcome=ok` (the change check is `unknown`).
- `a worker that writes a file is ok`. Input: `RUN`, script `['ok']`. Expect: exit 0, `outcome=ok`.

- [ ] **Step 2: Run.** `bun test fanout/tests/job-errors.test.ts`. Expected: FAIL (`job_error` is not a known outcome).
- [ ] **Step 3: Implement job_error and no_effect.**
  - `classify.ts` and `generic.json`: `gen-job` ahead of the limit rules.
  - `run.ts`: stop the chain on `job_error` and `no_effect` without a `limit_hit`; derive `no_effect` from `kindInfo(kind).writes` and `changedFiles()`.
  - `result.ts`: the two `FAILED` lines; add the two scenarios.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): job_error and no_effect outcomes`.

### Task 16: Starting model, pinning, expected model and private refusal

The user approves a specific model in the dispatch question. `run` must start there, say so loudly when it cannot, and never send private data to a `public-only` row.

**Files:**

- Modify: `fanout/src/{run,pick,cli}.ts`, `fanout/src/commands/{run,pick}.ts`, `fanout/src/result.ts`
- Test: `fanout/tests/run-options.test.ts`

**Interfaces:**

- Produces: `resolveModel(spec, harness?): CatalogRow | undefined` (`spec` is `<harness>/<model>` or a bare model id; ambiguity resolves to the top-ranked row); `job_start.expected` (`<harness>/<model>`).

**Behaviour** (Calls 8, 10, 12; `pick` accepts `--model` and `--harness` and shows the same result).

- `--model m [--harness h]` starts on that row. An unknown id exits 2 with `unknown model <m>`. A row that is not routable yet (a `trial` row) may start, with `NOTE model <h>/<m> has no proof of compatibility yet`; fallbacks use routable rows only.
- `--pin` forbids fallback: the single same-model retry for `unknown` still applies; any other failure ends the chain with `FAILED` and exit 1.
- `--expect <harness>/<model>` carries the model the user approved (copied from the `PICK` line). `--model` implies `--expect` of the same row. When the model `run` starts differs from the expected one, the block carries `FALLBACK <expected> not started (<reason>) -> <h>/<m>. Tell the user, then run: fanout ack <job>`, and `job_start` records `expected`. Reasons: `cooling down until HH:MM, <outcome>`, `retired`, `not in the catalog`, `not routable`.
- A private chunk with `--model` or `--pin` naming a `public-only` row exits 3 with `REFUSED <h>/<m> is public-only and this chunk is private` and starts no worker.

- [ ] **Step 1: Write the failing tests** `fanout/tests/run-options.test.ts` (`at('2026-11-15T01:00:00Z')`; private catalog retiring the paid rows where the tier 1 order matters):
- `--model starts on that row`. Input: `RUN --model f1-b`. Expect: first line `harness=fake model=f1-b outcome=ok attempt=1`; no `FALLBACK` line.
- `a limit on the starting model is a reported fallback`. Input: `RUN --model f1-b`, script `fake/f1-b` `['rate_limited']`. Expect: `FALLBACK fake/f1-b rate_limited -> fake2/f1-c.`; first line `model=f1-c attempt=2`.
- `--pin ends the chain on the first limit`. Input: `RUN --pin`, script `fake/f1-a` `['rate_limited']`. Expect: exit 1; stdout `FAILED all candidates exhausted. Tried: fake/f1-a (rate_limited)`; exactly one `job_start`.
- `--pin still retries an unknown error once`. Input: `RUN --pin`, script `['unknown_error', 'ok']`. Expect: exit 0, `attempt=2`, a `RETRY` line.
- `--expect names a cooling model: a pre-start reroute is reported`. Input: seed a `limit_hit` for `fake/f1-a` (`until` `2026-11-15T01:15:00.000Z`, outcome `rate_limited`); `RUN --expect fake/f1-a` at `01:05Z`. Expect: stdout line 2 matches `^FALLBACK fake/f1-a not started \(cooling down until 09:15, rate_limited\) -> fake/f1-b\. Tell the user, then run: fanout ack \w{26}$`; first line `model=f1-b outcome=ok attempt=1`; `job_start.expected` `fake/f1-a`.
- `--expect on an available model prints nothing extra`. Input: `RUN --expect fake/f1-a`. Expect: no `FALLBACK` line; `job_start.expected` `fake/f1-a`.
- `--expect on a retired row`. Input: private csv `harness,model,status\nfake,f1-a,retired`; `RUN --expect fake/f1-a`. Expect: `FALLBACK fake/f1-a not started (retired) -> fake/f1-b.`.
- `--expect on a model that is not in the catalog`. Input: `RUN --expect fake/nope`. Expect: `FALLBACK fake/nope not started (not in the catalog) -> fake/f1-a.`.
- `a private chunk may not be sent to a public-only row by name`. Input: `RUN --model f1-pub`. Expect: exit 3, stdout `REFUSED fake3/f1-pub is public-only and this chunk is private`; the ledger is empty. Input: `RUN --pin --model f1-pub`. Expect: the same refusal.
- `--public lets the public-only row run`. Input: `RUN --public --model f1-pub`. Expect: exit 0, first line `harness=fake3 model=f1-pub`.
- `an unknown model exits 2`. Input: `RUN --model nope`. Expect: exit 2, stderr `unknown model nope`.
- `an unproven explicit model runs with a note, and a fallback skips unproven rows`. Input: `RUN --model f1-trial`, script `fake3/f1-trial` `['rate_limited']`. Expect: stdout has `NOTE model fake3/f1-trial has no proof of compatibility yet`; the fallback target is `fake/f1-a`, never another `trial` row.
- `pick --model shows the start`. Input: `pick --model f2-a`. Expect: first line `PICK harness=fake model=f2-a tier=2`.

- [ ] **Step 2: Run.** `bun test fanout/tests/run-options.test.ts`. Expected: FAIL (`--model` is not a known option).
- [ ] **Step 3: Implement starting model, pinning, expected model and private refusal.**
  - `pick.ts`: `resolveModel()` and the move-first rule; `commands/pick.ts`: `--model`.
  - `run.ts`: `--pin`, `--expect`, the pre-start reroute reason, `job_start.expected`, the private refusal and the trial-row note.
  - `result.ts`: the `FALLBACK ... not started` line.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): model, pin and expect options`.

### Task 17: Escalation and climb lists

A rejected output climbs one rung. A rung is an effort on the same model, a stronger model on the same harness, or the next tier.

**Files:**

- Modify: `fanout/src/{run,pick,cli}.ts`, `fanout/src/commands/run.ts`
- Test: `fanout/tests/escalate.test.ts`

**Interfaces:**

- Produces: `climbSteps(row): { model, effort }[]` (`[<model>@<efforts[0]>] + row.climb`); `nextRung(job, ctx): Candidate | 'top' | undefined`.

**Behaviour** (Call 17).

- `run --escalate-from <job>` looks the job up (any job in the last 30 days; unknown exits 2 `unknown job <id>`), finds the next step after the job's `<model>@<effort>` in the job's row steps and starts there, skipping steps whose row is cooling, retired, not routable or not allowed for the data class. When the steps are spent it starts the best row one tier above the job's tier. At tier 3 with no step left it exits 3 with `REFUSED already at the top tier`.
- The new chain has `reason: "escalate"`, `from_job` the given job, and a new `root`. `--escalate-from` with `--model` or `--pin` exits 2 with `--escalate-from cannot be combined with --model or --pin`.

- [ ] **Step 1: Write the failing tests** `fanout/tests/escalate.test.ts` (private catalog retiring the paid rows; every `escalate` run uses `--kind` of the original run; `J1` is the job id from the first line of the previous run):
- `a tier 1 job escalates to tier 2`. Input: `RUN` (lands on `fake/f1-a`), then `run --escalate-from J1 --brief B --dir <repo> --kind transcribe`. Expect: the second `job_start` has `tier: 2`, `model: 'f2-a'`, `reason: 'escalate'`, `from_job: J1`, and a `root` equal to its own `job` (a new chain).
- `agy-style climb: effort first, then model, then refusal`. Input: `run --kind edit` (lands on `fake/f2-a` at effort `medium`, job `J1`); escalate from `J1`; escalate from the new job `J2`; escalate from `J3`. Expect: the second chain's `job_start` is `fake/f2-a` with `effort: 'high'` and `tier: 2`; the third is `fake/f3-z` with `effort: 'high'` and `tier: 3`; the last command exits 3 with stdout `REFUSED already at the top tier`.
- `a top-tier job without a climb is refused`. Input: `run --tier 3 --harness fake3` (job on `fake3/f3-a`), then escalate from it. Expect: exit 3, `REFUSED already at the top tier`.
- `a cooling climb step is skipped`. Input: after `J2` (the `f2-a` at `high` job) seed a `limit_hit` for `fake/f3-z` with `until` in the future; escalate from `J2`. Expect: the new `job_start` is `fake3/f3-a` at tier 3 with `reason: 'escalate'`.
- `escalate cannot be combined with --model or --pin`. Input: `--escalate-from J1 --model f2-b`; then `--escalate-from J1 --pin`. Expect: exit 2 both times, stderr `--escalate-from cannot be combined with --model or --pin`.
- `an unknown job exits 2`. Input: `--escalate-from 01HZZZZZZZZZZZZZZZZZZZZZZZ`. Expect: exit 2, stderr `unknown job 01HZZZZZZZZZZZZZZZZZZZZZZZ`.
- `the climb step's effort reaches the worker`. Input: `run --dry-run --escalate-from J1` where `J1` is the `f2-a` at `medium` job. Expect: stdout `DRYRUN fake/f2-a effort=high` (Task 18 provides `--dry-run`; run this test after it).

- [ ] **Step 2: Run.** `bun test fanout/tests/escalate.test.ts`. Expected: FAIL (`--escalate-from` is not a known option).
- [ ] **Step 3: Implement escalation and climb lists.**
  - `pick.ts`: `climbSteps()` and `nextRung()` with the skip rules and the tier fallback.
  - `commands/run.ts` and `run.ts`: `--escalate-from`, the new root, `reason: "escalate"`, the refusal and the conflict check.
- [ ] **Step 4: Run.** `bun test fanout` passes. The last test above passes once Task 18 is done; until then skip it with `test.todo` and remove the `todo` in Task 18's Step 4.
- [ ] **Step 5: Commit.** Title `feat(fanout): escalation with climb lists`.

### Task 18: Effort, no-paid, dry-run and passthrough flags

**Files:**

- Modify: `fanout/src/{run,pick,cli}.ts`, `fanout/src/commands/{run,pick}.ts`, `fanout/src/adapters/fake.ts` (argv gains `--max-turns <n>` and one `--allow <x>` per allowance; when `FAKE_SECRET` is set it is added to `secrets` and to argv as `--token <secret>`; `build()` does not consume a scenario while `FANOUT_DRYRUN=1`, which `--dry-run` sets for its own process)
- Test: `fanout/tests/run-flags.test.ts`

**Behaviour** (reasons in "Calls this plan makes", item 24).

- `--effort e` must be in the row's `efforts` (else exit 2 naming the list); the default is `efforts[0]`; a row with an empty list passes no effort and rejects `--effort`.
- `--no-paid` drops `paid` and `per_call` rows from `run` and `pick`.
- `--max-turns n` (default the adapter's default, else 8), `--allow <pattern>` (repeatable) and `--bypass` pass through to `BuildInput`; `--bypass` is honoured only in git mode.
- `--dry-run` ranks, builds the first candidate's command, prints `DRYRUN <h>/<m> effort=<e> cwd=<path> argv=<json array>` with every secret replaced by `[secret]`, writes no events, starts no process and exits 0.

- [ ] **Step 1: Write the failing tests** `fanout/tests/run-flags.test.ts`:
- `--effort outside the list exits 2`. Input: `RUN --effort high` (`fake/f1-a` has `medium|low`). Expect: exit 2, stderr `effort high is not one of medium|low for fake/f1-a`.
- `--effort inside the list is used`. Input: `RUN --effort low`. Expect: exit 0; `job_start.effort` `low`.
- `a row without efforts takes none`. Input: `run --dry-run --tier 3 --harness fake3 --brief B --dir <repo> --kind transcribe`. Expect: stdout starts `DRYRUN fake3/f3-a effort= `. Input: same with `--effort high`. Expect: exit 2, stderr `fake3/f3-a takes no effort option`.
- `--no-paid hides paid and per-call rows`. Input: `pick --all --no-paid` with a 7000-byte brief. Expect: no `fake2/f1-paid`, `fake3/f1-paid-b` or `fake3/f1-call` line. Input: `RUN --no-paid` with script `fake/f1-a`, `fake/f1-b` and `fake2/f1-c` each `['rate_limited']`. Expect: first line `model=f2-a`.
- `--bypass outside git exits 2`. Input: `RUN --bypass` with `--dir` a non-git temp dir. Expect: exit 2, stderr `--bypass needs a git repository`.
- `--dry-run prints the command and starts nothing`. Input: `run --dry-run ...` with `FAKE_SECRET=<24 random characters>` and `FAKE_PIDFILE=<tmp>/pid`. Expect: exit 0; one line starting `DRYRUN fake/f1-a effort=medium cwd=`; the line contains `[secret]` and not the secret; the ledger is empty; no pidfile exists.
- `passthrough flags reach the argv`. Input: `run --dry-run --max-turns 12 --allow 'Bash(git status)' --allow Edit ...`. Expect: the `argv=` array contains `"--max-turns","12","--allow","Bash(git status)","--allow","Edit"`. Input: no flags. Expect: `"--max-turns","8"`.

- [ ] **Step 2: Run.** `bun test fanout/tests/run-flags.test.ts`. Expected: FAIL (`--effort` is not a known option).
- [ ] **Step 3: Implement effort, no-paid, dry-run and passthrough flags.**
  - `run.ts` and `pick.ts`: the effort check, `--no-paid`, `--max-turns`, `--allow`, `--bypass` into `BuildInput`.
  - `commands/run.ts`: the `--dry-run` path with secret redaction; `adapters/fake.ts`: the argv additions.
- [ ] **Step 4: Run.** `bun test fanout` passes; turn Task 17's `test.todo` back into a test and run it.
- [ ] **Step 5: Commit.** Title `feat(fanout): effort, no-paid and dry-run flags`.

### Task 19: Cost lines

Paid and per-call jobs get an estimate before and an actual after, in the block and in the ledger. The estimate is never shown as the actual, and the cost is always computed from the catalog.

**Files:**

- Modify: `fanout/src/{cost,run,result}.ts`, `fanout/src/adapters/fake.ts` (`measure()`: `FAKE_CALLS=<n>` returns `{calls: n}` unless `overlapped`, else `'unmeasured'`; `proxyBacked` true for the harnesses listed in `FAKE_PROXY_BACKED`), `fanout/tests/helpers/fake-worker.ts` (scenarios `ok_no_usage`: like `ok` without the `USAGE` line; `usage_then_sleep`: prints the `USAGE` line at once, then sleeps `FAKE_SLEEP_S` seconds)
- Test: `fanout/tests/cost.test.ts`

**Behaviour.**

- Estimate: `paid` is the Task 5 prior estimate; `per_call` is `--max-turns` (default 8) times `price_call` MC. Before every paid or per-call attempt `run` writes `ESTIMATE paid API (<h>/<m>): $0.14` or `ESTIMATE per-call (<h>/<m>): 16 MC (8 turns x 2 MC, upper-bound guess)` to stderr while the worker is still to start. A failure inside cost code prints `NOTE cost estimate failed` and the run continues.
- Actual: `paid` is `usage()` tokens times catalog prices (`computed`), else `unknown` (printed `actual unknown`, never the estimate). `per_call` is `adapter.measure()` calls times `price_call` MC, else `actual unmeasured`. A per-call attempt counts as overlapped when another job on a `proxyBacked` harness had a lease or a job window that intersects it.
- Ledger: `job_start` carries `cost_est_usd`, or `cost_est_mc` and `calls_est`; `job_end` carries `cost_usd`, or `cost_mc` and `calls`, and `cost_source` (`computed` or `unknown`). Nothing else is a valid `cost_source`.
- Block: one `COST` line per paid or per-call attempt in the chain (formats in "Shared contracts"), ending `Tell the user, then run: fanout ack <finalJob>`. The basis text is `computed from tokens` at a normal end and `computed from the worker log` when the chain was interrupted (the trap path in Task 7 now also prints the block). A fallback onto a paid model produces both a `FALLBACK` and a `COST` line.

- [ ] **Step 1: Write the failing tests** `fanout/tests/cost.test.ts` (private catalog `harness,model,status\nfake,*,retired\nfake2,f1-c,retired\nfake3,f1-paid-b,retired` for the paid tests, so the pick is `fake2/f1-paid`, prices 1.00 / 0.10 / 2.00):

```ts
test('paid job: ESTIMATE on stderr while the worker runs; COST has estimate and actual', async () => {
  const p = sb.start(RUN) // script fake2/f1-paid: ['ok_slow'], FAKE_SLEEP_S=2
  await waitFor(() => p.stderrSoFar().includes('ESTIMATE paid API (fake2/f1-paid): $0.14'), 5000)
  expect(readdirSync(join(sb.home, 'run')).some((f) => f.endsWith('.lease'))).toBe(true)
  const r = await p.done()
  expect(r.stdout).toMatch(
    /^COST paid API \(fake2\/f1-paid\): estimated \$0\.14, actual \$0\.0014 \(computed from tokens\)\. Tell the user, then run: fanout ack \w{26}$/m
  )
})
```

- `no usage: actual unknown`. Input: script `['ok_no_usage']`. Expect: the `COST` line is `estimated $0.14, actual unknown`; `job_end.cost_source` `unknown`; the actual never equals the estimate.
- `subscription and free jobs print no COST line`. Input: `RUN` on `fake/f1-a` (default catalog). Expect: no `COST` line; no `ESTIMATE` on stderr.
- `a fallback onto a paid row prints FALLBACK and COST`. Input: default fake catalog, script `fake/f1-a`, `fake/f1-b` and `fake2/f1-c` each `['rate_limited']`. Expect: first line `harness=fake3 model=f1-paid-b outcome=ok attempt=4`; three `FALLBACK` lines; `COST paid API (fake3/f1-paid-b): estimated $0.07, actual $0.0007 (computed from tokens)`.
- `per-call counted from the proxy log`. Input: private catalog retiring `fake,*`, `fake2,*`, `fake3,f1-paid-b`; a 7000-byte brief; `FAKE_PROXY_BACKED=fake3`; `FAKE_CALLS=6`. Expect: stderr `ESTIMATE per-call (fake3/f1-call): 16 MC (8 turns x 2 MC, upper-bound guess)`; stdout `COST per-call (fake3/f1-call): estimated 16 MC (8 turns x 2 MC, upper-bound guess), actual 6 calls = 12 MC (counted from proxy log). Tell the user, then run: fanout ack ...`. Input: no `FAKE_CALLS`. Expect: `actual unmeasured`.
- `two overlapping per-call runs are both unmeasured`. Input: the same catalog and env, `start()` two runs with scenario `ok_slow` and `FAKE_SLEEP_S=2`. Expect: both blocks say `actual unmeasured`.
- `the ledger carries the numbers`. Input: a paid run and a per-call run. Expect: paid `job_start.cost_est_usd` 0.14, `job_end.cost_usd` 0.0014, `cost_source` `computed`; per-call `job_start` {cost_est_mc: 16, calls_est: 8}, `job_end` {cost_mc: 12, calls: 6}; no event anywhere has `cost_source` `reported`.
- `an interrupted paid job still prints a COST line`. Input: `start(RUN)` on the paid pick with scenario `usage_then_sleep`, `FAKE_SLEEP_S=30`; wait for the lease; `SIGTERM` the process. Expect: exit 143; stdout has `COST paid API (fake2/f1-paid): estimated $0.14, actual $0.0014 (computed from the worker log). Tell the user, then run: fanout ack`.

- [ ] **Step 2: Run.** `bun test fanout/tests/cost.test.ts`. Expected: FAIL (no `ESTIMATE` line on stderr).
- [ ] **Step 3: Implement cost lines.**
  - `cost.ts`: `actualCost()` from tokens or `measure()`, the overlap test, the formats.
  - `run.ts`: the pre-attempt estimate line, the ledger fields, the `NOTE cost estimate failed` guard, the interrupted-path block.
  - `result.ts`: the `COST` lines; `adapters/fake.ts` and `fake-worker.ts`: the additions above.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): cost estimate and actual lines`.

### Task 20: Fail open and scrubbing

A ledger, catalog or directory problem never stops a worker, and nothing sensitive reaches the ledger.

**Files:**

- Modify: `fanout/src/{run,paths,events,catalog,scrub}.ts`
- Test: `fanout/tests/failopen.test.ts`

**Behaviour.**

- If the data directory cannot be created or written, `paths.ts` falls back to `$TMPDIR/fanout-<uid>/` for logs, leases, worktrees and patches, `appendEvent` becomes a no-op, and `WARN ledger unwritable; events not recorded` is printed once; the worker still runs.
- A catalog row that fails validation is skipped with a warning (Task 3). A private catalog that exists but cannot be read or has no `harness` and `model` columns exits 3 with `REFUSED cannot read ~/.config/agent-ops/catalog.csv` (refusing is safer than routing without the user's retirements).
- `stderr_tail` is scrubbed with the command's secrets and the brief (a line sharing a 24-character window with the brief becomes `[brief echo removed]`; `Bearer …`, `sk-…`, `AIza…` and `key=value` shapes become `[secret]`; the last 400 characters are kept) and omitted when the outcome is `ok`.
- Events with `v > 1` are skipped on read; unknown fields are kept; the month boundary inside the 30-day window is read.

- [ ] **Step 1: Write the failing tests** `fanout/tests/failopen.test.ts`:
- `echoed brief and key never reach the ledger`. Input: `RUN` with scenario `echo_brief`, `FAKE_SECRET='sk-' + 'q'.repeat(24)`. Expect: no file under `events/` contains the brief sentence or the secret; the `job_end.stderr_tail` contains `[brief echo removed]` and `key=[secret]`.
- `bearer tokens and key shapes are masked`. Input: scenario `custom_error` with `FAKE_STDERR` built at runtime as `'HTTP 429 Authorization: Bearer ' + 'a'.repeat(20) + ' AIza' + 'x'.repeat(35)`. Expect: `job_end.stderr_tail` contains neither the token nor the `AIza` string; it contains `[secret]`.
- `stderr_tail exists only for failures`. Input: an `ok` run, then a `rate_limited` run. Expect: the `ok` `job_end` has no `stderr_tail`; the other has one.
- `an unwritable data directory still runs the worker`. Input: `FANOUT_HOME=/proc/fanout-nope`, `RUN`. Expect: exit 0; stderr contains `WARN ledger unwritable; events not recorded` exactly once; the first line is `FANOUT job=... outcome=ok`; the logs and leases are under `$TMPDIR/fanout-<uid>/`.
- `a corrupt ledger line does not stop the run`. Input: append `{not json` to the month file, then `RUN`. Expect: exit 0; the new `job_start` and `job_end` are valid lines.
- `a month boundary inside the window is read`. Input: run at `2026-10-31T23:00:00Z` with script `fake/f1-a` `['rate_limited_reset']` (reset `2026-11-01T10:00:00.000Z`), then a run at `2026-11-01T00:10:00Z`. Expect: the second run's first `job_start` is `fake/f1-b` (the cooldown stored in the October file is honoured).
- `events with v 2 are ignored`. Input: seed `{"v":2,"ts":"2026-11-15T00:30:00.000Z","event":"limit_hit","harness":"fake","model":"f1-a","scope":"model","until":"2026-11-15T05:00:00.000Z"}`; `RUN` at `01:00Z`. Expect: the first `job_start` is `fake/f1-a`.
- `unknown fields are kept`. Input: seed a v1 `job_end` with an extra field `zzz: 1`, then `RUN`. Expect: exit 0.
- `an unreadable private catalog is refused`. Input: make `$HOME/.config/agent-ops/catalog.csv` a directory; `RUN`. Expect: exit 3, stdout `REFUSED cannot read ~/.config/agent-ops/catalog.csv`; the ledger is empty.
- `a private catalog without the key columns is refused`. Input: private csv `tier,status\n1,active`. Expect: exit 3 with the same text.

- [ ] **Step 2: Run.** `bun test fanout/tests/failopen.test.ts`. Expected: FAIL (the secret appears in `stderr_tail`).
- [ ] **Step 3: Implement fail open and scrubbing.**
  - `scrub.ts`: the masking rules and the brief-echo rule; `run.ts`: store `stderr_tail` only for failures.
  - `paths.ts` and `events.ts`: the temp fallback, the one-time `WARN`, the `v > 1` skip.
  - `catalog.ts`: the private-file refusal.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): fail open, scrub ledger text`.

### Task 21: Status

`status` is the layer that always works, hooks or not. It shows live state and only counts a chain as unreported once it has finished.

**Files:**

- Create: `fanout/src/status.ts`, `fanout/src/commands/status.ts`
- Modify: `fanout/src/{state,cli}.ts`
- Test: `fanout/tests/status.test.ts`

**Interfaces:**

- Produces: `chains(state): Chain[]` with `{ root, finalJob, finished, running, hops, paidJobs, rerouted, reported, caller }`; `unreportedSummary(chain): string`.

**Behaviour** (Call 9).

- `status [--brief]` prints, in this order: `COOLDOWN <h>/<m> until HH:MM (<outcome>)` per cooling key (an account cooldown prints `<h>/*`); `RUNNING <job> <h>/<m> since HH:MM` per live lease; `UNREPORTED <finalJob> <summary> (run: fanout ack <finalJob>)` per finished chain that had a fallback attempt, a pre-start reroute, or a paid or per-call attempt, and has no `reported` event for its root. Jobs whose caller is `upkeep` are never `UNREPORTED`. With nothing to print it prints exactly `fanout: ok`.
- A chain is **finished** when no live lease exists for its root and its last `job_start` has a `job_end`. A chain still running is listed as `RUNNING` and is never `UNREPORTED`.
- Summaries: `fallback <h>/<m> -> <h2>/<m2>` per hop joined with `; `, `reroute <expected> -> <h>/<m>`, and `paid <h>/<m>: estimated $0.14, actual $0.0014` or `per-call <h>/<m>: estimated 16 MC, actual unmeasured`, in that order.
- Without `--brief` it also prints one line per catalog row: `<h>/<m> tier=<t> <effective status> <billing> <class>`.
- Later tasks add lines from `status.json` (NEW, GONE, SMOKE, BENCH, UPKEEP).

- [ ] **Step 1: Write the failing tests** `fanout/tests/status.test.ts` (private catalog retiring the paid rows unless stated; `at('2026-11-15T01:00:00Z')`, status read at `01:05Z`):
- `an empty ledger prints exactly fanout: ok`. Input: `status --brief`. Expect: stdout `fanout: ok`, exit 0.
- `a clean subscription job leaves nothing to report`. Input: `RUN` (ok on `fake/f1-a`), then `status --brief`. Expect: `fanout: ok`.
- `a fallback shows a cooldown and an unreported hop`. Input: `RUN` with script `fake/f1-a` `['rate_limited_reset']`, then `status --brief`. Expect: the lines `COOLDOWN fake/f1-a until 18:00 (rate_limited)` and `UNREPORTED <job> fallback fake/f1-a -> fake/f1-b (run: fanout ack <job>)`, where `<job>` is the job id on the `FANOUT` line of the run.
- `a paid job is unreported with its cost`. Input: private csv `harness,model,status\nfake,*,retired\nfake2,f1-c,retired\nfake3,f1-paid-b,retired`, `RUN`, `status --brief`. Expect: `UNREPORTED <job> paid fake2/f1-paid: estimated $0.14, actual $0.0014 (run: fanout ack <job>)`.
- `a pre-start reroute is unreported`. Input: seed a `limit_hit` for `fake/f1-a` (`until` `01:15Z`), `RUN --expect fake/f1-a` at `01:05Z`, `status --brief`. Expect: `UNREPORTED <job> reroute fake/f1-a -> fake/f1-b (run: fanout ack <job>)`.
- `a chain still running is RUNNING, not unreported` (Review focus 3). Input: `start(RUN)` with script `fake/f1-a` `['rate_limited']`, `fake/f1-b` `['ok_slow']`, `FAKE_SLEEP_S=4`; wait until the ledger has two `job_start` events; `status --brief`. Expect: a line `RUNNING <first job id> fake/f1-b since 09:00`; no `UNREPORTED` line. After `done()`: `status --brief` contains `UNREPORTED`.
- `upkeep jobs are never unreported`. Input: `RUN` with `FANOUT_CALLER=upkeep` and a fallback. Expect: `status --brief` has a `COOLDOWN` line and no `UNREPORTED` line.
- `status without --brief lists the catalog`. Input: `status`. Expect: lines `fake/f1-a tier=1 active subscription any` and `fake3/f1-pub tier=1 active free public-only` and `fake3/f1-trial tier=1 trial free any`.

- [ ] **Step 2: Run.** `bun test fanout/tests/status.test.ts`. Expected: FAIL, "unknown command status".
- [ ] **Step 3: Implement status.**
  - `state.ts`: group events into chains by `root`; compute `finished` from the leases and the last `job_start`.
  - `status.ts`: the summaries and the line order; `commands/status.ts`: `--brief`; register in `cli.ts`.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): status with finished-chain reports`.

### Task 22: Ack, verdict and the cost history

`ack` tells the ledger the user was told. `verdict` records whether the output passed review and feeds the cost history and, later, the user's own results.

**Files:**

- Create: `fanout/src/commands/{ack,verdict}.ts`
- Modify: `fanout/src/{cost,state,cli}.ts`
- Test: `fanout/tests/ack-verdict.test.ts`

**Interfaces:**

- Produces: `reported` {job, root} and `verdict` {job, accepted, note} events; `judged` lines in `learned/state.jsonl`; `estimate()` now returns `basis: 'history'` with `samples` when 5 or more accepted jobs of the same kind and `family` exist.

**Behaviour** (Call 5, Call 9, Call 11).

- `ack <job>`: refused with exit 3 `REFUSED chain <root> is still running; wait with: fanout wait <job>` while a lease for the chain is alive (Review focus 3). Otherwise append `reported` {job, root} and print `ACKED <root>`; a second ack prints `ALREADY <root>`; an unknown job exits 2 with `unknown job <id>`; an unwritable ledger warns and exits 0.
- `verdict <job> accepted|rejected [--note <text>]`: append `verdict` {job, accepted, note (scrubbed, at most 200 characters)} and a `judged` line {kind `judged`, key `<h>/<m>`, job, `task_kind`, accepted, `cost_usd`} to `learned/state.jsonl`; print `VERDICT <job> accepted`. An unknown job or any other word exits 2.
- History: the median `(in, cached, out)` of `job_end` `ok` jobs that have an accepted verdict, same `kind` and `family`, when there are at least 5.

- [ ] **Step 1: Write the failing tests** `fanout/tests/ack-verdict.test.ts`:
- `ack is refused while the chain runs`. Input: `start(RUN)` with script `fake/f1-a` `['ok_slow']`, `FAKE_SLEEP_S=4`; wait for the lease; `ack <first job id>`. Expect: exit 3, stdout `REFUSED chain <root> is still running; wait with: fanout wait <root>`; no `reported` event.
- `ack after the chain ends clears the whole chain`. Input: `RUN` with a fallback (script `fake/f1-a` `['rate_limited']`); `ack <the first attempt's job id>`; `status --brief`. Expect: ack exit 0, stdout `ACKED <root>`; one `reported` event {job, root}; status has no `UNREPORTED` line.
- `a second ack is harmless`. Input: ack twice. Expect: second stdout `ALREADY <root>`, exit 0, still one `reported` event.
- `ack of an unknown job exits 2`. Input: `ack 01HZZZZZZZZZZZZZZZZZZZZZZZ`. Expect: exit 2, stderr `unknown job 01HZZZZZZZZZZZZZZZZZZZZZZZ`.
- `ack with an unwritable ledger warns and exits 0`. Input: after a run, `chmod 500` the `events/` directory (skip the test when running as root); `ack <job>`. Expect: exit 0, stderr contains `WARN ledger unwritable; events not recorded`.
- `verdict writes the event and the learned line`. Input: `RUN`; `verdict <job> accepted --note ok`. Expect: stdout `VERDICT <job> accepted`; a `verdict` event {job, accepted: true, note: 'ok'}; `learned('state.jsonl')` last line `{kind: 'judged', key: 'fake/f1-a', job, task_kind: 'transcribe', accepted: true, cost_usd: 0}`.
- `the note is scrubbed and cut`. Input: `--note` of a key `'sk-' + 'q'.repeat(24)` followed by 300 `x`. Expect: the stored note is at most 200 characters and does not contain the key.
- `bad verdict input exits 2`. Input: `verdict <job> maybe`; `verdict nope accepted`. Expect: exit 2 with stderr `verdict must be accepted or rejected`; exit 2 with `unknown job nope`.
- `the history replaces the prior at 5 accepted jobs`. Input: private catalog forcing the paid pick (`fake,*`, `fake2,f1-c`, `fake3,f1-paid-b` retired); five `RUN` of `transcribe`, each followed by `verdict <job> accepted`; `pick`. Expect: `PAID fake2/f1-paid ESTIMATE $0.0014 (history; 5 samples)`. With only four accepted jobs, or with the fifth `rejected`: `ESTIMATE $0.14 (prior; fewer than 5 samples)`.
- `six processes append 1,200 verdicts without a corrupt line`. Input: one `RUN`; then six `bash -c 'for i in $(seq 200); do bun fanout/src/cli.ts verdict <job> accepted --note n$i; done'` processes at once (the test timeout is 120 s). Expect: the month file has 1,200 more lines than before, every line parses, and the 1,200 new `id` values are distinct.

- [ ] **Step 2: Run.** `bun test fanout/tests/ack-verdict.test.ts`. Expected: FAIL, "unknown command ack".
- [ ] **Step 3: Implement ack, verdict and the cost history.**
  - `commands/ack.ts`: the lease check, `reported`, the idempotence message.
  - `commands/verdict.ts`: the event, the scrubbed note, the `judged` line.
  - `cost.ts`: the history median; register both commands in `cli.ts`.
- [ ] **Step 4: Run.** `bun test fanout` passes. `bun run typecheck` exits 0.
- [ ] **Step 5: Commit.** Title `feat(fanout): ack, verdict and cost history`.

### Task 23: The reaper

A killed `run` leaves a lease and possibly a live worker. The reaper cleans up, and gives the orphan a `COST` line, so a paid job is never silent.

**Files:**

- Create: `fanout/src/reaper.ts`
- Modify: `fanout/src/{lease,status,run,pick,result}.ts`, `fanout/src/commands/{wait,ack}.ts`, `fanout/tests/helpers/fake-worker.ts` (the `usage_then_sleep` worker also writes its pid to `$FAKE_PIDFILE`)
- Test: `fanout/tests/reaper.test.ts`

**Interfaces:**

- Produces: `reapStaleLeases(): ReapedChain[]` (called first by `status`, `pick`, `run`, `wait` and `ack`); `renderBlock(root): string` (the whole result block rebuilt from the ledger and the worker log; `run` uses it too, so the live block and the rebuilt block cannot differ).

**Behaviour** (Calls 8, 9).

- A lease is stale when its `pid` is dead, or alive with a different `startTicks`. The reaper kills the worker group (`SIGTERM`, then `SIGKILL` after 2 s) only when `/proc/<pgid>/stat` start ticks equal the lease's `workerTicks` (a reused pid is never signalled). It then appends one `job_end` for the chain's open job {harness, model, outcome `worker_error`, detail `orphaned lease`, tokens from `adapter.usage()` over the worker log, `cost_usd` or `cost_mc`, `cost_source`}, rewrites `logs/<root>.block` from `renderBlock()`, and removes the lease. It is idempotent: with no lease there is nothing to do.
- `status` summaries of an orphaned paid chain read `... actual $0.0014 (run: fanout ack <job>)` as usual; `renderBlock()` ends the `COST` line with `(computed from the worker log)` for a reaped or interrupted chain.
- `wait` on a chain with no block file calls `renderBlock()`: this replaces Task 8's `NOTE no result block`.

- [ ] **Step 1: Write the failing tests** `fanout/tests/reaper.test.ts` (private catalog forcing the paid pick `fake2/f1-paid`; script `['usage_then_sleep']`, `FAKE_SLEEP_S=30`, `FAKE_PIDFILE=<tmp>/pid`; the file skips when `/proc` is unavailable):
- `a killed run is reaped, its worker killed and its cost computed`. Input: `start(RUN)`; wait for the lease; `process.kill(p.pid, 'SIGKILL')`; the worker is still alive (`process.kill(workerPid, 0)` does not throw); `status --brief`. Expect: exactly one `job_end` {outcome: 'worker_error', detail: 'orphaned lease', tokens_in: 1000, tokens_out: 200, cost_usd: 0.0014, cost_source: 'computed'}; the worker pid is dead; no `.lease` file; stdout contains `UNREPORTED <job> paid fake2/f1-paid: estimated $0.14, actual $0.0014 (run: fanout ack <job>)`.
- `reaping is idempotent`. Input: `status --brief` twice after the kill. Expect: still exactly one orphan `job_end`.
- `pick and run reap too`. Input: kill a run as above, then `pick` (not `status`). Expect: one orphan `job_end` appears.
- `a live lease with an old heartbeat is not reaped`. Input: spawn `sleep 30`; write `run/X.lease` with its real pid and `startTicks`, `workerTicks`, and a `heartbeat` one hour old. Expect: after `status --brief` the lease file still exists and no `job_end` was appended.
- `a reused pid is never signalled`. Input: spawn `sleep 30`; write a lease with that pid and `pgid` but `startTicks: 1` and `workerTicks: 1`. Expect: after `status --brief` the lease is gone and `process.kill(sleepPid, 0)` still does not throw.
- `wait rebuilds the block of an orphan`. Input: after the reap, `wait <job>`. Expect: exit 1; stdout starts `FANOUT job=<job> harness=fake2 model=f1-paid outcome=worker_error attempt=1` and contains `COST paid API (fake2/f1-paid): estimated $0.14, actual $0.0014 (computed from the worker log). Tell the user, then run: fanout ack <job>`.
- Task 8's test `a block that is missing` is replaced by: delete `logs/<id>.block` after a clean chain; `wait <id>`; expect the same `FANOUT job=<id> ... outcome=ok attempt=1` line as before the deletion.

- [ ] **Step 2: Run.** `bun test fanout/tests/reaper.test.ts`. Expected: FAIL (no orphan `job_end`).
- [ ] **Step 3: Implement the reaper.**
  - `reaper.ts`: `reapStaleLeases()` with the staleness test, the guarded group kill, the orphan `job_end` and the block rewrite.
  - `result.ts`: `renderBlock(root)` and the worker-log basis; `run.ts` prints through it.
  - Call the reaper from `status`, `pick`, `run`, `wait`, `ack`; update Task 8's test as stated.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): reap stale leases with cost`.

### Task 24: Desktop notification

A fallback or a paid job is also pushed to the desktop, so the user hears about it even if the agent does not say it. The notifier is best effort.

**Files:**

- Create: `fanout/src/notify.ts`
- Modify: `fanout/src/{run,reaper}.ts`
- Test: `fanout/tests/notify.test.ts`

**Interfaces:**

- Produces: `notifyBlock(block: string): Promise<void>` (never throws; at most one call per `FALLBACK` or `COST` line; waits at most 3 seconds per call).

**Behaviour** (Call 20).

- Called once when a chain becomes final: by `run` after it prints the block, and by the reaper after it closes an orphan. `wait` never notifies, and a block that is printed again is not notified again.
- Each `FALLBACK` or `COST` line becomes one notification: title `fanout: fallback`, `fanout: paid job` or `fanout: per-call job`; body is the line without its keyword and without the ` Tell the user, then run: fanout ack <job>.` tail.
- Notifier order: `FANOUT_NOTIFY_CMD` (an executable called as `<cmd> <title> <body>`), else `notify-send <title> <body>` when it is on `PATH`, else `powershell.exe -NoProfile -NonInteractive` with a toast script that reads the title and body from environment variables forwarded with `WSLENV` (never from the command line, so the text cannot inject commands). No notifier is silent. A non-zero exit or a hang past 3 s (the process is killed) writes `notify failed: <reason>` to `errors.log` and changes nothing else.

- [ ] **Step 1: Write the failing tests** `fanout/tests/notify.test.ts` (`FANOUT_NOTIFY_CMD` is a stub from `sb.bin()` that appends `"$1|$2"` to `$STUB_OUT`; private catalog retiring the paid rows unless stated):
- `a fallback is notified once`. Input: `RUN` with script `fake/f1-a` `['rate_limited_reset']`. Expect: `$STUB_OUT` has exactly one line: `fanout: fallback|fake/f1-a rate_limited (resets 18:00) -> fake/f1-b`.
- `a paid job is notified with its cost`. Input: `RUN` on the paid pick `fake2/f1-paid`. Expect: one line `fanout: paid job|paid API (fake2/f1-paid): estimated $0.14, actual $0.0014 (computed from tokens)`.
- `a fallback onto a paid model sends two notifications in order`. Input: default fake catalog, `fake/f1-a`, `fake/f1-b` and `fake2/f1-c` each `['rate_limited']`. Expect: three `fanout: fallback|...` lines then one `fanout: paid job|paid API (fake3/f1-paid-b)...` line.
- `a clean subscription run sends nothing`. Input: `RUN`. Expect: `$STUB_OUT` does not exist.
- `a failing notifier changes nothing`. Input: a stub that exits 1; a fallback run. Expect: exit 0; stdout identical to the same run with a working stub; `errors.log` contains `notify failed`.
- `a hanging notifier is cut off`. Input: a stub that runs `sleep 30`. Expect: the run finishes in under 6 s; the `sleep` process is gone.
- `no notifier at all is silent`. Input: `PATH` = `sb.pathWithout(['notify-send', 'powershell.exe'])`, `FANOUT_NOTIFY_CMD` unset. Expect: exit 0, no extra output.
- `an orphan is notified once, and wait never notifies`. Input: kill a paid run with `SIGKILL` (as in Task 23), `status --brief` twice, `wait <job>` twice. Expect: `$STUB_OUT` has exactly one line `fanout: paid job|paid API (fake2/f1-paid): estimated $0.14, actual $0.0014 (computed from the worker log)`.
- `the powershell path passes text through the environment`. Input: a stub `powershell.exe` (from `sb.bin()`) that writes `$FANOUT_TOAST_TITLE`, `$FANOUT_TOAST_BODY` and `$WSLENV` to `$STUB_OUT`, `PATH` = the stub directory plus `sb.pathWithout(['notify-send', 'powershell.exe'])`, no `FANOUT_NOTIFY_CMD`; a fallback run. Expect: the title and body appear in the file and `WSLENV` contains `FANOUT_TOAST_TITLE` and `FANOUT_TOAST_BODY`; the stub's argv contains neither.

- [ ] **Step 2: Run.** `bun test fanout/tests/notify.test.ts`. Expected: FAIL (`$STUB_OUT` was never written).
- [ ] **Step 3: Implement desktop notification.**
  - `notify.ts`: `notifyBlock()` with the notifier order, the 3 s cut-off and the `errors.log` line.
  - `run.ts` and `reaper.ts`: call it once per final chain.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): desktop notification of fallbacks`.

### Task 25: Stop and SessionStart hooks

Two of the three layers that make the user hear about fallbacks and paid jobs. The third is `status --brief` (Task 21). The Stop hook looks only at finished chains.

**Files:**

- Create: `fanout/src/commands/hook.ts`, `fanout/bin/fanout-stop-hook`, `fanout/bin/fanout-session-hook`
- Modify: `fanout/src/cli.ts` (register the internal `hook` command)
- Test: `fanout/tests/hooks.test.ts`

Official docs: https://code.claude.com/docs/en/hooks. The page confirms the top-level `decision: "block"` with `reason` for Stop and `hookSpecificOutput.hookEventName` with `additionalContext` for SessionStart, with JSON parsed only when it is the sole content of stdout at exit 0. Before coding, read the Stop section for the `stop_hook_active` field name; if it differs, the page wins: adjust the tests and Call 19. House conventions: `~/.agents/docs/06-hooks.md`.

**Behaviour** (Call 19).

- Both wrappers begin with `[ -n "$CLAUDE_PROJECT_DIR" ] || exit 0` (the empty-context guard; **no `$HOME` guard**, because the hook is keyed to the session), then resolve their directory like the shim and run `bun <dir>/fanout.js hook <stop|session-start>` when `fanout.js` sits beside them, else `bun <dir>/../src/cli.ts hook ...`. Any exception inside `hook` exits 0 silently (fail open).
- `hook stop`: read the JSON on stdin. `stop_hook_active` true: no output, exit 0. Otherwise take the **finished** unreported chains of `session_id` from the last 3 days (the `status` rule; `upkeep` callers excluded; running chains ignored). None: no output. Some: print `{"decision":"block","reason":"Fanout: tell the user about these before stopping, then run the ack command: <one line per chain: summary -> fanout ack <job>>"}` and exit 0.
- `hook session-start`: the same code path as `fanout status --brief`. Output exactly `fanout: ok` prints nothing; otherwise print `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<brief>"}}`.

- [ ] **Step 1: Write the failing tests** `fanout/tests/hooks.test.ts` (build the ledger through real `fanout run` calls; pipe payloads to the wrappers with `HOME` and `FANOUT_HOME` set to the sandbox and read the exit code and stdout, as doc 06 prescribes; the session id of the sandbox runs is `S1`):
- `Stop blocks on an unreported fallback of this session`. Input: `RUN` with script `fake/f1-a` `['rate_limited']`; `echo '{"session_id":"S1","stop_hook_active":false}' | CLAUDE_PROJECT_DIR=/tmp/p fanout-stop-hook`. Expect: exit 0; stdout parses as JSON with `decision: 'block'` and a `reason` that contains the final job id, `fallback fake/f1-a -> fake/f1-b` and `fanout ack <job>`.
- `after ack there is no output`. Input: `fanout ack <job>`, then the same payload. Expect: exit 0, empty stdout.
- `stop_hook_active true prints nothing`. Input: the unreported fallback and `"stop_hook_active":true`. Expect: exit 0, empty stdout.
- `another session's chain is ignored`. Input: run with `FANOUT_SESSION=S2`; payload `session_id` `S1`. Expect: empty stdout.
- `a chain that is still running is ignored` (Review focus 3). Input: `start(RUN)` with script `fake/f1-a` `['rate_limited']`, `fake/f1-b` `['ok_slow']` (`FAKE_SLEEP_S=4`) and wait for the second `job_start`; send the payload. Expect: empty stdout. After the chain ends: the payload blocks.
- `an old chain is ignored`. Input: a chain with a fallback whose `ts` is 4 days before `FANOUT_NOW`. Expect: empty stdout.
- `the empty-context guard`. Input: `CLAUDE_PROJECT_DIR=''` with an unreported fallback. Expect: exit 0, empty stdout.
- `a session started in HOME is still checked`. Input: `CLAUDE_PROJECT_DIR=<the sandbox HOME>` with an unreported fallback. Expect: stdout is the block JSON.
- `a corrupt ledger or an unwritable home exits 0 silently`. Input: a ledger holding only `{not json`; then `FANOUT_HOME=/proc/fanout-nope`. Expect: exit 0, empty stdout both times.
- `SessionStart: ok prints nothing`. Input: an empty ledger, payload `{"session_id":"S1","source":"startup"}` to `fanout-session-hook`. Expect: exit 0, empty stdout.
- `SessionStart: a cooldown becomes additionalContext`. Input: a run that left `fake/f1-a` cooling. Expect: stdout parses as JSON with `hookSpecificOutput.hookEventName` `SessionStart` and `additionalContext` containing `COOLDOWN fake/f1-a`.

- [ ] **Step 2: Run.** `bun test fanout/tests/hooks.test.ts`. Expected: FAIL (the wrapper does not exist).
- [ ] **Step 3: Implement stop and SessionStart hooks.** `chmod +x fanout/bin/fanout-stop-hook fanout/bin/fanout-session-hook`.
  - `commands/hook.ts`: the `stop` and `session-start` handlers over the Task 21 chain logic.
  - The two bash wrappers with the empty-context guard only.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): add stop and session hooks`.

### Task 26: Seed patterns and fixtures from transcripts

The first edition guessed the error texts. The user's Claude Code transcripts hold the real ones: every past fanout launch and what came back. This one-off task mines them with DuckDB and turns them into scrubbed fixtures and a reviewed cluster index that the adapter tasks consume.

**Files:**

- Create: `fanout/tools/mine/{mine.ts,pairs.sql}`, `fanout/patterns/denylist.json`, `fanout/tests/mine.test.ts`, `fanout/tests/fixtures/mined/<harness>/{index.json,NN.txt}` (produced by the real run in Step 5)
- Modify: `fanout/src/scrub.ts` (add `scrubFixture(text)`, `normalizeSignature(line)` and `signatureToRegex(sig)`; Tasks 27 to 29, 34 and 39 to 41 use them)

**Interfaces:**

- Produces: the script `bun fanout/tools/mine/mine.ts --db <duckdb file> --projects <dir> --raw-out <dir> --out <dir> [--min-count 2]`; per harness `<out>/<harness>/index.json` (`[{ id, file, signature, count, sessions, outcome }]`, `outcome` starts `null`) and one scrubbed `<out>/<harness>/<id>.txt` per cluster; `<raw-out>/pairs.jsonl` (full unscrubbed text, one object per paired launch). It is a dev tool: it is not shipped in the built copy and does not change the `fanout` CLI.

**Facts the query depends on** (checked against the real data on 2026-11-15; the implementer re-checks them while writing `pairs.sql`):

- `~/.local/share/cc-duckdb/cc.duckdb` table `ev` has one row per transcript line with `file`, `sessionId`, `ts` and `cmds` (the Bash commands of an assistant message) but **no tool ids**. It is only good for narrowing the work to files that contain a fanout launch. `~/.local/share/cc-duckdb/refresh.sql` shows how it was built.
- `ev` lists files that Claude Code has since deleted: intersect with `glob('<projects>/**/*.jsonl')` before reading.
- The tool results are in the transcripts: `type: "assistant"` lines hold `tool_use` blocks (`id`, `name`, `input.command`, `input.run_in_background`); `type: "user"` lines hold `tool_result` blocks (`tool_use_id`, `is_error`, `content` as a string or an array of `{type: "text", text}`).
- About half the launches are background commands. Their own result is only `Command running in background with ID: <task>. Output is being written to: <path>`; the output file is gone. The real text comes from later Bash commands that read `tasks/<task>.output` (about 1,200 such commands exist) and from `BashOutput` or `TaskOutput` calls with that task id. Completion status and the exit code come from `type: "queue-operation"` lines whose `content` holds `<task-notification>` with `<task-id>`, `<tool-use-id>`, `<status>` and a summary ending `(exit code N)`.
- DuckDB 2.0 rejects the `x -> ...` lambda form: write `lambda x: ...`. A table function cannot take a subquery: pass the file list through `SET VARIABLE files = (SELECT list(file) ...)` and `read_json(getvariable('files'), ...)`.

**Behaviour.**

- Launch classification on the command text: `codex` for `\bcodex\s+exec\b`; `agy` for `\bagy\b.*\s(-p|--print)\b`; `meta` for `meta-fanout/worker\.sh`; `modelscope` for `modelscope-fanout/scripts/worker\.py`; `opencode` for `\bopencode\s+run\b`; `river` for `claude -p` with `8317` or `CLIPROXY` and a model ending `-river`; `claude-fanout` for the other proxied `claude -p`. Anything else is ignored.
- Pairing: a foreground launch pairs with the `tool_result` of its own `tool_use_id`. A background launch pairs with the text of every later `tool_result` whose originating command references `tasks/<task>.output` or whose `BashOutput`/`TaskOutput` input names the task, plus `exit` from the notification. Each pair records `harness`, `session`, `ts`, `via` (`direct` or `later_read`), `is_error`, `exit` and the text.
- Candidate lines: lines of a pair's text matching `error|fail|limit|quota|exhaust|denied|unauthor|forbidden|\b[45]\d\d\b|timeout|timed out|rate|credit|insufficient|unavailable|not found|invalid|deprecated|cancel|context|max.turns|refus` (case-insensitive). Each is scrubbed, normalised to a signature and counted per `(harness, signature)` with the number of distinct sessions; clusters under `--min-count` are dropped.
- Scrubbing (`scrubFixture`): ULIDs, UUIDs, `toolu_…`, `req_…`, `org-…`, `sess_…`, hex runs of 12 or more and any 24-character token become `<id>`; absolute and `~` paths (Linux, macOS, Windows) become `<path>`; emails become `<email>`; `sk-…`, `AIza…`, `Bearer …`, `ghp_…`, `xox…` and `key=value` secrets become `<secret>`; IPv4 addresses become `<ip>`; URL query strings are dropped. After scrubbing, the tool re-checks every fixture against the Task 2 leak rules and refuses to write one that still matches (exit 1).
- Raw output goes only to `--raw-out`, which must be outside the repository: inside it the tool exits 2 with `raw output must be outside the repository`. Output is deterministic: sorted clusters, file names from the signature hash.
- Stdout: one `MINED <harness> pairs=<n> clusters=<k>` line per harness (sorted) and `SKIPPED files=<n>` for `ev` files missing on disk.

- [ ] **Step 1: Write the failing tests** `fanout/tests/mine.test.ts` (skipped when `duckdb` is not on `PATH`). The test builds a mini database with `duckdb <tmp>/ev.duckdb "CREATE TABLE ev(file VARCHAR, sessionId VARCHAR, cmds VARCHAR[])"` plus inserts, and writes synthetic transcripts (`assistant` and `user` JSONL lines as described above) under a temp `projects/` folder. `HOME_FAKE` is a fake absolute home path built at runtime (`'/' + 'home/someone'`), so no test source holds a path. The fake error text is `ERROR: You've hit your usage limit. Try again at 9:15 PM. Contact bob@example.com. key ` + `'sk-' + 24 letters` + ` at ${HOME_FAKE}/proj/a.ts req_01HZYABCDEFGH1234 id 123e4567-e89b-12d3-a456-426614174000` (the key is built at runtime too). Two sessions each launch `codex exec -C ${HOME_FAKE}/proj -m gpt-6-luna - < ${HOME_FAKE}/b.md` and get this text with different ids:
- `a foreground launch is paired and clustered`. Input: the two sessions; `mine.ts` with `--raw-out` and `--out` temp dirs. Expect: stdout contains `MINED codex pairs=2 clusters=1`; `<out>/codex/index.json` has one entry with `count: 2`, `sessions: 2`, `outcome: null`; its `.txt` fixture exists and contains `hit your usage limit`.
- `scrubbing removes ids, paths, emails and keys`. Input: the same run. Expect: no file under `<out>` contains `bob@example.com`, the key, `HOME_FAKE`'s value, `req_01HZ`, `toolu_` or `123e4567`; the `signature` in `index.json` contains `<email>` and `<path>`.
- `the raw output stays outside the repository`. Input: the same run. Expect: `<raw-out>/pairs.jsonl` has two lines and contains `bob@example.com`. Input: `--raw-out <repo root>/tmp-raw`. Expect: exit 2, stderr `raw output must be outside the repository`, nothing written.
- `a background launch is paired through the later read`. Input: a launch with `run_in_background: true` whose own result is `Command running in background with ID: bk1. Output is being written to: /tmp/x/tasks/bk1.output`, a later Bash command `tail -n 50 /tmp/x/tasks/bk1.output` whose result is the error text, and a `queue-operation` line with `<task-notification><task-id>bk1</task-id><tool-use-id>toolu_AAA111</tool-use-id><status>failed</status><summary>Background command "x" failed (exit code 1)</summary></task-notification>`. Expect: `pairs.jsonl` has one pair with `via: 'later_read'`, `exit: 1`, and the error text.
- `every harness is recognised`. Input: one launch each of `agy -p "$(<b.md)" --model gemini-4-hydrogen --effort medium --add-dir /x`, `"$HOME/CS/meta-fanout/worker.sh" b.md l.log`, `opencode run --model opencode/x --dir . "$(cat b.md)" < /dev/null`, `python3 ~/.claude/skills/modelscope-fanout/scripts/worker.py --cwd . --brief b.md`, `ANTHROPIC_BASE_URL=http://127.0.0.1:8317 ANTHROPIC_MODEL=deepseek-v4.1-flash-river claude -p`, `ANTHROPIC_BASE_URL=http://127.0.0.1:8317 ANTHROPIC_MODEL=glm-5.3-flash claude -p`, each with a failing result. Expect: one `MINED <h> pairs=1` line for `agy`, `meta`, `opencode`, `modelscope`, `river`, `claude-fanout`.
- `other commands are ignored`. Input: a `ls -la` command with a result. Expect: no `MINED` line for it.
- `a transcript that no longer exists is skipped`. Input: an `ev` row whose `file` is not on disk. Expect: exit 0, stdout contains `SKIPPED files=1`.
- `the output is deterministic`. Input: run twice into two `--out` dirs. Expect: identical file trees and contents.

- [ ] **Step 2: Run.** `bun test fanout/tests/mine.test.ts`. Expected: FAIL, "Cannot find module" for `mine.ts`.
- [ ] **Step 3: Implement seed patterns and fixtures from transcripts.**
  - `pairs.sql`: the narrowing (`ev` joined with `glob()`), the block extraction, the launch classification and the pairing (direct, later read, notification), written for DuckDB 2.0 as noted above.
  - `scrub.ts`: `scrubFixture()`, `normalizeSignature()` (numbers `<n>`, hex `<hex>`, UUIDs and ids `<id>`, paths `<path>`) and `signatureToRegex()` (each token replaced by its character class, everything else escaped).
  - `mine.ts`: run the query through the `duckdb` CLI (`-no-agent -json`), scrub, cluster, write `index.json`, the fixtures and `pairs.jsonl`, print the summary; the repo-root guard (`git rev-parse --show-toplevel`).
  - `patterns/denylist.json`: `{ "lines": ["\\[claude-code:unrecognized_model\\]"] }` (the spec's example of a harmless line), extended in Step 6.
- [ ] **Step 4: Run.** `bun test fanout/tests/mine.test.ts` passes; `bun test fanout` passes.
- [ ] **Step 5: Run it for real.** `bun fanout/tools/mine/mine.ts --db ~/.local/share/cc-duckdb/cc.duckdb --projects ~/.claude/projects --raw-out ~/.local/share/agent-ops/fanout/mined --out fanout/tests/fixtures/mined`. Expected: a `MINED` line per harness (the 2026-11-15 probe found 845 paired launches across 68 files, 458 of them background, and about 40 error-looking results; expect single- or double-digit clusters per harness) and `SKIPPED files=<n>`. Check that `git status --short` lists only files under `fanout/tests/fixtures/mined/` and that `bun test fanout/tests/hygiene.test.ts` passes (it scans the fixtures for paths, emails and keys).
- [ ] **Step 6: Review the clusters.** For every `index.json` entry set `outcome` to one of the `Outcome` values (`rate_limited`, `quota_exhausted`, `credits_exhausted`, `auth_error`, `model_unavailable`, `job_error`, `worker_error`) or `harmless`. Rule of thumb: a vendor or CLI error line is a failure class; a line that appears in healthy runs (for example `[claude-code:unrecognized_model]`) is `harmless`, and its normalised line goes into `fanout/patterns/denylist.json` as `{ "lines": ["<regex>"] }`. Delete any fixture whose text is the agent's own commentary rather than the worker's output. Record the counts (clusters per harness, per outcome) in the PR body.
- [ ] **Step 7: Commit.** Title `feat(fanout): seed error fixtures from transcripts`. `git add fanout/tools fanout/src/scrub.ts fanout/patterns/denylist.json fanout/tests && git commit -m "feat(fanout): seed error fixtures from transcripts"`. The raw output stays in `~/.local/share/agent-ops/fanout/mined/` and is not committed.

### Task 27: Codex adapter

Real adapters are tested through the CLI with a stub executable first on `PATH` that records its argv and stdin and replays a scrubbed fixture. Their catalog is a small custom one (`sb.catalog(csv)`) holding the adapter's row and a `fake` row to fall back to.

**Files:**

- Create: `fanout/src/adapters/codex.ts`, `fanout/patterns/codex.json`, `fanout/tests/fixtures/codex/{ok,usage-limit,error-event}.txt` (synthetic; the first line of each says so; replace with the mined text where Task 26 found it), `fanout/tests/adapter-codex.test.ts`
- Modify: `fanout/src/adapters/index.ts` (register `codex`)

**Behaviour.** The flags come from the old codex-fanout skill (`~/.claude/skills/codex-fanout/SKILL.md`, resolve the symlink). `name: "codex"`; discovered models are `subscription`; `envAllow: ['CODEX_HOME']`.

- `build`: argv `["codex","exec","-C",cwd,"-m",model,"-c","model_reasoning_effort=<effort>","--ignore-user-config","--ignore-rules","--ephemeral","--sandbox","workspace-write","--json","--output-last-message","<outDir>/<job>.report.md","-"]`, stdin from the brief file, `reportPath` set. `--ignore-user-config` drops the configured effort, which is why `-c` is explicit; an empty effort omits `-c`. `bypass` replaces the two sandbox flags with `--dangerously-bypass-approvals-and-sandbox`.
- `patterns/codex.json`: `codex-usage-limit` (`hit your usage limit|usage limit`) `quota_exhausted`, scope `account`, with reset parsing; `codex-login` (`not logged in|please log in|codex login`) `auth_error`; `codex-model` (`unknown model|model .* not found`) `model_unavailable`; `codex-context` (`context window|maximum context length`) `job_error`; `codex-error-event` (`"type":"error"`) `worker_error`, `onExit0`; plus one rule per `fixtures/mined/codex/index.json` entry whose `outcome` is a failure class, with `re` from `signatureToRegex(signature)`.
- `usage`: sum every JSONL object that has `usage.input_tokens`, `cached_input_tokens`, `output_tokens`; `tokensIn = max(0, input - cached)`; `undefined` when none.
- `listModels`: `codex debug models`, JSON `.models[].slug`; billing `subscription`. `preflight`: quick = the binary is on `PATH`; full also needs `codex login status` to exit 0, else `auth_error`.
- Quota probe: read `codex --help` and `codex login status` (both free). If either shows a machine-readable remaining-quota command, implement `probe()`; otherwise write a comment in `codex.ts` ("no remaining-quota command in codex <version>, checked 2026-11-15") and carry the same sentence into doc 24 (Task 49).

- [ ] **Step 1: Write the failing tests** `fanout/tests/adapter-codex.test.ts` (`sb.bin('codex', ...)` writes a stub that does `printf '%s\n' "$@" > "$STUB_ARGV"; cat > "$STUB_STDIN"; cat "$FIXTURE"; exit "${STUB_EXIT:-0}"`; catalog rows `codex,gpt-6-luna,medium|low|high,1,subscription,...,any,active` and `fake,f1-a,medium,1,subscription,...`; `ok.txt` is two JSONL lines `{"type":"turn.completed","usage":{"input_tokens":1500,"cached_input_tokens":500,"output_tokens":120}}`):
- `the dry-run argv is the documented array`. Input: `run --dry-run --harness codex --brief B --dir <repo> --kind transcribe`. Expect: `argv` parses to an array that starts `["codex","exec","-C"`, then the cwd, `"-m","gpt-6-luna","-c","model_reasoning_effort=medium","--ignore-user-config","--ignore-rules","--ephemeral","--sandbox","workspace-write","--json","--output-last-message"`, a path ending `.report.md`, and `"-"`.
- `--bypass swaps the sandbox flags`. Input: `--dry-run --bypass`. Expect: `argv` contains `--dangerously-bypass-approvals-and-sandbox` and neither `--sandbox` nor `workspace-write`.
- `the brief goes to stdin and usage is summed`. Input: `FIXTURE=ok.txt`. Expect: `$STUB_STDIN` equals the brief; first line `harness=codex model=gpt-6-luna outcome=ok`; `job_end` {tokens_in: 2000, tokens_cached: 1000, tokens_out: 240}.
- `a usage limit is account scope and falls back`. Input: `FIXTURE=usage-limit.txt` (`ERROR: You've hit your usage limit. Try again at 9:15 PM.`), `STUB_EXIT=1`, `at('2026-11-15T01:00:00Z')`. Expect: `limit_hit` {harness: 'codex', scope: 'account', outcome: 'quota_exhausted', source: 'stated', until: '2026-11-15T13:15:00.000Z'}; stdout `FALLBACK codex/gpt-6-luna quota_exhausted (resets 21:15) -> fake/f1-a.`.
- `an error event on a clean exit is a worker error`. Input: `FIXTURE=error-event.txt` (`{"type":"error","message":"boom"}`), `STUB_EXIT=0`. Expect: `job_end` {outcome: 'worker_error', pattern: 'codex-error-event'}.
- `a clean exit that quotes a usage limit is ok`. Input: a fixture whose final message says "the usage limit page explains quotas", exit 0, writing a file. Expect: `outcome=ok`.
- `a missing codex binary skips the candidate`. Input: `PATH` without `codex`. Expect: stdout `NOTE codex: codex not found on PATH`; the run continues on `fake/f1-a`.
- `the mined fixtures classify as recorded`. Input: for each entry of `fixtures/mined/codex/index.json` whose `outcome` is not `harmless`, run with `FIXTURE=<fixture>`, `STUB_EXIT=1`. Expect: `job_end.outcome` equals the entry's `outcome`.

- [ ] **Step 2: Run.** `bun test fanout/tests/adapter-codex.test.ts`. Expected: FAIL (`codex` is not a registered adapter).
- [ ] **Step 3: Implement** `codex.ts` (`build`, `usage`, `listModels`, `preflight`, `classify` through the shared rule loader), the patterns and fixtures, and register it. Capture a models fixture for Task 32: `codex debug models > fanout/tests/fixtures/codex/models.txt` (listing is free); review it for account data before committing.
- [ ] **Step 4: Run.** `bun test fanout` passes. Then, with the real binary and no worker started: `bun fanout/src/cli.ts run --dry-run --brief <any file> --dir . --kind transcribe --harness codex` prints one `DRYRUN codex/gpt-6-luna ...` line.
- [ ] **Step 5: Commit.** Title `feat(fanout): codex adapter`.

### Task 28: Agy adapter

**Files:**

- Create: `fanout/src/adapters/agy.ts`, `fanout/patterns/agy.json`, `fanout/tests/fixtures/agy/{ok,timeout,invalid-model}.txt`, `fanout/tests/adapter-agy.test.ts`
- Modify: `fanout/src/adapters/index.ts`

**Behaviour.** Knowledge from `~/CS/agy-fanout/SKILL.md` (agy 1.5.9). `name: "agy"`, billing `subscription`.

- `build`: the worker's `cwd` is the workspace cwd (the skill's `cd "$TASK_DIR"`), argv `["agy","-p",<brief file text>,"--model",model,"--effort",effort,"--dangerously-skip-permissions","--disable-slash-commands","--add-dir",cwd,"--print-timeout","<timeoutS>s"]`. Both the `cwd` and `--add-dir` are mandatory: without `--add-dir` agy writes to `~/.gemini/antigravity-cli/scratch/`, and launched from the parent it writes into the launch directory and still exits 0. `--disable-slash-commands` stops a brief that starts with `/` from expanding a skill or macro. Never `--mode plan`. A brief over 120,000 bytes throws `SkipCandidate("brief too large for agy argv")`.
- `patterns/agy.json`: `agy-timeout` (`\[agy\] print timeout after`) `timeout`, `onExit0` (agy exits 0 on `--print-timeout`); `agy-invalid-model` (`invalid model selection|has no ".+" effort|is not recognized`) `model_unavailable`; `agy-cancel` (`context canceled`) `worker_error`; `agy-quota` (`quota|RESOURCE_EXHAUSTED|exhausted your capacity`) `quota_exhausted`, scope `model`; plus the rules from the mined clusters as in Task 27.
- `usage` returns `undefined` (text mode prints none). `preflight`: quick = binary on `PATH`; full = `agy models` exits 0. `listModels`: run `agy models`, take each token shaped like a composite id (`<base>-<low|medium|high|xhigh|max>`), group by base into `{model, efforts}`. Capture the real list now (`agy models > fanout/tests/fixtures/agy/models.txt`, free) and fix the parser against it.

- [ ] **Step 1: Write the failing tests** `fanout/tests/adapter-agy.test.ts` (stub `agy` records argv and its own `pwd`; the default catalog is used where stated with `{ noCatalog: true }`, otherwise a small catalog with the agy rows and `fake/f1-a`):
- `the stub sees the worktree as cwd and as --add-dir`. Input: `run --harness agy --model gemini-4-hydrogen ...` with the stub. Expect: the recorded `pwd` equals the `WORKTREE=` path; argv contains `--add-dir` followed by the same path, `--dangerously-skip-permissions`, `--disable-slash-commands`, `--model gemini-4-hydrogen`, `--effort medium`, `--print-timeout 1500s`; argv has no `--mode`.
- `a print-timeout line on exit 0 is a timeout`. Input: `FIXTURE=timeout.txt` (`[agy] print timeout after 300s`), `STUB_EXIT=0`. Expect: `job_end.outcome` `timeout`; no `limit_hit`; the fallback target `fake/f1-a` runs.
- `an invalid model selection cools the model`. Input: `FIXTURE=invalid-model.txt` (`invalid model selection: gemini-4-hydrogen`), `STUB_EXIT=1`. Expect: `job_end.outcome` `model_unavailable`; a `limit_hit` with scope `model`.
- `a clean exit that mentions quota is ok`. Input: a fixture saying "see the quota section", exit 0, writing a file. Expect: `outcome=ok`.
- `a 130 KB brief skips agy`. Input: `sb.brief(undefined, 130000)`. Expect: stdout `NOTE agy: brief too large for agy argv`; the run continues on `fake/f1-a`.
- `argon's effort ceiling is high`. Input: `{ noCatalog: true }`, `run --dry-run --harness agy --model gemini-4-argon --effort xhigh ...`. Expect: exit 2, stderr `effort xhigh is not one of high|medium|low for agy/gemini-4-argon`.
- `agy climbs effort before tier` (the user's ruling). Input: `{ noCatalog: true }`, private csv `harness,model,tier\nagy,gemini-4-argon,3`, stub `agy`; `run --kind edit --harness agy --model gemini-4-hydrogen` (job `J1`); then `run --escalate-from J1 ...`; then `--escalate-from` the new job. Expect: the three `job_start` events are `gemini-4-hydrogen`/`medium`, `gemini-4-hydrogen`/`xhigh`, `gemini-4-argon`/`high` with tiers 2, 2, 3.
- `the mined fixtures classify as recorded`. Input: as in Task 27 with `agy`. Expect: each `job_end.outcome` equals the recorded `outcome`.

- [ ] **Step 2: Run.** `bun test fanout/tests/adapter-agy.test.ts`. Expected: FAIL (`agy` is not a registered adapter).
- [ ] **Step 3: Implement** `agy.ts`, the patterns and fixtures, and register it.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): agy adapter`.

### Task 29: Claude CLI base and Meta adapter

`claude -p` against another endpoint is the shape of the meta, river, claude-fanout and modelscope workers. This task builds the shared base and the first user, Meta.

**Files:**

- Create: `fanout/src/adapters/{claude-cli,meta}.ts`, `fanout/patterns/meta.json`, `fanout/tests/fixtures/meta/{ok,401,402,429,max-turns}.txt` (synthetic last-line JSON shaped like the output described in `~/CS/meta-fanout/worker.sh`; replace with mined text where Task 26 found it), `fanout/tests/adapter-meta.test.ts`
- Modify: `fanout/src/adapters/index.ts`, `fanout/src/result.ts` (`DENIALS=<n>`)

**Behaviour.**

- Base `build`: argv `["claude","-p","--model",<pinned model>,"--effort",effort,"--permission-mode",bypass?"bypassPermissions":"acceptEdits","--max-turns",maxTurns,"--output-format","json", ...allow.flatMap(a => ["--allowedTools", a])]`; stdin from the brief. Env: `CLAUDE_CONFIG_DIR=$HOME/.claude-fanout` (an empty dir; no plugins or hooks, about 5x fewer input tokens), `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` = the token, `ANTHROPIC_API_KEY` null, `ANTHROPIC_MODEL`, the opus, sonnet and haiku default-model variables and `CLAUDE_CODE_SUBAGENT_MODEL` all set to the model, `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80`, `ENABLE_TOOL_SEARCH=true`. `secrets` = [token]. The base takes a config object (name, base URL, token, model pin, effort fix, tool list, isolation flags, defaults, billing) so River, OpenRouter and ModelScope reuse it.
- Base `usage`: from the last JSON line, sum `modelUsage`: `tokensIn = inputTokens + cacheCreationInputTokens`, `tokensCached = cacheReadInputTokens`, `tokensOut = outputTokens`. **`total_cost_usd` is never read** (fictional for non-Anthropic models). Base `classify`: exit 0 with `is_error` or `api_error_status` maps by status (401 `auth_error`, 402 or 403 `credits_exhausted`, 429 `rate_limited`, 413 or 422 `job_error`, 400 naming effort `model_unavailable`), `subtype` `error_max_turns` is `job_error`, else the rules. `permission_denials` length feeds `DENIALS=<n>` (informational).
- Meta: base URL `https://api.meta.ai` (`FANOUT_META_URL` overrides it in tests); the key is `META_MODEL_API_KEY` from the environment or parsed (not sourced) from the `FANOUT_SECRETS` file; `max` is rounded to `xhigh` on `*-contributor`; defaults timeout 1500, max turns 40; billing `paid`. `listModels`: `GET /v1/models` with the bearer key, ids starting `muse-`. `preflight`: quick = key present and `claude` on `PATH`; full also `GET /v1/models` and the model is listed. **Full preflight never makes an inference call** (the old `setup.sh` did; upkeep must not). A missing key gives `NOTE meta: no META_MODEL_API_KEY on file; the user adds it in their own terminal, never in the chat`.
- `patterns/meta.json`: HTTP 401 `auth_error`; 402 or 403 `credits_exhausted` (account; no payment method); 429 `rate_limited` (150 requests a minute per team); 400 naming effort `model_unavailable`; plus the mined rules as in Task 27.

- [ ] **Step 1: Write the failing tests** `fanout/tests/adapter-meta.test.ts` (stub `claude` records argv and `env` to files and prints the fixture; the fake key is built at runtime and written to a `FANOUT_SECRETS` file in the sandbox; the catalog holds the `meta` rows of the default catalog and `fake/f1-a`):
- `a contributor model at max effort is rounded and the key is hidden`. Input: `run --dry-run --public --model muse-spark-1.3-contributor --effort max ...`. Expect: `argv` contains `--effort xhigh`; the output does not contain the key (it travels in the environment, never in argv).
- `the stub environment is isolated`. Input: a run with the stub and the parent env `ANTHROPIC_API_KEY=parent-key`. Expect: the recorded env has `ANTHROPIC_BASE_URL` equal to `FANOUT_META_URL`, `ANTHROPIC_MODEL` equal to the model, `CLAUDE_CONFIG_DIR` ending `/.claude-fanout`, `ANTHROPIC_AUTH_TOKEN` equal to the fake key, and no `ANTHROPIC_API_KEY`.
- `usage is summed from modelUsage and the cost is computed`. Input: `FIXTURE=ok.txt` = `{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":9.99,"modelUsage":{"muse-spark-1.3-contributor":{"inputTokens":1000000,"cacheReadInputTokens":2000000,"cacheCreationInputTokens":0,"outputTokens":100000}},"permission_denials":[]}`; `run --public --model muse-spark-1.3-contributor`. Expect: stdout contains `actual $0.12 (computed from tokens)` (`(1e6 x 0.10 + 2e6 x 0.002 + 1e5 x 0.20) / 1e6 = 0.124`) and not `9.99`.
- `401, 402 and 429 map to outcomes and fall back`. Input: fixtures with `api_error_status` 401, 402, 429, `STUB_EXIT=1`. Expect: `job_end.outcome` `auth_error` (`limit_hit.scope` account), `credits_exhausted` (account), `rate_limited` (model); each run's stdout has a `FALLBACK meta/... -> fake/f1-a` line.
- `a turn cap is a job error`. Input: `FIXTURE=max-turns.txt` (`{"type":"result","subtype":"error_max_turns","is_error":true,...}`), `STUB_EXIT=1`. Expect: `outcome=job_error`; one `job_start`; a `FAILED job_error:` line.
- `denials are reported`. Input: a fixture with two `permission_denials`. Expect: stdout contains `DENIALS=2`.
- `a clean result that mentions 429 stays ok`. Input: a fixture whose `result` text is "see the 429 section", `is_error` false. Expect: `outcome=ok`.
- `--allow and --bypass reach the argv`. Input: `--dry-run --allow 'Bash(git status)' --bypass`. Expect: `argv` contains `--allowedTools`, `Bash(git status)` and `bypassPermissions`.
- `no key on file skips the candidate`. Input: no key in the environment or the secrets file. Expect: stdout contains the `NOTE meta: no META_MODEL_API_KEY on file; ...` text; the run continues on `fake/f1-a`.
- `the key appears nowhere`. Input: a full run, then `grep -r <key>` over the sandbox home and the captured stdout and stderr. Expect: no match outside the recorded stub env file.
- `the mined fixtures classify as recorded`. Input: as in Task 27 with `meta`. Expect: each `job_end.outcome` equals the recorded `outcome`.

- [ ] **Step 2: Run.** `bun test fanout/tests/adapter-meta.test.ts`. Expected: FAIL (`meta` is not a registered adapter).
- [ ] **Step 3: Implement the Claude CLI base and the Meta adapter.** `adapters/claude-cli.ts`: the shared `build`, `usage` and `classify` over a config object; `adapters/meta.ts`: the key lookup, the effort rounding, `listModels` and `preflight`; `patterns/meta.json` and the fixtures; register `meta` in `adapters/index.ts`; `result.ts`: the `DENIALS` line.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): claude-cli base and meta adapter`.

## Phase 2: upkeep

Upkeep keeps the catalog, the learned state and the health picture current without the user. It never spends paid credit and never asks anything.

### Task 30: Upkeep skeleton and lazy trigger

**Files:**

- Create: `fanout/src/upkeep/{index,lock,lazy}.ts`, `fanout/src/commands/upkeep.ts`
- Modify: `fanout/src/{cli,status}.ts`
- Test: `fanout/tests/upkeep.test.ts`

**Interfaces:**

- Produces: `registerStep(name, fn)` (steps added by later tasks run in this order: doctor (31), discover (32), smoke (33), benchmarks (36), patterns (34), housekeeping (35)); `status.json` fields `generated_at`, `last_upkeep_attempt`, `last_upkeep_ok`, `benchmarks_refreshed_at`, `benchmarks_note`, `new_models`, `gone_models`, `smoke` (`{pass, fail, pending}`), `paid_trial`; `runUpkeepContext(args)` (a `run` that forces `--no-paid`, caller `upkeep` and never asks the user).

**Behaviour.**

- `fanout upkeep [--lazy] [--only <step>]` runs the registered steps in order. Each step runs in try and catch with a 10-minute limit and appends an `upkeep` event {step, status `ok`, `failed` or `skipped`, detail}; a failing step never stops the next one, and the command exits 0. The last action rewrites `status.json` atomically (write a temp file, rename); `last_upkeep_ok` is set only when no step failed.
- Lock: `run/upkeep.lock` holds pid and start ticks; a second upkeep exits 0 immediately with `upkeep already running` when a live owner exists and takes over a stale lock.
- Paid guard: a step reaches workers only through `runUpkeepContext()`, so paid and per-call rows are unreachable (Task 33's capped per-call smoke passes its own allowance).
- Lazy trigger: every `fanout` command except `upkeep` calls `maybeLazyUpkeep()`. It returns unless `FANOUT_NO_LAZY` is not `1`, `status.json` says the last success is over 24 h old (or the file is missing), the last attempt is over 1 h old, and no lock is held; then it spawns `bun <cli> upkeep --lazy` detached with ignored stdio and `unref()`. It never throws and never waits. `FANOUT_LAZY_LOG=<file>` makes it append `spawn upkeep --lazy` instead of spawning.
- `status --brief` adds the stateless line `UPKEEP (24h): <step> <status>[ via <h>/<m>], ...` built from every `upkeep` event of the last 24 hours, in time order, naming the model when an upkeep job ran a worker.

- [ ] **Step 1: Write the failing tests** `fanout/tests/upkeep.test.ts` (the fake-only test steps are chosen with `FANOUT_TEST_STEPS=fail,ok,slow,probe`; `fail` throws `boom`, `ok` succeeds, `slow` sleeps 2 s, `probe` calls `runUpkeepContext(['--brief', ..., '--kind', 'extract'])`):
- `a failing step is recorded and the next one still runs`. Input: `FANOUT_TEST_STEPS=fail,ok upkeep`. Expect: exit 0; `upkeep` events {step: 'fail', status: 'failed', detail: 'boom'} then {step: 'ok', status: 'ok'}; `status.json` exists and its `generated_at` is later than both events.
- `last_upkeep_ok only moves on a clean run`. Input: `FANOUT_TEST_STEPS=ok upkeep` at `at('2026-11-15T01:00:00Z')`, then `FANOUT_TEST_STEPS=fail,ok upkeep` at `02:00Z`. Expect: after the first, `status.json.last_upkeep_ok` is `2026-11-15T01:00:00.000Z`; after the second it is unchanged while `last_upkeep_attempt` is `02:00:00.000Z`.
- `a second upkeep returns at once`. Input: `start()` two `upkeep` with `FANOUT_TEST_STEPS=slow`. Expect: one of them prints `upkeep already running` and exits 0 in under 1 s; only one `slow` event exists.
- `a stale lock is taken over`. Input: `run/upkeep.lock` holding a dead pid; `FANOUT_TEST_STEPS=ok upkeep`. Expect: the `ok` event appears.
- `upkeep cannot reach a paid row`. Input: a catalog holding only `fake2/f1-paid`; `FANOUT_TEST_STEPS=probe upkeep`. Expect: an `upkeep` event {step: 'probe', status: 'failed'} whose `detail` contains `REFUSED no eligible candidate`; no `job_start` exists.
- `--only runs one step`. Input: `FANOUT_TEST_STEPS=fail,ok upkeep --only ok`. Expect: only the `ok` event.
- `the lazy trigger fires only when due`. Input (`FANOUT_NO_LAZY` unset, `FANOUT_LAZY_LOG=<tmp>/lazy`, `status --brief`, six cases): `status.json` with `last_upkeep_ok` 25 h and `last_upkeep_attempt` 2 h before `FANOUT_NOW`; the same with the attempt 10 minutes ago; the first case with `FANOUT_NO_LAZY=1`; no `status.json`; the first case with a live lock held; the first case with an unwritable `FANOUT_HOME`. Expect: the log file gets one line `spawn upkeep --lazy` for the first and fourth cases and none for the others; every case exits 0.
- `status shows the last 24 hours of upkeep`. Input: `FANOUT_TEST_STEPS=fail,ok upkeep`, then `status --brief`. Expect: a line `UPKEEP (24h): fail failed, ok ok`.

- [ ] **Step 2: Run.** `bun test fanout/tests/upkeep.test.ts`. Expected: FAIL, "unknown command upkeep".
- [ ] **Step 3: Implement upkeep skeleton and lazy trigger.**
  - `upkeep/index.ts`: the registry, the step runner with its limit and the `upkeep` events, the atomic `status.json` write.
  - `upkeep/lock.ts` and `upkeep/lazy.ts`: the lock and the trigger; `runUpkeepContext()` in `commands/upkeep.ts`.
  - `status.ts`: the `UPKEEP (24h)` line; `cli.ts`: call `maybeLazyUpkeep()`.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): upkeep skeleton with lazy trigger`.

### Task 31: Doctor

**Files:**

- Create: `fanout/src/upkeep/doctor.ts`, `fanout/src/commands/doctor.ts`
- Modify: `fanout/src/adapters/fake.ts` (`FAKE_PREFLIGHT=<harness>:<outcome>` makes that harness's full preflight fail with that outcome)
- Test: `fanout/tests/doctor.test.ts`

**Behaviour.** `fanout doctor` prints `PASS|WARN|FAIL <name>: <detail>` per check and exits 1 only on a `FAIL`. The upkeep step runs it deep. None of the checks spends quota or credit, and no key or token appears in any detail. Checks (names are the first word after the verdict): `data-dir` (writable and an append round trip; `FAIL`); `adapter-<harness>` (the full `preflight()`; an `auth_error` also appends one account `limit_hit` {source backoff} for that harness so routing skips it until a trial job succeeds; `WARN`); `duckdb` (`duckdb --version`; `WARN`); `path` (`env -i HOME=$HOME bash -lc 'command -v fanout'` finds the CLI through the login profile; `WARN`); `skill` (reachable in `~/.claude/skills`, `~/.agents/skills` and `~/.gemini/config/skills`; `WARN`); `hooks` (a Stop and a SessionStart group naming `fanout-stop-hook` and `fanout-session-hook` in `~/.claude/settings.json`; `WARN`); `timer` (`systemctl --user is-enabled fanout-upkeep.timer`; `WARN`, also when systemd is unavailable); `notify` (a notifier exists: `FANOUT_NOTIFY_CMD`, `notify-send` or `powershell.exe`; `WARN`); `aa-key` (`AA_API_KEY` present in the `FANOUT_SECRETS` file; `WARN`); `learned` (the JSON files under `learned/` parse; `WARN`); `ledger` (the number of events skipped for `v > 1`; informational `PASS`). `fanout doctor --notify-test` sends one notification titled `fanout: test` with the body `notifications work` through the notifier and exits 1 with `FAIL notify: no notifier found` when there is none.

- [ ] **Step 1: Write the failing tests** `fanout/tests/doctor.test.ts` (sandbox `HOME` with a fake `~/.claude/settings.json` that names both hooks, skill links in the three folders, a stub `systemctl` that prints `enabled`, a stub `duckdb`, a stub notifier as `FANOUT_NOTIFY_CMD`, and a secrets file holding `AA_API_KEY=<fake>` named by `FANOUT_SECRETS`):
- `all green prints PASS lines and exits 0`. Input: `doctor`. Expect: exit 0; lines starting `PASS data-dir:`, `PASS adapter-fake:`, `PASS duckdb:`, `PASS skill:`, `PASS hooks:`, `PASS timer:`, `PASS notify:`, `PASS aa-key:`; no `WARN` or `FAIL` line.
- `an auth failure warns and cools the harness once`. Input: `FAKE_PREFLIGHT=fake:auth_error`, `doctor` twice. Expect: a line `WARN adapter-fake:` containing `auth_error`; exactly one `limit_hit` {harness: 'fake', scope: 'account', source: 'backoff'} after the first call and still one after the second.
- `a missing skill link or hook group warns`. Input: remove the `~/.gemini/config/skills/fanout` link; remove the Stop group from `settings.json`. Expect: `WARN skill:` naming the missing folder and `WARN hooks:`; exit 0.
- `an unwritable data directory fails`. Input: `FANOUT_HOME=/proc/fanout-nope`. Expect: exit 1; `FAIL data-dir:`.
- `a missing duckdb warns`. Input: `PATH` = `sb.pathWithout(['duckdb'])`. Expect: `WARN duckdb:`; exit 0.
- `a missing AA key warns without printing a value`. Input: a secrets file without `AA_API_KEY`. Expect: `WARN aa-key: AA_API_KEY is not set in <the file name>`; the output never contains the fake key from the green run.
- `a missing notifier warns, and --notify-test fails`. Input: `PATH` = `sb.pathWithout(['notify-send', 'powershell.exe'])`, no `FANOUT_NOTIFY_CMD`. Expect: `WARN notify:`; `doctor --notify-test` exits 1 with `FAIL notify: no notifier found`.
- `--notify-test sends one notification`. Input: the stub notifier, `doctor --notify-test`. Expect: exit 0; `$STUB_OUT` holds one line `fanout: test|notifications work`.
- `no key or token appears in the output`. Input: the green run with the secrets file holding fake `META_MODEL_API_KEY` and `AA_API_KEY` values. Expect: neither value appears in stdout or stderr.

- [ ] **Step 2: Run.** `bun test fanout/tests/doctor.test.ts`. Expected: FAIL, "unknown command doctor".
- [ ] **Step 3: Implement** `upkeep/doctor.ts` (the checks above), `commands/doctor.ts` (output, exit code, `--notify-test`) and register the upkeep step.
- [ ] **Step 4: Run.** `bun test fanout` passes. `bun fanout/src/cli.ts doctor` against the real home prints one line per check.
- [ ] **Step 5: Commit.** Title `feat(fanout): doctor self-check`.

### Task 32: Discovery, auto-tiering and learned state

New models appear and old ones vanish. This task finds them, tiers them, and remembers what it saw in `learned/` so the memory outlives the 30-day read window.

**Files:**

- Create: `fanout/src/upkeep/discover.ts`
- Modify: `fanout/src/{catalog,state}.ts` (read `learned/catalog.auto.json` and the `gone` and `back` lines of `learned/state.jsonl`), `fanout/src/commands/upkeep.ts` (register the step)
- Test: `fanout/tests/discover.test.ts`

**Behaviour.**

- For each adapter, `listModels()`; ids matching `catalog/discovery-ignore.txt` are skipped. A model absent from the catalog becomes an auto row in `learned/catalog.auto.json` (atomic write) with status `trial`, a `model_seen` event and a `tier_set` {source `auto`} event. A model missing from a **successful** listing gets a `model_gone` event and a `gone` line in `learned/state.jsonl`; routing skips a gone key whatever layer its row came from (the default and private files are never edited; `status` marks the row `gone`); a model seen again gets a `back` line and is routable again. A failed `listModels()` changes nothing.
- Auto tier: `aa_intel` below 35 gives 1, 35 to 52 gives 2, above 52 gives 3; else by `price_out` per 1M (at most 0.6 gives 1, at most 8 gives 2, else 3); else 2. Benchmark lookup compares `normalize(name)` (lowercase, strip an `org/` prefix, strip non-alphanumerics) with the `aliases` column, the `aa_slug` or the model id.
- Defaults per adapter: codex and agy `subscription`; meta, river and claude-fanout `paid` with prices when known (a model without a price stays unpriced and unrouted); opencode `*-free` is `free`; modelscope `per_call` with `price_call` 2. `data_class` is `public-only` for ids containing `contributor`, `stealth/` or `:free`, and for opencode `*-free`; else `any`.
- Real adapters' `listModels()` are tested here with stubs and the fixtures Tasks 27 to 29 captured (codex, agy, meta); the river, claude-fanout, modelscope and opencode ones are added by Tasks 39 to 41 and re-checked here.

- [ ] **Step 1: Write the failing tests** `fanout/tests/discover.test.ts` (`FANOUT_FAKE_MODELS` drives the fake adapter, e.g. `[{"model":"f1-a"},{"model":"f9-new","billing":"subscription"}]`; stubs drive the real ones; step run as `upkeep --only discover`):
- `a new model becomes an auto trial row`. Input: `FANOUT_FAKE_MODELS` adds `f9-new`. Expect: `learned('catalog.auto.json').rows` has `{harness: 'fake', model: 'f9-new', status: 'trial', billing: 'subscription'}`; events `model_seen` and `tier_set` (`source: 'auto'`); `pick --all` does not list it (trial rows are not routed until Task 33).
- `the default and private catalogs win over discovery`. Input: private csv `harness,model,tier\nagy,gemini-4-argon,3`; the agy stub lists `gemini-4-argon` at some other tier. Expect: no auto row for it; `pick --all` still shows tier 3.
- `ignored ids are never added`. Input: the agy stub lists `claude-sonnet-5-5`. Expect: no auto row.
- `a missing model is gone, and the memory survives the window`. Input: `FANOUT_FAKE_MODELS` lists only `f1-b` (so `fake/f1-a` is missing from a successful listing); discover; then delete the `events/` folder. Expect: `learned('state.jsonl')` has a `gone` line for `fake/f1-a`; `pick --all` has no `fake/f1-a` even with no events; `status` prints a row line for it with `gone`.
- `status shows new and gone models`. Input: after the new-model case and the gone case, `status --brief`. Expect: a line `NEW fake/f9-new` and a line `GONE fake/f1-a` (`NEW` lists up to 5 models and ends `(+N more)` beyond that).
- `a failed listing changes nothing`. Input: `FANOUT_FAKE_MODELS='not json'`. Expect: no `gone` line, no auto row, the `upkeep` event is `failed`.
- `a returning model is revived`. Input: after the gone case, list `f1-a` again and discover. Expect: a `back` line; `pick --all` lists `fake/f1-a`.
- `auto tier from benchmarks and price`. Input: six new models, three with `aa_intel` 30, 50 and 55 in a `learned/benchmarks.json` fixture, and three with no benchmark and `price_out` 0.4, `price_out` 5, and no price at all; `upkeep --only discover`. Expect: the auto rows get tiers 1, 2, 3, 1, 2 and 2 in that order.
- `normalize matches names to aliases`. Input: a discovered `Qwen/Qwen3.8-27B` and a benchmark entry named `Qwen3.8 27B` with `aa_intel` 40. Expect: the auto row's tier is 2.
- `public-only by name`. Input: new ids `muse-x-contributor`, `stealth/alpha`, `acme/model:free`, `ok-model`. Expect: the first three `data_class: 'public-only'`, the last `any`.
- `a paid model without a price stays unrouted`. Input: a discovered meta model with no price in the listing. Expect: the auto row has no prices; `pick --all` never lists it; no `WARN catalog row skipped` line is printed (an unpriced auto row is expected and skipped silently).
- `running discover twice adds nothing`. Input: discover twice. Expect: the second `upkeep` event has detail `0 new, 0 gone`; no extra `model_seen`.
- `captured listings parse`. Input: the `codex`, `agy` and `meta` stubs print their `models.txt` fixtures. Expect: the expected model ids and efforts appear as auto rows (fixture-specific assertions written when the fixtures are captured).

- [ ] **Step 2: Run.** `bun test fanout/tests/discover.test.ts`. Expected: FAIL (no auto rows are written).
- [ ] **Step 3: Implement discovery, auto-tiering and learned state.**
  - `upkeep/discover.ts`: the diff, the auto-tier rule, `normalize()`, the adapter defaults and the `data_class` rule.
  - `catalog.ts`: merge `learned/catalog.auto.json`; `state.ts`: read `gone` and `back` lines; `pick.ts`: skip gone keys.
  - Register the upkeep step; add `NEW` and `GONE` lines to `status` from `status.json`.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): model discovery and learned state`.

### Task 33: Smoke tests and promotion on first use

Catalog membership is not compatibility. A new free, subscription or per-call model proves itself with a bounded smoke test during upkeep. A new paid model has no smoke test: its first real job is the proof.

**Files:**

- Create: `fanout/src/upkeep/smoke.ts`
- Modify: `fanout/src/{pick,run,state,status}.ts`, `fanout/tests/helpers/fake-worker.ts` (scenarios `smoke_ok`: writes `smoke.txt` with `fanout-smoke-ok\n`; `smoke_wrong`: writes wrong bytes)
- Test: `fanout/tests/smoke.test.ts`

**Behaviour** (Call 12).

- The smoke brief is fixed: "Create a file named smoke.txt in the current directory containing exactly the text fanout-smoke-ok followed by one newline, and nothing else. Do not create any other file. Do not run git." Each smoke runs in a new temp directory under `smoke/` (not a git repo) through `runUpkeepContext()` with `--kind smoke --public --pin`, the row's default effort and `--max-turns 2` for per-call rows. Pass means the bytes of `smoke.txt` equal the text and no other file exists. A limit-class outcome (`rate_limited`, `quota_exhausted`, `credits_exhausted`, `auth_error`, `timeout`) is `skipped` (tried again next upkeep). `ok` with wrong bytes, `worker_error`, or a repeated `unknown` is `fail`, retried at most once per 7 days. Each result is a `smoke` event {harness, model, result, detail} and a `smoke` line in `learned/state.jsonl`.
- Budget per upkeep: unproven free and subscription rows at most 5, in tier order; unproven per-call rows at most 3, each with `--max-turns 2` (the measured calls go in `detail`; more than 2 is recorded as `over budget` but not failed); **never** a paid row.
- Trial gating: a smoke-passed trial row (free, subscription or per-call) is routable only as the last candidate of its tier, takes at most one concurrent job (a live lease on it blocks a second) and only when no proven row of its tier is free. At 5 accepted `judged` lines it graduates and counts as `active`.
- Promotion on first use: a `trial` **paid** row is routable as the last candidate of its tier, one job at a time. Its first real job that ends `ok` with a changed file appends `first_use` {result `pass`} to `learned/state.jsonl` and the row is promoted (it displays as `active` and ranks by the normal keys). A first job that ends `no_effect` or `worker_error` appends `first_use` {result `fail`} and the row is hidden for 7 days.
- `status` gains `SMOKE pass=<n> fail=<n> pending=<n>` and `NEW (paid, promoted on first use): <models>`.

- [ ] **Step 1: Write the failing tests** `fanout/tests/smoke.test.ts` (private catalog retiring the paid rows unless stated; the upkeep step is run as `upkeep --only smoke`):
- `a passing smoke makes the trial row routable as the last of its tier`. Input: script `fake3/f1-trial` `['smoke_ok']`. Expect: a `smoke` event {harness: 'fake3', model: 'f1-trial', result: 'pass'}; `learned('state.jsonl')` last line `{kind: 'smoke', key: 'fake3/f1-trial', result: 'pass'}`; `pick --all` lists `fake3/f1-trial` with `status=trial` after every other tier 1 row.
- `a wrong smoke fails and is not retried for 7 days`. Input: script `['smoke_wrong']`; upkeep at `2026-11-15T01:00:00Z`, `2026-11-18T01:00:00Z`, `2026-11-23T01:00:00Z`. Expect: first result `fail` with detail `smoke.txt has wrong bytes`; no new `smoke` event at +3 days; a new one at +8 days.
- `a limit is skipped and tried again`. Input: script `['rate_limited', 'smoke_ok']`; upkeep twice. Expect: the first `smoke` result is `skipped` and no pass or fail line is written; the second is `pass`.
- `paid rows are never smoke-tested`. Input: private csv `harness,model,status\nfake2,f1-paid,trial`; upkeep. Expect: no `job_start` with `model: 'f1-paid'`; the `upkeep` event detail contains `1 paid rows promote on first use`; `status --brief` prints `NEW (paid, promoted on first use): fake2/f1-paid`.
- `per-call rows are capped at 3 per upkeep with 2 turns each`. Input: a catalog with five `trial` per-call rows. Expect: three `job_start` events (billing `per_call`, `calls_est: 2`); a second upkeep smokes the remaining two.
- `a trial paid row is the last candidate of its tier`. Input: private csv `harness,model,status\nfake2,f1-paid,trial`; `pick --all`. Expect: `fake2/f1-paid` has `status=trial` and a higher `CAND` number than every other tier 1 row and a lower one than every tier 2 row.
- `the first real job promotes a paid trial row`. Input: the same csv; `run --model f1-paid` with scenario `ok`. Expect: `learned('state.jsonl')` last line `{kind: 'first_use', key: 'fake2/f1-paid', result: 'pass'}`; `pick --all` now lists it with `status=active`.
- `a failed first use hides the row for 7 days`. Input: the same csv; `run --model f1-paid` with scenario `ok_no_write`. Expect: a `first_use` line with result `fail`; `pick --all` at `+3 days` has no `fake2/f1-paid`; at `+8 days` it is listed again.
- `a paid trial row takes one job at a time`. Input: the same csv plus private rows retiring every other tier 1 row; `start()` two `RUN` with scenario `ok_slow`, `FAKE_SLEEP_S=2`. Expect: exactly one `job_start` has `model: 'f1-paid'`; the other run is on a tier 2 row.
- `a smoke-passed free trial row graduates after 5 accepted jobs`. Input: a pass for `fake3/f1-trial`; five `RUN --model f1-trial` each followed by `verdict <job> accepted`. Expect: `pick --all` lists `fake3/f1-trial` with `status=active` in normal billing order (after `fake2/f1-c`, before every paid row).
- `a trial row yields to a free proven row`. Input: a pass for `fake3/f1-trial`; `RUN` with `fake/f1-a` available. Expect: the first `job_start` is `fake/f1-a`, never `fake3/f1-trial`.
- `proof outlives the event window`. Input: a pass and a first use recorded; delete the `events/` folder; `pick --all`. Expect: `fake3/f1-trial` and `fake2/f1-paid` are still routable.
- `status counts`. Input: after one pass and one fail, `status --brief`. Expect: a line `SMOKE pass=1 fail=1 pending=0`.

- [ ] **Step 2: Run.** `bun test fanout/tests/smoke.test.ts`. Expected: FAIL (no `smoke` event).
- [ ] **Step 3: Implement smoke tests and promotion on first use.**
  - `upkeep/smoke.ts`: the smoke run, the pass test, the budgets, the 7-day retry rule and the state lines; register the step.
  - `pick.ts` and `state.ts`: proven, trial and gone rules (Call 12), last-of-tier ordering, the one-at-a-time lease check.
  - `run.ts`: `first_use` on the first `ok` job with a changed file of a paid trial row, and on its failure; `status.ts`: the two new lines.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): smoke tests and first-use promotion`.

### Task 34: Pattern learning

Repeated unknown errors become worker errors, with guardrails: harmless lines never count, learned rules rank below every built-in rule, and stale rules expire.

**Files:**

- Create: `fanout/src/upkeep/patterns.ts`
- Modify: `fanout/src/classify.ts` (read `learned/patterns.json`, rank last), `fanout/src/commands/upkeep.ts`
- Test: `fanout/tests/patterns.test.ts`

**Behaviour** (Call 18).

- Signature: the last line of an `unknown` job end's `stderr_tail` that does not match `patterns/denylist.json`, passed through `normalizeSignature()`; no such line means no signature.
- A signature with at least 3 matches across at least 2 chains (distinct `root`) for one harness within the 30-day window is adopted: a `pattern_learned` event {harness, regex, outcome `worker_error`} and an entry `{ id: "learned-<hash>", harness, re, outcome, adopted_at, last_match }` in `learned/patterns.json` (atomic write). Adopted signatures are not added twice.
- Classification order is the adapter rules, then `generic.json`, then learned rules, so a learned rule never overrides a built-in limit rule. A job end that matched a learned rule records its id in `pattern`.
- `last_match` is the latest `job_end` whose `pattern` is the rule's id, else `adopted_at`. A rule with no match for 60 days is removed and a `pattern_expired` event {id} is appended.

- [ ] **Step 1: Write the failing tests** `fanout/tests/patterns.test.ts` (private catalog retiring the paid rows; the `unknown_error` scenario prints `kaboom 42`; the step is run as `upkeep --only patterns`):
- `three matches across two chains are learned`. Input: run A with script `fake/f1-a` `['unknown_error', 'unknown_error']` (two matches, one chain); run B at a later time with `['unknown_error', 'ok']` (one match, a second chain); upkeep. Expect: one `pattern_learned` event {harness: 'fake', outcome: 'worker_error'} whose `regex` matches `kaboom 99` and does not match `kaboom`; `learned('patterns.json')` has one entry with an `id` starting `learned-`.
- `two chains are required`. Input: one run with script `fake/f1-a` and `fake/f1-b` each `['unknown_error', 'unknown_error']` (four matches in one chain); upkeep. Expect: no `pattern_learned` event.
- `fewer than three matches are not learned`. Input: run A only (two matches); upkeep. Expect: no `pattern_learned` event.
- `the denylist is skipped`. Input: scenario `custom_error` with `FAKE_STDERR` equal to `kaboom 43` then a newline then `[claude-code:unrecognized_model]`, three runs across two chains; upkeep. Expect: the learned regex matches `kaboom 7` and not `unrecognized_model`. Input: stderr that is only `[claude-code:unrecognized_model]`, the same three runs. Expect: nothing learned.
- `running the step again learns nothing new`. Input: upkeep twice after a learn. Expect: still one `pattern_learned` event and one entry.
- `after learning, the error is a worker error`. Input: after the first test, `RUN` with script `fake/f1-a` `['unknown_error']`. Expect: stdout has no `RETRY` line; `job_end` {outcome: 'worker_error', pattern: <the learned id>}; one `limit_hit` with source `backoff`; `FALLBACK fake/f1-a worker_error -> fake/f1-b`.
- `a learned rule never outranks a built-in rule`. Input: write `learned/patterns.json` with `{ "rules": [{ "id": "learned-x", "harness": "fake", "re": "HTTP 429", "outcome": "worker_error", "adopted_at": "2026-11-15T00:00:00.000Z", "last_match": "2026-11-15T00:00:00.000Z" }] }`; `RUN` with script `['rate_limited']`. Expect: `job_end` {outcome: 'rate_limited', pattern: 'gen-429'}.
- `learned rules are per harness`. Input: the learned rule for `fake`; `RUN` where `fake2/f1-c` is first (private csv retiring `fake,*`) with `unknown_error`. Expect: the outcome is `unknown` and a `RETRY` line appears.
- `rules expire after 60 days without a match`. Input: three entries with `last_match` 61 days, 59 days and 1 day before `FANOUT_NOW`; upkeep. Expect: only the 61-day entry is removed; one `pattern_expired` event {id}.
- `a recent match keeps a rule alive`. Input: an entry with `adopted_at` 90 days ago and a `job_end` with `pattern` equal to its id 2 days ago. Expect: upkeep keeps it.

- [ ] **Step 2: Run.** `bun test fanout/tests/patterns.test.ts`. Expected: FAIL (no `pattern_learned` event).
- [ ] **Step 3: Implement pattern learning.**
  - `upkeep/patterns.ts`: the signature pass, the adoption rule, the expiry; register the step.
  - `classify.ts`: load `learned/patterns.json` as the last rule layer and record the id in `pattern`.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): learn error patterns with guardrails`.

### Task 35: Housekeeping

**Files:**

- Create: `fanout/src/upkeep/housekeeping.ts`
- Modify: `fanout/src/commands/upkeep.ts`
- Test: `fanout/tests/housekeeping.test.ts`

**Behaviour.** The upkeep step (a) reaps stale leases (Task 23); (b) removes attempt worktrees older than 7 days (read the sibling `<worktree>.fanout-repo` marker; `git -C <repo> worktree remove --force <path>`, falling back to deleting the folder plus `git worktree prune`; delete `refs/fanout/<root>` when no worktree of that root remains); (c) deletes `logs/*` older than 14 days and `patches/*` older than 30 days; (d) deletes `smoke/*` older than 1 day. Ages come from file mtime and `FANOUT_NOW`.

- [ ] **Step 1: Write the failing tests** `fanout/tests/housekeeping.test.ts` (create real worktrees through `fanout run`, then run `upkeep --only housekeeping` at an advanced `FANOUT_NOW`):
- `old worktrees go and young ones stay`. Input: two runs 2 days apart; upkeep at the first run plus 8 days (the second is 6 days old). Expect: `git worktree list` in the repo no longer shows the first worktree and still shows the second; the first folder is gone.
- `the ref goes with the last worktree`. Input: the same. Expect: `git for-each-ref refs/fanout/` lists only the second chain's ref.
- `logs and patches follow their ages`. Input: files in `logs/` and `patches/` with mtimes 13 and 15 days, and 29 and 31 days, before `FANOUT_NOW`. Expect: the 15-day log and the 31-day patch are deleted; the others remain.
- `smoke folders last one day`. Input: `smoke/a` 2 days old and `smoke/b` 2 hours old. Expect: only `smoke/a` is deleted.
- `a worktree whose repo is gone is removed without error`. Input: delete the source repo, then upkeep at +8 days. Expect: exit 0; the worktree folder is gone; the `upkeep` event is `ok`.
- `a stale lease is reaped once`. Input: a lease with a dead pid and no events; upkeep twice. Expect: the lease file is gone after the first call and the `upkeep` detail of the second reports `0 leases`.

- [ ] **Step 2: Run.** `bun test fanout/tests/housekeeping.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `housekeeping.ts` with the four duties above and register the step.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): upkeep housekeeping step`.

## Phase 3: benchmarks, adapters, report

Phase 3 adds the benchmark sources, the three proxied and local adapters that need real fixtures, and the report.

### Task 36: Artificial Analysis refresh

Upkeep refreshes the Intelligence Index and the vendor prices daily from the Artificial Analysis Data API. A missing key or a failing API keeps the old values and never touches a run.

**Files:**

- Create: `fanout/src/upkeep/benchmarks.ts`
- Modify: `fanout/src/{benchmarks,catalog,status}.ts`, `fanout/src/commands/upkeep.ts` (register the step), `README.md` (attribution)
- Test: `fanout/tests/benchmarks-aa.test.ts`

**Interfaces:**

- Produces: `learned/benchmarks.json` `{ refreshed_at, aa_index_version, values: { "<h>/<m>": { aa_intel?, aa_price_in?, aa_price_out?, as_of } } }`; `readBenchmarks(): Record<key, Record<metric, number>>` (layers: `catalog/benchmarks.seed.json`, then `learned/benchmarks.json`).

Official docs: https://artificialanalysis.ai/data-api/docs and https://artificialanalysis.ai/data-api/docs/reference (read 2026-11-15; Open question 1). Credit: "Attribution is required for all use of our free API"; a visible byline or footer link is sufficient.

**Behaviour** (the response shape is from the vendor's reference page; the builder reads it again before coding).

- The step runs when `learned/benchmarks.json` has no `refreshed_at` or it is more than 24 hours old; otherwise it is `skipped` with detail `refreshed <n>h ago`.
- Key: `AA_API_KEY` from the environment or parsed (not sourced) from the `FANOUT_SECRETS` file. No key: the step is `skipped` with detail `no AA_API_KEY`, `status.json.benchmarks_note` says so, and no request is made.
- Request: `GET <FANOUT_AA_URL, default https://artificialanalysis.ai/api/v2/language/models/free>?page=<n>` with header `x-api-key`, 20 s timeout, following `pagination.has_more` up to 5 pages. Each `data[]` item is read for `slug`, `name`, `evaluations.artificial_analysis_intelligence_index`, `pricing.price_1m_input_tokens` and `pricing.price_1m_output_tokens`; the envelope's `intelligence_index_version` is stored.
- Matching: a catalog row matches by `aa_slug` equal to `slug`, else `normalize(name)` equal to the normalised alias or model id. Each matched row gets `aa_intel` and the two prices in `learned/benchmarks.json` (atomic write) and one `benchmark` event {model, source `aa`, metric, value, as_of}. AA prices fill only the **missing** prices of auto rows; a default or private price is never overridden.
- An HTTP error, a timeout, invalid JSON, `data` that is not an array, or no matched row makes the step `failed` (detail `HTTP 429` and the like, never the key); the old values stay and `refreshed_at` does not move.
- `status --brief` prints `BENCH aa skipped: AA_API_KEY missing (values from <date or none>)` or `BENCH aa failed: <detail> (values from <date or none>)` while the last attempt did not succeed, and `BENCH aa stale: last refresh <n> days ago` when the last success is more than 3 days old.
- The root `README.md` credits the source with a link: `Benchmark data: [Artificial Analysis](https://artificialanalysis.ai/)`.

- [ ] **Step 1: Write the failing tests** `fanout/tests/benchmarks-aa.test.ts` (a `Bun.serve` fake AA server counts requests and checks the header; `FANOUT_AA_URL` points at it; a secrets file named by `FANOUT_SECRETS` holds `AA_API_KEY=<fake key built at runtime>`; the step is run as `upkeep --only benchmarks`; private csv `harness,model,aa_slug\nfake,f1-a,slug-a`):
- `a good refresh stores values from two pages`. Input: page 1 `{"tier":"free","intelligence_index_version":5,"pagination":{"page":1,"page_size":1,"total_pages":2,"has_more":true},"data":[{"slug":"slug-a","name":"A","evaluations":{"artificial_analysis_intelligence_index":31.7},"pricing":{"price_1m_input_tokens":0.4,"price_1m_output_tokens":1.2}}]}`, page 2 with a `fake/f1-b` match by name and `has_more` false. Expect: the server saw `x-api-key` equal to the fake key on both requests (`?page=1`, `?page=2`); `benchmark` events {model: 'fake/f1-a', source: 'aa', metric: 'aa_intel', value: 31.7}; `learned('benchmarks.json')` has `aa_index_version: 5`, `refreshed_at` equal to `FANOUT_NOW`, and `values['fake/f1-a'].aa_intel` 31.7.
- `matching by normalised name when there is no slug`. Input: a page whose item is `{"slug":"other","name":"F1-B", ...}` and `fake/f1-b` with no `aa_slug`. Expect: a value is stored for `fake/f1-b`.
- `a missing key is skipped and reported` (Review focus 5). Input: no `AA_API_KEY` anywhere. Expect: the `upkeep` event {step: 'benchmarks', status: 'skipped', detail: 'no AA_API_KEY'}; the server saw 0 requests; `status --brief` has `BENCH aa skipped: AA_API_KEY missing (values from none)`; a following `RUN` exits 0.
- `an API error keeps the old values and says so`. Input: `learned/benchmarks.json` seeded with `fake/f1-a` `aa_intel` 40 and `refreshed_at` `2026-11-10T00:00:00.000Z`; the server answers 429, then 500, then `not json`, then hangs (`FANOUT_AA_TIMEOUT_S=1`), one upkeep each. Expect: each `upkeep` event is `failed` with details `HTTP 429`, `HTTP 500`, `invalid JSON` and `timeout`; the stored value stays 40; `status --brief` has `BENCH aa failed: HTTP 429 (values from 2026-11-10)` after the first.
- `a stale snapshot is shown in status`. Input: `learned/benchmarks.json` with `refreshed_at` 4 days before `FANOUT_NOW` and no upkeep run since. Expect: `status --brief` contains `BENCH aa stale: last refresh 4 days ago`; with `refreshed_at` 2 days ago the line is absent.
- `a refresh that is not due is skipped`. Input: `refreshed_at` 2 hours before `FANOUT_NOW`, then 25 hours before. Expect: `skipped` with detail `refreshed 2h ago` and no request; then a refresh with one request.
- `no matching row fails without touching the file`. Input: a page whose items match nothing. Expect: the step is `failed` with detail `no rows matched`; the file is unchanged.
- `AA prices fill only missing prices of auto rows`. Input: `learned/catalog.auto.json` with `{harness: 'fake2', model: 'p-new', tier: 2, billing: 'paid', status: 'trial', aa_slug: 'slug-new'}` (no prices); a page giving `slug-new` input 0.5 and output 1.5, and giving `fake2/f1-paid` (`aa_slug` set by the private csv) input 9 and output 9. Expect: after the step `pick --all --kind edit` lists `fake2/p-new` (now priced) with `status=trial`; the `PAID` line for `transcribe` still reads `$0.07` (default prices stay).
- `the key appears nowhere`. Input: a good refresh. Expect: a `grep -r <key>` over the sandbox home and the captured stdout and stderr finds nothing.
- `the README credits the source`. Input: read `README.md`. Expect: it contains `[Artificial Analysis](https://artificialanalysis.ai/)`.

- [ ] **Step 2: Run.** `bun test fanout/tests/benchmarks-aa.test.ts`. Expected: FAIL (no `benchmark` events).
- [ ] **Step 3: Implement the Artificial Analysis refresh.**
  - `upkeep/benchmarks.ts`: the due check, the key lookup, the paged request, the match, the atomic write, the failure details; register the step.
  - `benchmarks.ts`: `readBenchmarks()` over the seed and the learned file; `catalog.ts`: fill auto-row prices; `status.ts`: the `BENCH` line.
  - Add the credit line to `README.md`.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): add artificial analysis refresh`.

### Task 37: Benchmark import and benchmark-aware ranking

Arena WebDev and FrontierCode 2.0 have no API, so an agent produces a CSV on request and `fanout benchmarks import` loads it. The ranking then uses the metrics that scored rows share.

**Files:**

- Create: `fanout/src/commands/benchmarks.ts`, `fanout/catalog/benchmarks.seed.json`
- Modify: `fanout/src/{benchmarks,rank,cli}.ts`
- Test: `fanout/tests/benchmarks-import.test.ts`

**Interfaces:**

- Consumes: `readBenchmarks()` (Task 36).
- Produces: the benchmark key of `compareRows()`: within a tier, the shared metric set `S` is the metrics present on every row of that tier that has any benchmark data; a row's score is the mean over `S` of `value / max(value over the tier's rows)`; rows with no data rank after rows with data; an empty `S` ties every row.

**Behaviour.**

- `fanout benchmarks import <file>`: CSV with the header `name,metric,value,as_of` (anything else exits 2 with `header must be name,metric,value,as_of`); `metric` is `arena_webdev` (value 800 to 2500) or `frontiercode2` (0 to 100). Names match catalog rows by `normalize(name)` against the aliases, `aa_slug` or model id. It prints `UNMATCHED <name>` for a name with no row, `SKIPPED row <n>: <reason>` for an invalid row, then `IMPORTED <n> values for <m> models; skipped <k>`; exit 0 when at least one value was imported, else 1. Each value appends a `benchmark` event {model, source `import`, metric, value, as_of} and merges into `learned/benchmarks.json` without touching the other metrics. It never uses the network and no upkeep step calls it.
- `benchmarks.seed.json` is generated, never hand-typed, from `~/.local/share/cc-duckdb/fanout_models.csv` (skip `ref` rows and empty cells): `{ "<harness>/<model>": { "aa_intel": n, "frontiercode2": n, "arena_webdev": n, "as_of": "2026-11-15" } }`. It is the lowest benchmark layer: the learned file overrides it per metric.

- [ ] **Step 1: Write the failing tests** `fanout/tests/benchmarks-import.test.ts`:
- `a good import`. Input: a CSV `name,metric,value,as_of\nf1-a,arena_webdev,1600,2026-11-15\nF1-B,frontiercode2,30,2026-11-15\nghost,arena_webdev,1500,2026-11-15`. Expect: stdout `UNMATCHED ghost` and `IMPORTED 2 values for 2 models; skipped 0`, exit 0; two `benchmark` events with `source: 'import'`; `learned('benchmarks.json').values['fake/f1-a'].arena_webdev` 1600.
- `bad rows are skipped with a reason`. Input: `f1-a,arena_webdev,5000,2026-11-15` and `f1-b,frontiercode2,120,2026-11-15`. Expect: `SKIPPED row 1: arena_webdev must be 800 to 2500`, `SKIPPED row 2: frontiercode2 must be 0 to 100`, `IMPORTED 0 values for 0 models; skipped 2`, exit 1.
- `a bad header exits 2`. Input: a CSV with the header `model,score`. Expect: exit 2, stderr `header must be name,metric,value,as_of`.
- `an import keeps other metrics`. Input: `learned/benchmarks.json` with `fake/f1-a` `aa_intel` 30; import an `arena_webdev` value for it. Expect: both metrics are present.
- `ranking uses the metrics every scored row shares`. Input: `learned/benchmarks.json` with `fake/f1-a` {aa_intel: 30, arena_webdev: 1600}, `fake/f1-b` {aa_intel: 40, arena_webdev: 1500}, `fake2/f1-c` {aa_intel: 35}; `pick --all`. Expect: tier 1 subscription order `fake/f1-b`, `fake2/f1-c`, `fake/f1-a` (the shared metric is `aa_intel` alone: scores 1.0, 0.875, 0.75).
- `rows without data rank after rows with data`. Input: only `fake/f1-b` has a value. Expect: `fake/f1-b`, then `fake/f1-a`, then `fake2/f1-c`.
- `an empty shared set ties every row`. Input: `fake/f1-a` has only `aa_intel`, `fake/f1-b` has only `arena_webdev`. Expect: `fake/f1-a`, `fake/f1-b`, `fake2/f1-c` (key order).
- `benchmarks never beat tier or billing`. Input: the highest score on a paid tier 1 row and the lowest on every subscription tier 1 row. Expect: the paid row is still after all tier 1 subscription rows and before tier 2.
- `the learned file overrides the seed per metric`. Input: `{ noCatalog: true }`; `learned/benchmarks.json` sets `codex/gpt-6-luna` `aa_intel` 99 while the seed says 28; the seed also holds `frontiercode2`. Expect: `pick --all --kind transcribe --harness codex` orders by the learned value (a row scored 99 first among tier 1 subscription rows that share `aa_intel`).
- `the seed is generated, not typed`. Input: `fanout/catalog/benchmarks.seed.json`. Expect: no `ref` harness key; every value is a number; `as_of` is `2026-11-15`.

- [ ] **Step 2: Run.** `bun test fanout/tests/benchmarks-import.test.ts`. Expected: FAIL, "unknown command benchmarks".
- [ ] **Step 3: Implement benchmark import and benchmark-aware ranking.**
  - `commands/benchmarks.ts`: the `import` subcommand with the validation and the merge; register in `cli.ts`.
  - `rank.ts`: the shared-metric benchmark key; `benchmarks.ts`: the seed layer.
  - Generate `benchmarks.seed.json` with a Bun one-liner over `~/.local/share/cc-duckdb/fanout_models.csv` and commit the result.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): benchmark import and shared ranking`.

### Task 38: The user's results outrank benchmarks

After 20 judged jobs for a model and task kind, the ledger's own success rate and cost per accepted job decide that pair.

**Files:**

- Modify: `fanout/src/{rank,state}.ts`, `fanout/tests/helpers/sandbox.ts` (already offers `seedLearned`)
- Test: `fanout/tests/user-results.test.ts`

**Behaviour** (Call 11).

- `state.ts` reads the `judged` lines of `learned/state.jsonl`; the last line per `job` counts. For a `(key, task_kind)` pair with at least 20 judged jobs: `rate = accepted / judged`, `costPerAccepted = sum(cost_usd) / accepted` (infinite when none accepted).
- Band key placed before the benchmark key: 0 for a pair with `rate >= 0.5`, 1 for no user score, 2 for `rate < 0.5`. Within bands 0 and 2 rows sort by `rate` descending, then `costPerAccepted` ascending. Benchmarks apply only inside band 1. The pair is the chunk's `--kind`.

- [ ] **Step 1: Write the failing tests** `fanout/tests/user-results.test.ts` (`judged` lines seeded with `sb.seedLearned('state.jsonl', [...])`, each `{"kind":"judged","key":"fake/f1-b","job":"J<n>","task_kind":"transcribe","accepted":true,"cost_usd":0}`; benchmarks seeded so that `fake/f1-a` scores higher than `fake/f1-b`):
- `20 judged jobs at 90% put the row first`. Input: 20 lines for `fake/f1-b` (18 accepted); `pick --all --kind transcribe`. Expect: `fake/f1-b` before `fake/f1-a` in tier 1.
- `19 judged jobs change nothing`. Input: 19 lines. Expect: `fake/f1-a` before `fake/f1-b` (benchmarks decide).
- `a poor record goes last in its tier`. Input: 20 lines with 8 accepted (40%). Expect: `fake/f1-b` after `fake/f1-a` and after `fake2/f1-c` among tier 1 subscription rows.
- `exactly 50% is still band 0`. Input: 20 lines with 10 accepted. Expect: `fake/f1-b` first.
- `two scored rows sort by rate, then by cost per accepted job`. Input: 20 lines each for `fake/f1-a` (19 accepted) and `fake/f1-b` (17 accepted). Expect: `fake/f1-a` first. Input: both 18 accepted, `cost_usd` 0.01 on every `f1-a` line and 0 on `f1-b`. Expect: `fake/f1-b` first.
- `the pair is per task kind`. Input: 20 judged `edit` lines. Expect: `pick --all --kind transcribe` ignores them; `pick --all --kind edit` honours them.
- `a job judged twice counts once, by its last line`. Input: 19 distinct jobs for `fake/f1-b`, all accepted, where `J1` has two lines (`accepted: false`, then `accepted: true`), so there are 20 lines but 19 jobs. Expect: no user score, so `fake/f1-a` is still before `fake/f1-b` (benchmarks decide). Input: add a 20th distinct job. Expect: `fake/f1-b` first.
- `tier and billing still dominate`. Input: a tier 2 row with a perfect record, `pick --all --kind transcribe`. Expect: it stays after every tier 1 row.
- `the harness preference still comes first`. Input: `--harness fake2` with the perfect record on `fake/f1-b`. Expect: `fake2/f1-c` first.

- [ ] **Step 2: Run.** `bun test fanout/tests/user-results.test.ts`. Expected: FAIL (benchmark order ignores the judged lines).
- [ ] **Step 3: Implement** the `judged` reader in `state.ts` and the band, rate and cost keys in `rank.ts`.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): user results outrank benchmarks`.

### Task 39: River and OpenRouter adapters, and the data class from the upstream

Both go through CLIProxyAPI (`~/.cli-proxy-api/config.yaml`) using the Task 29 base. The proxy hides the vendor behind an alias, so the data class must come from the **upstream model name** in the config: the alias `muse-spark-1.3` maps to `meta/muse-spark-1.3-contributor`, and Meta trains on contributor input.

**Files:**

- Create: `fanout/src/adapters/{proxy,river,claude-fanout}.ts`, `fanout/patterns/{river,claude-fanout}.json`, `fanout/tests/fixtures/proxy/{config.yaml.tpl,river-402.txt,river-concurrency.txt,auth-unavailable.txt,openrouter-models.json}` (synthetic; short placeholder tokens under 20 characters so the hygiene scan stays quiet), `fanout/tests/adapter-proxy.test.ts`
- Modify: `fanout/src/adapters/index.ts`, `fanout/src/dataclass.ts` (the OpenRouter unknown-upstream rule)

Official docs: https://bun.sh/docs/api/yaml, https://github.com/router-for-me/CLIProxyAPI, https://openrouter.ai/docs/api-reference/list-available-models (public list, no key).

**Behaviour.**

- `proxy.ts`: `proxyDir()` is `FANOUT_PROXY_DIR` or `~/.cli-proxy-api`; `readProxyConfig()` parses `config.yaml` with `Bun.YAML.parse` into `{ port, token (api-keys[0]), providers: [{ name, baseUrl, models: [{ name, alias? }] }] }` and its errors never contain the token; `upstreamOf(provider, aliasOrName)` returns the `name` of the model entry whose `alias` (else `name`) matches; `ensureProxy()` TCP-checks `127.0.0.1:<port>`, and when it is down starts `${CLIPROXY_BIN:-~/.local/opt/cliproxyapi/cli-proxy-api} -config <dir>/config.yaml` detached, appending to `<dir>/proxy.log`, waits up to 6 s and returns whether it is up; `proxyModels()` is `GET /v1/models` with the bearer token.
- River (`name: "river"`): base `http://127.0.0.1:<port>`, token from the proxy config; models are the `river` provider's aliases; efforts `low`, `high`, `max` (`none` for DeepSeek only; never `medium` or `xhigh`, which return HTTP 400); billing `paid`; defaults timeout 1500, max turns 40; `upstream()` reads the `river` provider. Patterns: 402 `credits_exhausted` (account); 429 with `model_concurrency` `rate_limited` with `cooldownS` 30; `context_length_exceeded`, 413 and 422 `job_error`; 404 `model_unavailable`; 401 and 403 `auth_error`; plus the mined rules.
- claude-fanout (`name: "claude-fanout"`, OpenRouter through the proxy): models are the `openrouter` provider's aliases; an alias outside that block throws `SkipCandidate` (`NOTE claude-fanout: <alias> is not an openrouter alias`); `listModels` adds prices from the public OpenRouter model list (`FANOUT_OPENROUTER_URL`, default `https://openrouter.ai/api/v1/models`; the item's `pricing.prompt` and `pricing.completion` are USD per token, so multiply by 1e6), and a model without a price stays unpriced; patterns `auth_unavailable` `auth_error`, exit 124 or `terminal_reason":"api_error` `worker_error`, plus the mined rules.
- Data class (Call 16): `rowClass()` uses `adapter.upstream()`; for `claude-fanout` an upstream that is not the `upstream` cell of an `any` catalog row is `public-only`. River and ModelScope upstreams are class `any` unless they match the contributor, stealth or `:free` rule.
- Both: quick `preflight` = `claude` on `PATH` and a readable proxy config; full = `ensureProxy()` and the alias is listed by `/v1/models`. A proxy that cannot be reached skips the candidate with `NOTE proxy not reachable`.

- [ ] **Step 1: Write the failing tests** `fanout/tests/adapter-proxy.test.ts` (a `Bun.serve` fake proxy on a free port; `FANOUT_PROXY_DIR` holds `config.yaml` rendered from the template with that port. The config has an `openrouter` block with the aliases `muse-spark-1.3` (upstream `meta/muse-spark-1.3-contributor`), `glm-5.3-flash` (upstream `z-ai/glm-5.3-flash`) and `mystery` (upstream `acme/mystery-model`), and a `river` block with `deepseek-v4.1-flash-river` and `glm-5.3-flash-river`; stub `claude` as in Task 29; the catalog has `claude-fanout` rows for the three aliases with `data_class` `any` and the `upstream` cells `meta/muse-spark-1.3-contributor`, `z-ai/glm-5.3-flash` and empty, the default `river` rows, the default `meta/muse-spark-1.3` row, and `fake/f1-a`):
- `the alias muse-spark-1.3 is public-only because its upstream is a contributor model` (Review focus 2). Input: a private chunk; `pick --all`. Expect: no `claude-fanout/muse-spark-1.3` line, while `meta/muse-spark-1.3` (the direct, non-contributor model) is listed with `class=any`.
- `naming the alias does not get around it`. Input: private chunk, `run --harness claude-fanout --model muse-spark-1.3`. Expect: exit 3, stdout `REFUSED claude-fanout/muse-spark-1.3 is public-only and this chunk is private`; the ledger is empty. Input: `--pin` as well. Expect: the same refusal.
- `a public chunk may use it`. Input: `run --public --harness claude-fanout --model muse-spark-1.3` with the stub. Expect: exit 0; the stub's recorded `ANTHROPIC_MODEL` is `muse-spark-1.3`.
- `the class follows the config, not the catalog`. Input: edit the config so that `glm-5.3-flash` maps to `acme/other-model`; private `pick --all`. Expect: no `claude-fanout/glm-5.3-flash` (its catalog `upstream` no longer matches, so it is `public-only`). Restore the config: it is listed again.
- `an unknown OpenRouter upstream is public-only`. Input: private `pick --all`. Expect: no `claude-fanout/mystery`; `--public` lists it.
- `river rows stay available for private data`. Input: private `pick --all`. Expect: `river/deepseek-v4.1-flash-river` and `river/glm-5.3-flash-river` are listed with `class=any`.
- `river dry-run: argv, environment and efforts`. Input: `run --dry-run --harness river --model deepseek-v4.1-flash-river ...`. Expect: `argv` has `--effort low`; the line does not contain the proxy token (it is env only). Input: `--effort medium`. Expect: exit 2, stderr `effort medium is not one of low|high|max|none for river/deepseek-v4.1-flash-river`.
- `river run: tokens are summed and the cost is computed`. Input: the stub prints a result with `modelUsage` {inputTokens 1000000, cacheReadInputTokens 0, outputTokens 100000} for the River model. Expect: stdout `COST paid API (river/deepseek-v4.1-flash-river): estimated $0.02, actual $0.17 (computed from tokens)` (the prior estimate is `(100000 x 0.12 + 200000 x 0.0024 + 10000 x 0.48) / 1e6 = 0.01728`; the actual is `(1e6 x 0.12 + 1e5 x 0.48) / 1e6 = 0.168`); the proxy token appears in no output or ledger file.
- `402 is account-scoped credits`. Input: `FIXTURE=river-402.txt`, `STUB_EXIT=1`. Expect: `limit_hit` {outcome: 'credits_exhausted', scope: 'account'}; a `FALLBACK river/... -> fake/f1-a` line.
- `model_concurrency backs off 30 seconds`. Input: `FIXTURE=river-concurrency.txt`, `at('2026-11-15T01:00:00Z')`. Expect: `limit_hit` {outcome: 'rate_limited', source: 'backoff', until: '2026-11-15T01:00:30.000Z'}.
- `413, 422 and context length are job errors`. Input: three fixtures with those texts. Expect: each run ends `outcome=job_error` with one `job_start`.
- `claude-fanout refuses an alias outside the openrouter block`. Input: `run --harness claude-fanout --model glm-5.3-flash-river`. Expect: stdout `NOTE claude-fanout: glm-5.3-flash-river is not an openrouter alias`; the run continues on another candidate.
- `a proxy that is down is skipped, not thrown`. Input: nothing listening on the port and `CLIPROXY_BIN=/bin/false`. Expect: stdout contains `NOTE proxy not reachable`; the run continues on `fake/f1-a`.
- `ensureProxy starts the binary when the port is closed`. Input: `CLIPROXY_BIN` is a stub script that listens on the configured port; full preflight (`doctor`). Expect: `PASS adapter-river:`.
- `discovery prices OpenRouter models and leaves unpriced ones unrouted`. Input: `FANOUT_OPENROUTER_URL` serves `{"data":[{"id":"qwen/qwen3.7-flash","pricing":{"prompt":"0.00000003","completion":"0.00000013"}},{"id":"acme/mystery-model","pricing":{}}]}`; `upkeep --only discover`. Expect: an auto or default row for `qwen3.7-flash` with `price_in` 0.03 and `price_out` 0.13; none routed for `mystery`.
- `the mined fixtures classify as recorded`. Input: as in Task 27 for `river` and `claude-fanout`. Expect: each `job_end.outcome` equals the recorded `outcome`.

- [ ] **Step 2: Run.** `bun test fanout/tests/adapter-proxy.test.ts`. Expected: FAIL (`river` is not a registered adapter).
- [ ] **Step 3: Implement river and OpenRouter adapters, and the data class from the upstream.**
  - `proxy.ts`: the config reader, `upstreamOf()`, `ensureProxy()`, `proxyModels()`.
  - `river.ts` and `claude-fanout.ts` on the Task 29 base, with `upstream()`, the patterns and the OpenRouter price lookup.
  - `dataclass.ts`: the unknown-OpenRouter-upstream rule; register both adapters.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): river and openrouter adapters`.

### Task 40: ModelScope adapter

ModelScope bills Magicubes (MC) per upstream call, not tokens. Knowledge from `~/CS/modelscope-fanout/SKILL.md`, `README.md` and `scripts/worker.py`.

**Files:**

- Create: `fanout/src/adapters/modelscope.ts`, `fanout/patterns/modelscope.json`, `fanout/tests/fixtures/modelscope/{config.yaml.tpl,proxy.log.txt}` (synthetic gin lines), `fanout/tests/adapter-modelscope.test.ts`
- Modify: `fanout/src/adapters/index.ts`

**Behaviour.**

- Routing validation, as in `worker.py`: exactly one provider named `modelscope`; base URL `https://api-inference.modelscope.ai/v1`; every model has a `name` (upstream id) and an optional `alias`; aliases unique; no collision with another provider's names or aliases; `api-keys[0]` present; port an integer in 1 to 65535. Any violation makes `preflight` return `{ok:false, outcome:'auth_error', detail:'invalid ModelScope routing config'}` (the config content is never echoed). A route is live when `GET /v1/models` lists it with `owned_by` `modelscope`; a model that is not a live ModelScope route throws `SkipCandidate("not a live ModelScope route")`, never a hidden fallback to another provider. The route passed to `claude` is the model itself when it is a live route, else the first alias (sorted) whose upstream name matches.
- `build`: argv `["claude","-p","--model",route,"--setting-sources","","--strict-mcp-config","--mcp-config","{\"mcpServers\":{}}","--settings","{\"disableAllHooks\":true}","--tools","Read,Edit,Write,Glob,Grep","--permission-mode","acceptEdits","--max-turns",maxTurns,"--output-format","json","--no-session-persistence"]`; no `--effort` (ModelScope discards reasoning effort). Env: `CLAUDE_CONFIG_DIR=$HOME/.modelscope-fanout` (mode 0700), `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, the three default-model variables and `CLAUDE_CODE_SUBAGENT_MODEL` = route, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. The environment allowlist (Task 7) already keeps the caller's `ANTHROPIC_*`, `OPENAI_*` and `OPENROUTER_*` out. `stdinText` = `Your working directory is <cwd>. Resolve all relative output paths inside that directory. Never guess a home-directory path.`, a blank line, then the brief. Defaults: timeout 600 s, max turns 8. `--bypass` and `--allow` are ignored with a `NOTE` (the parent runs commands and tests). `proxyBacked` is true.
- Success only when the last JSON line has `type: "result"`, `subtype: "success"` and no `is_error`; exit 0 without that is `worker_error`; `subtype` `error_max_turns` and HTTP 413 or 422 are `job_error`. `permission_denials` feeds `DENIALS=<n>`. `usage()` is `undefined`.
- `measure({startMs, endMs, overlapped})`: count the log lines `[YYYY-MM-DD HH:MM:SS] [..] [..] [gin_logger.go:N] <status> | ... | POST "/v1/messages..."` in `<proxyDir>/proxy.log` (local time) whose time is in `[startMs, endMs + 2 s]`, excluding `/v1/messages/count_tokens`. Return `'unmeasured'` when the job overlapped another proxy-backed job, the log is missing or older than `endMs`, or the file has no parsable gin lines. Reason: the log has no model field, so attribution works only for a lone job; internal proxy retries are not visible, so the count can be low.
- `listModels`: the provider's upstream names that are live; billing `per_call`, `priceCall` 2 (unverified tier); `priceCall` 1 only for rows the catalog says so (`Qwen/Qwen3.8-27B`). An explicit `--model` bypasses `min_brief_bytes` with `NOTE brief is smaller than the usual ModelScope chunk`.

- [ ] **Step 1: Write the failing tests** `fanout/tests/adapter-modelscope.test.ts` (fake proxy server and stub `claude` as in Task 39; the catalog has the default `modelscope/Qwen/Qwen3.8-27B` row and `fake/f1-a`; the config maps `Qwen/Qwen3.8-27B` to the alias `ms-qwen3.8-27b`):
- `the dry-run argv has no effort and the right tools`. Input: `run --dry-run --harness modelscope --model Qwen/Qwen3.8-27B ...` with a 7000-byte brief. Expect: `argv` contains `--tools`, `Read,Edit,Write,Glob,Grep`, `--no-session-persistence`, `--max-turns`, `8`, and no `--effort`.
- `the stub environment is clean and pinned`. Input: a run with the parent env `OPENROUTER_API_KEY=x` and `ANTHROPIC_MODEL=other`. Expect: the recorded env has `ANTHROPIC_MODEL=ms-qwen3.8-27b`, `CLAUDE_CONFIG_DIR` ending `/.modelscope-fanout`, and no `OPENROUTER_API_KEY`.
- `stdin starts with the working-directory sentence`. Input: a run. Expect: the recorded stdin starts `Your working directory is ` and its first paragraph ends `Never guess a home-directory path.`, followed by the brief.
- `a bad routing config is refused without echoing it`. Input: configs with two `modelscope` providers; with a duplicate alias; with an alias that equals an `openrouter` alias. Expect: stdout contains `NOTE modelscope: invalid ModelScope routing config` and never the unique marker string placed in the config.
- `a model that is not a live route is skipped, never rerouted`. Input: `--model ms-not-live`. Expect: `NOTE modelscope: not a live ModelScope route`; no `job_start` on another provider's route.
- `per-call pricing and the chunk-size rule`. Input: `pick` with a 7000-byte brief; `pick` with a 100-byte brief. Expect: `PAID modelscope/Qwen/Qwen3.8-27B ESTIMATE 8 MC (8 turns x 1 MC, upper-bound guess)` when ModelScope is the first paid or per-call candidate (retire the others in the private csv); with 100 bytes `pick --all` has no `modelscope/` line.
- `six calls in the window are counted`. Input: `proxy.log` with six `POST "/v1/messages"` gin lines inside the job window, one outside it, and one `POST "/v1/messages/count_tokens"` inside it. Expect: stdout `COST per-call (modelscope/Qwen/Qwen3.8-27B): estimated 8 MC (8 turns x 1 MC, upper-bound guess), actual 6 calls = 6 MC (counted from proxy log)`.
- `unmeasurable cases say so`. Input: an overlapping run; a missing log; a log older than the job end; a log with no gin lines. Expect: each prints `actual unmeasured`.
- `exit 0 without a success result is a worker error`. Input: a result with `is_error: true`; a result with `subtype: "error_max_turns"`. Expect: `outcome=worker_error`; `outcome=job_error`. Input: two `permission_denials`. Expect: `DENIALS=2`.
- `--model with a small brief runs with the note`. Input: `--model Qwen/Qwen3.8-27B` with a 100-byte brief. Expect: exit 0 and `NOTE brief is smaller than the usual ModelScope chunk`.
- `discovery tiers ModelScope models from benchmarks`. Input: `upkeep --only discover` with the fake proxy listing two live routes. Expect: auto rows with `billing: 'per_call'`, `price_call: 2`, and tiers from the benchmark rule.
- `the mined fixtures classify as recorded`. Input: as in Task 27 for `modelscope`. Expect: each `job_end.outcome` equals the recorded `outcome`.

- [ ] **Step 2: Run.** `bun test fanout/tests/adapter-modelscope.test.ts`. Expected: FAIL (`modelscope` is not a registered adapter).
- [ ] **Step 3: Implement** `modelscope.ts` (validation, route resolution, `build`, `classify`, `measure`, `listModels`), the patterns and fixtures, and register it.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): modelscope adapter`.

### Task 41: OpenCode adapter

**Files:**

- Create: `fanout/src/adapters/opencode.ts`, `fanout/patterns/opencode.json`, `fanout/tests/fixtures/opencode/{funds,deprecated,rejected,go-required}.txt`, `fanout/tests/adapter-opencode.test.ts`
- Modify: `fanout/src/adapters/index.ts`

**Behaviour.** Knowledge from `~/CS/opencode-fanout/SKILL.md`. `name: "opencode"`.

- `build`: argv `["opencode","run","--model",model,"--variant",effort,"--dir",cwd,<brief text>]` (no `--variant` when the efforts list is empty); **stdin is closed** (`stdinText: ""`), because an open stdin makes `opencode run` wait forever; env `OPENCODE_CONFIG_CONTENT={"small_model":"opencode/space-bunny-free"}` so the session-title model is free; `envAllow` `['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR']`. A brief over 120,000 bytes throws `SkipCandidate`. `--dir` is a hard boundary; the worktree already keeps inputs inside it.
- Patterns: `Insufficient account funds` `credits_exhausted`; `has been deprecated|Model is unavailable` `model_unavailable`; `An active OpenCode Go subscription is required` `auth_error`; `free tier can only be used from within OpenCode` `worker_error`; `permission requested: external_directory .* auto-rejecting` `worker_error` with `onExit0` (opencode exits 0 having done nothing); plus the mined rules.
- `listModels`: `opencode models`, lines `provider/model`; `opencode/*-free` is `free`, `opencode-go/*` is `subscription`, the rest `paid` (unpriced, so unrouted). `preflight`: quick = binary on `PATH`; full = `opencode models` exits 0. `usage()` is `undefined`.

- [ ] **Step 1: Write the failing tests** `fanout/tests/adapter-opencode.test.ts` (stub `opencode` records argv, its env and whether stdin is closed; the catalog has the two default `opencode` rows made `active` and `fake/f1-a`):
- `the dry-run argv and environment`. Input: `run --dry-run --harness opencode --model opencode/space-bunny-free ...`. Expect: `argv` starts `["opencode","run","--model","opencode/space-bunny-free","--dir"`, contains no `--variant`, and ends with the brief text.
- `stdin is closed`. Input: a stub that runs `cat` on stdin, `RUN --timeout 5`. Expect: the run ends before the timeout with `outcome=ok` (an open stdin would hang until it).
- `funds, deprecated and subscription texts map to outcomes`. Input: `funds.txt` (`Insufficient account funds`), `deprecated.txt` (`Model opencode/x has been deprecated`), `go-required.txt` (`An active OpenCode Go subscription is required`), `STUB_EXIT=1`. Expect: `credits_exhausted`, `model_unavailable`, `auth_error`.
- `a silent rejection on a clean exit is a worker error`. Input: `rejected.txt` (`permission requested: external_directory /x (auto-rejecting)`), `STUB_EXIT=0`. Expect: `job_end` {outcome: 'worker_error', exit: 0}.
- `a 130 KB brief skips the candidate`. Input: `sb.brief(undefined, 130000)`. Expect: `NOTE opencode: brief too large for opencode argv`; the run continues on `fake/f1-a`.
- `the listing is classified by prefix`. Input: a stub printing `opencode/space-bunny-free`, `opencode-go/x`, `acme/y`; `upkeep --only discover`. Expect: auto rows with billing `free`, `subscription` and an unpriced `paid` row that `pick --all` never lists.
- `the mined fixtures classify as recorded`. Input: as in Task 27 for `opencode`. Expect: each `job_end.outcome` equals the recorded `outcome`.

- [ ] **Step 2: Run.** `bun test fanout/tests/adapter-opencode.test.ts`. Expected: FAIL (`opencode` is not a registered adapter).
- [ ] **Step 3: Implement** `opencode.ts`, the patterns and fixtures, and register it.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): opencode adapter`.

### Task 42: Report with DuckDB

DuckDB is for analytics only. The hot path never touches it.

**Files:**

- Create: `fanout/src/duckdb.ts`, `fanout/src/commands/report.ts`, `fanout/sql/report.sql`
- Test: `fanout/tests/report.test.ts`

Official docs: https://duckdb.org/docs/stable/data/json/overview.html, https://duckdb.org/docs/stable/clients/cli/overview.html

**Behaviour.** `fanout report [--since 30d]` runs `duckdb -no-agent -json` (when `AI_AGENT` is set and stdout is not a terminal DuckDB 2.0 switches to an agent output mode, which this avoids) over `events/*.jsonl` with `read_json_auto(..., format='newline_delimited', union_by_name=true, ignore_errors=true)`, keeping `v = 1`. It prints a tab-separated table with the header `harness\tmodel\tkind\tjobs\tok\taccepted\trejected\tsuccess_rate\tfallbacks_from\tcost_usd\tcost_mc\tcalls\tcost_per_accepted_usd`, one row per `harness model kind`, then a `TOTAL` row. `success_rate` is accepted over accepted plus rejected; `fallbacks_from` counts jobs that ended in a limit outcome and were followed by a fallback. Without `duckdb` on `PATH`, or when it fails: `duckdb not found; reports are unavailable (the ledger and run are unaffected)` and exit 1. `run`, `pick` and `status` never call it.

- [ ] **Step 1: Write the failing tests** `fanout/tests/report.test.ts` (the ledger is built with real fake-adapter runs and verdicts; skipped when `duckdb` is missing):
- `one accepted and one rejected job`. Input: two `RUN` on `fake/f1-a` with `verdict accepted` and `verdict rejected`; a third run where `fake/f1-b` is the fallback target of a rate-limited `fake/f1-a` attempt; `report`. Expect: the row `fake	f1-a	transcribe` has `jobs` 3, `ok` 2, `accepted` 1, `rejected` 1, `success_rate` 0.5, `fallbacks_from` 1.
- `cost per accepted job`. Input: a private catalog forcing the paid pick `fake2/f1-paid`; one run with `verdict accepted`; `report`. Expect: the `fake2 f1-paid transcribe` row has `cost_usd` 0.0014 and `cost_per_accepted_usd` 0.0014; the `TOTAL` row's `cost_usd` is 0.0014.
- `a corrupt line and a v2 event do not break the report`. Input: append `{not json` and a `{"v":2,...}` event, then `report`. Expect: the same rows as before and exit 0.
- `--since excludes older events`. Input: a job at `2026-11-10T01:00:00Z` and one at `2026-11-15T01:00:00Z`; `report --since 1d` at `FANOUT_NOW` `2026-11-15T02:00:00Z`. Expect: only the later job is counted.
- `no duckdb: exit 1 with the message, and run still works`. Input: `PATH` = `sb.pathWithout(['duckdb'])`; `report`, then `RUN`. Expect: exit 1 with `duckdb not found; reports are unavailable (the ledger and run are unaffected)`; the run exits 0.
- `an empty ledger prints the header and a zero TOTAL row`. Input: `report` with no events. Expect: exit 0; the header line and `TOTAL` with `jobs` 0.

- [ ] **Step 2: Run.** `bun test fanout/tests/report.test.ts`. Expected: FAIL, "unknown command report".
- [ ] **Step 3: Implement** `duckdb.ts` (the CLI wrapper), `sql/report.sql` and `commands/report.ts`.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): report command on DuckDB`.

## Phase 4: go-live

Phase 4 prepares everything that switches fanout on, tests it in a sandbox home, and ends with one runbook task that touches the user's real configuration. Nothing before Task 49 changes a file outside the repo except the seven pointer lines of Task 48.

### Task 43: The shared skill and the public README

The one skill every harness loads, and the README a stranger reads. Both ship in the built copy.

**Files:**

- Create: `fanout/skill/SKILL.md`, `fanout/README.md`
- Modify: `README.md` (root status line: fanout is built, audits are planned)
- Test: `fanout/tests/skill.test.ts`

**Skill** (at most 150 lines; frontmatter `name: fanout`; a `description` saying: dispatch bulk mechanical chunks to cheap worker models from any harness with automatic fallback; use `fanout pick` and `fanout run`; replaces the per-backend `*-fanout` skills). Sections in order:

1.  **When**: by kind, never by size; never design, review or verification (mechanical and fully specified work only, as in the fanout policy).
1.  **Preflight**: `command -v fanout`, then `fanout status --brief`; act on whatever it lists (this is how harnesses without hooks get status).
1.  **Ask the user once** per dispatch: write the brief files first, run `fanout pick --brief <f> --dir <d> --kind <k>`, then one question naming the chunks, the `PICK` line and the `PAID` line (the estimate of the first paid model in the chain, or "no paid model"). The answer covers automatic fallbacks, retries and escalations of that dispatch.
1.  **Brief**: the six-point work order (name every file and say "and nothing else"; inputs as paths; concrete output format; house rules; preserve verbatim; short report), plus "Do not run git" and "Do not write report or notes files". Bundle related small files into one large brief: the picker sends only large briefs to ModelScope.
1.  **Dispatch**: `fanout run --brief <f> --dir <d> --kind <k> --expect <harness>/<model>` with the harness and model copied from the `PICK` line, as a background command, one per chunk, at most 6 at once and at most 3 to 6 heavy workers (memory); workers do not run builds or e2e. For a chain that may take more than a few minutes use `--detach`, then call `fanout wait <job>` again and again (each call waits up to 9 minutes; exit 4 means still running). Whole-issue runs add `--timeout 7200 --max-turns 500`. `--model` is a starting point, `--pin` forbids fallback, `--public` and `--private` override the data class.
1.  **Result block rules (hard)**: for every `FALLBACK` line (including `not started`, a pre-start reroute) and every `COST` line, tell the user in the next message (fallback: from, to, why; cost: estimate and actual, calls and MC for per-call), then run `fanout ack <job>`; `ack` is refused while the chain still runs, so use `fanout wait`. Never present an estimate as an actual. `FAILED job_error` means the chunk is too large or malformed (split it); `FAILED no_effect` means the worker changed nothing (read `LOG=`, re-brief). `RETRY`, `NOTE` and `DENIALS` are informational. A desktop notification repeats each `FALLBACK` and `COST` line, but the user still hears it from you.
1.  **Verify, then record**: open `PATCH` or `WORKTREE`, check artifacts against the brief (an exit code is not proof: agy exits 0 on timeout, opencode exits 0 having done nothing), apply the patch yourself after review, then `fanout verdict <job> accepted|rejected`. On rejection write a new brief naming the defect and run `fanout run --escalate-from <job>`.
1.  **Benchmarks**: when the user has fresh Arena WebDev or FrontierCode 2.0 figures, produce a CSV `name,metric,value,as_of` (metric `arena_webdev` or `frontiercode2`) and run `fanout benchmarks import <file>`.
1.  **Never**: paste keys; hand-pick a `public-only` model for private data (the CLI refuses); skip the ack; run `fanout` from inside a worker (the CLI refuses a nested run).

**README** (public; at most 80 lines; no personal paths or names): what it is, install (build then install, Task 44 and 45), the commands, the data layout, the catalog layers, how to add an adapter, and the credit line `Benchmark data: [Artificial Analysis](https://artificialanalysis.ai/)`.

- [ ] **Step 1: Write the failing tests** `fanout/tests/skill.test.ts` (documentation lint; the files are read as text):
- `the skill has the right frontmatter and size`. Input: `fanout/skill/SKILL.md`. Expect: the first line is `---`, a line `name: fanout`, a `description:` line, and at most 150 lines in total.
- `the skill names every command and rule`. Input: the same file. Expect: it contains each of `fanout pick`, `fanout run`, `--expect`, `--detach`, `fanout wait`, `fanout ack`, `fanout verdict`, `--escalate-from`, `--pin`, `benchmarks import`, `FALLBACK`, `COST`, `job_error`, `no_effect`, `PAID`.
- `the skill and the README carry no personal path or key`. Input: both files. Expect: none of the Task 2 leak rules matches (no absolute home path of any OS, no key shape, no email address).
- `the README is short and credits the source`. Input: `fanout/README.md`. Expect: at most 80 lines and the exact credit line.
- `the root README says fanout is built`. Input: `README.md`. Expect: it no longer contains `Status: design`; it links `fanout/README.md`.

- [ ] **Step 2: Run.** `bun test fanout/tests/skill.test.ts`. Expected: FAIL (the files do not exist).
- [ ] **Step 3: Write** `fanout/skill/SKILL.md` and `fanout/README.md` as specified, and update the root `README.md` status line.
- [ ] **Step 4: Run.** `bun test fanout` passes. `bunx prettier --check README.md fanout/README.md fanout/skill/SKILL.md` passes.
- [ ] **Step 5: Commit.** Title `docs(fanout): add shared skill and module README`.

### Task 44: Build the single-file copy

The installed CLI must not depend on the working checkout. The build bundles the CLI and its data into one `fanout.js`, copies the shims, the skill, the unit files and the installer beside it, and stamps a build id.

**Files:**

- Create: `fanout/install/build.sh`
- Test: `fanout/tests/build.test.ts`

**Behaviour.** `bash fanout/install/build.sh [--out <dir>] [--allow-dirty]` (default `--out ~/.local/lib/agent-ops/fanout`):

- Refuses a dirty tree with exit 2 and `working tree is dirty; commit, or pass --allow-dirty`.
- Build id `<VERSION>-<short sha>-<UTC yyyymmddHHMMSS from FANOUT_NOW or the clock>` (with `-dirty` after the sha under `--allow-dirty`).
- `bun build fanout/src/cli.ts --target bun --outfile <out>/<id>/fanout.js`. The default catalog, the patterns, `kinds.json`, the benchmark seed and the discovery ignore list are imported as text or JSON (verified on Bun 1.4.2: `with { type: 'text' }` imports bundle into the one file), so no sidecar data file exists.
- Copies `fanout/bin/{fanout,fanout-stop-hook,fanout-session-hook}`, `fanout/skill/`, `fanout/systemd/`, `fanout/install/{install.sh,verify.sh}` into `<out>/<id>/`, writes `<out>/<id>/BUILD` (`id`, `sha`, `dirty`, `built_at`) and prints `BUILD <id> -> <out>/<id>`. It never changes the `current` link (the installer does).

- [ ] **Step 1: Write the failing tests** `fanout/tests/build.test.ts` (each test builds into a temp `--out`; tests that need a dirty or clean tree work in a `git clone --local` of the repo in a temp dir, never in the real checkout):
- `a build lays out the copy`. Input: `build.sh --out <tmp> --allow-dirty`. Expect: stdout `BUILD <id> -> <tmp>/<id>`; the folder holds `fanout.js`, `fanout`, `fanout-stop-hook`, `fanout-session-hook`, `skill/SKILL.md`, `systemd/fanout-upkeep.timer`, `install.sh`, `verify.sh` and `BUILD`; the three shims are executable.
- `the built copy runs without the checkout`. Input: copy the build folder to a fresh temp dir, then from another cwd with `HOME` and `FANOUT_HOME` temp dirs, `FANOUT_NO_LAZY=1` and no `FANOUT_CATALOG_FILE`: `<copy>/fanout --version`, then `<copy>/fanout pick --brief B --dir <repo> --kind transcribe`. Expect: `fanout 0.1.0`; the first `pick` line is `PICK harness=agy model=gemini-3.8-flash tier=1 billing=subscription effort=low data=private` (the default catalog and its benchmark seed are embedded).
- `no checkout path is baked into the bundle`. Input: read `fanout.js`. Expect: it does not contain the absolute path of the repo root.
- `a hook wrapper works from the built copy`. Input: `echo '{"session_id":"S1","stop_hook_active":false}' | CLAUDE_PROJECT_DIR=/tmp/p <copy>/fanout-stop-hook` with a temp `HOME`. Expect: exit 0, empty stdout.
- `a dirty tree is refused`. Input: in a clone, edit a tracked file, run `build.sh --out <tmp>` there. Expect: exit 2, stderr `working tree is dirty; commit, or pass --allow-dirty`; nothing written.
- `the build stamp matches the commit`. Input: a clean clone, `build.sh --out <tmp>`. Expect: `BUILD` parses and its `sha` equals `git rev-parse --short HEAD`; the id starts `0.1.0-<sha>-` and `dirty` is false.
- `two builds get different ids`. Input: two builds with `FANOUT_NOW` one minute apart. Expect: two folders under `<tmp>`.

- [ ] **Step 2: Run.** `bun test fanout/tests/build.test.ts`. Expected: FAIL (`build.sh` does not exist).
- [ ] **Step 3: Implement** `build.sh` (bash) with the steps above, and convert any remaining runtime file read in `fanout/src` (`readFileSync` of a repo-relative data file) into an import so the bundle is self-contained.
- [ ] **Step 4: Run.** `bun test fanout` passes. `bun run typecheck` exits 0.
- [ ] **Step 5: Commit.** Title `build(fanout): bundle a single-file copy`.

### Task 45: The installer

The installer points the machine at a built copy. It is idempotent, backs up what it edits, and never touches the instruction files, `settings.json` or the docs (Task 49 does that by hand).

**Files:**

- Create: `fanout/install/install.sh`
- Test: `fanout/tests/install.test.ts`

**Behaviour.** `bash <build>/install.sh [--dry-run]` (it installs the build it lives in; `FANOUT_INSTALL_NO_SYSTEMD=1` skips Task 46's systemd step; every edited file is first copied to `~/.agents/backups/fanout-install-<timestamp>/`, the convention of `sync-harnesses.sh`). Each action prints one line `LINK`, `EDIT`, `BACKUP` or `MKDIR`; `--dry-run` prints them and changes nothing.

1.  Point `~/.local/lib/agent-ops/fanout/current` at the build folder (create a temp link, then `mv -T` it into place, so the switch is atomic); keep the newest 3 builds and remove the older ones, never the target.
1.  `ln -sfn ~/.local/lib/agent-ops/fanout/current/fanout ~/.agents/bin/fanout` and the same target for `~/.local/bin/fanout`, so a new build needs no re-link.
1.  Insert a marked block `# >>> fanout PATH >>>` ... `# <<< fanout PATH <<<` (`export PATH="$HOME/.agents/bin:$PATH"`) into `~/.profile` and into `~/.bashrc` before the `case $- in` interactivity guard; replace it in place on re-run.
1.  Link `~/.claude/skills/fanout` and `~/.agents/skills/fanout` to `current/skill`; an existing real directory is moved into the backup folder, never deleted.
1.  Create `~/.local/share/agent-ops/fanout/` with its subfolders and `~/.config/agent-ops/` with mode 0700.

- [ ] **Step 1: Write the failing tests** `fanout/tests/install.test.ts` (`HOME=<tmp>`, `FANOUT_INSTALL_NO_SYSTEMD=1`, a seeded `.bashrc` holding a `case $- in` guard, a `.profile`, and a build made by `build.sh --allow-dirty --out <tmp>/lib`; `inst(build)` runs `<build>/install.sh`):
- `links and modes`. Input: one install. Expect: `<tmp>/.local/lib/agent-ops/fanout/current` points at the build folder; `readlink -f <tmp>/.agents/bin/fanout` and `<tmp>/.local/bin/fanout` both end `/fanout` inside the build folder; the data folder and `~/.config/agent-ops` have mode `0700`.
- `the live path is the built copy, not the checkout`. Input: one install. Expect: no resolved link target starts with the repo root.
- `the PATH block is idempotent`. Input: install twice. Expect: `.bashrc` has the block before the `case $- in` line and `.profile` has it; the SHA-256 of both files is the same after the second run; each holds exactly one `# >>> fanout PATH >>>`.
- `edited files are backed up`. Input: one install. Expect: `~/.agents/backups/fanout-install-*/` holds copies of the original `.bashrc` and `.profile`.
- `the shim works through the link with a clean environment`. Input: `env -i HOME=<tmp> PATH=<tmp>/.local/bin:/usr/bin:/bin <tmp>/.local/bin/fanout --version`. Expect: `fanout 0.1.0`.
- `skills are linked and an existing directory is kept`. Input: a real `~/.claude/skills/fanout/` holding `old.txt`; install. Expect: both skill paths resolve to `<build>/skill/SKILL.md`; `old.txt` exists under the backup folder.
- `a newer build switches the link and old builds are pruned`. Input: four builds with `FANOUT_NOW` one minute apart, each installed in turn. Expect: after the fourth install `current` points at the fourth build and exactly three build folders remain (the first is gone).
- `a rollback is a re-install of an older build`. Input: after the case above, run the third build's `install.sh`. Expect: `current` points at the third build; no build folder is deleted by a rollback.
- `dry run changes nothing`. Input: `install.sh --dry-run`. Expect: stdout lists `LINK` and `EDIT` lines; the temp home is unchanged (same file list and hashes).
- `instruction files, settings and docs are untouched`. Input: seeded `~/.agents/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.claude/settings.json`; install. Expect: their SHA-256 values are unchanged.

- [ ] **Step 2: Run.** `bun test fanout/tests/install.test.ts`. Expected: FAIL (`install.sh` does not exist).
- [ ] **Step 3: Implement** `install.sh` (bash, `set -euo pipefail`, honours `$HOME`) with the five duties above and the dry-run mode.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): add idempotent installer`.

### Task 46: Systemd units

**Files:**

- Create: `fanout/systemd/fanout-upkeep.service`, `fanout/systemd/fanout-upkeep.timer`
- Modify: `fanout/install/install.sh` (the systemd step becomes real)
- Test: `fanout/tests/systemd.test.ts`

Official docs: https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html

**Content.** Service: `Type=oneshot`, `ExecStart=%h/.local/lib/agent-ops/fanout/current/fanout upkeep` (the stable `current` path, so a new build needs no unit change), `Environment=PATH=%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin`, `Nice=10`. Timer: `OnCalendar=daily`, `Persistent=true`, `RandomizedDelaySec=1h`, `[Install] WantedBy=timers.target`. The installer copies both from `<build>/systemd/` to `~/.config/systemd/user/`, runs `systemctl --user daemon-reload` and `systemctl --user enable --now fanout-upkeep.timer`, each followed by `|| echo "WARN ..."` (never fatal).

- [ ] **Step 1: Write the failing tests** `fanout/tests/systemd.test.ts`:
- `the unit files verify`. Input: `systemd-analyze --user verify fanout/systemd/fanout-upkeep.service fanout/systemd/fanout-upkeep.timer` (the test is skipped when `systemd-analyze` is absent). Expect: exit 0.
- `the service uses the stable path`. Input: read the service file. Expect: it contains `ExecStart=%h/.local/lib/agent-ops/fanout/current/fanout upkeep` and `Type=oneshot`; the timer contains `OnCalendar=daily`, `Persistent=true`, `RandomizedDelaySec=1h`.
- `the flag skips the whole systemd step`. Input: install with `FANOUT_INSTALL_NO_SYSTEMD=1` and a stub `systemctl` that appends its argv to a file. Expect: `<tmp>/.config/systemd/user/` holds no fanout file; the stub file does not exist.
- `without the flag the installer copies the units, reloads and enables`. Input: install without the flag, stub `systemctl`. Expect: `fanout-upkeep.service` and `fanout-upkeep.timer` exist under `<tmp>/.config/systemd/user/`; the recorded calls are, in order, `--user daemon-reload` and `--user enable --now fanout-upkeep.timer`.
- `a failing systemctl is not fatal`. Input: a stub `systemctl` that exits 1. Expect: the installer exits 0 and prints `WARN`.

- [ ] **Step 2: Run.** `bun test fanout/tests/systemd.test.ts`. Expected: FAIL (the unit files do not exist).
- [ ] **Step 3: Write** the units and extend `install.sh` with the copy, reload and enable calls.
- [ ] **Step 4: Run.** `bun test fanout` passes.
- [ ] **Step 5: Commit.** Title `feat(fanout): daily upkeep systemd timer`.

### Task 47: Verify script

One script the user can run in under 5 minutes. It spends no quota: it uses the fake adapter and `--dry-run`. In its default mode it builds a copy of the current tree, installs it into a temp home and checks it there. With `--live` it checks the real installation without changing anything.

**Files:**

- Create: `fanout/install/verify.sh`
- Test: `fanout/tests/verify.test.ts`

**Behaviour.** Each check prints `PASS <name>` or `FAIL <name>: <detail>`; the last line is `ALL PASS` (exit 0) or `FAILED <n>` (exit 1). Sandbox mode (default; `FANOUT_FAKE_WORKER` points at the checkout's fake worker):

1.  `version`: the installed `fanout --version`; `fanout doctor` exits 0 or only warns.
1.  `fallback`: a scripted fallback through the installed CLI prints a `FALLBACK` line; `fanout status --brief` shows `UNREPORTED`; the installed `fanout-stop-hook`, fed a Stop payload for that session, prints a block; after `fanout ack` it prints nothing.
1.  `cost`: a paid fake job prints `ESTIMATE` on stderr and a `COST` line with an estimate and an actual.
1.  `dryrun`: `fanout run --dry-run` for codex, agy and meta prints an argv and no key text (a fake key sits in a temp secrets file).
1.  `detach`: `run --detach` prints `JOB <id>`; `fanout wait <id>` prints the block.
1.  `report`: `fanout report` runs, or prints the DuckDB message, which is a `PASS` with a note.
1.  `hygiene`: `bun test fanout/tests/hygiene.test.ts` passes.

`--live` mode: `bin` (`readlink -f ~/.agents/bin/fanout` and `~/.local/bin/fanout` end inside `~/.local/lib/agent-ops/fanout/`, not the checkout), `skill` (`fanout` visible in `~/.claude/skills`, `~/.agents/skills`, `~/.gemini/config/skills`), `hooks` (`jq -e` finds a Stop and a SessionStart group whose command is the `current` wrappers), `timer` (`systemctl --user is-enabled fanout-upkeep.timer`), `path` (`env -i HOME=$HOME bash -lc 'command -v fanout'`), `catalog` (`~/.config/agent-ops/catalog.csv` exists), `docs` (`~/.agents/docs/08-fanout.md` carries the policy sentence, `24-fanout-ledger.md` exists, `06-hooks.md` records the exception, and both pointer files link doc 24).

- [ ] **Step 1: Write the failing tests** `fanout/tests/verify.test.ts`:
- `the sandbox verification passes`. Input: `bash fanout/install/verify.sh` with the sandbox env. Expect: exit 0, one `PASS` line per check above and the last line `ALL PASS`, finishing within 5 minutes.
- `a broken fake worker fails the checks`. Input: `FANOUT_FAKE_WORKER=/nonexistent`. Expect: exit 1; `FAIL fallback:` and `FAIL cost:` lines; the last line matches `^FAILED [1-9]`.
- `live mode in an empty home reports every gap`. Input: `verify.sh --live` with `HOME` a temp dir that has had `install.sh` run (no hooks, no docs, no catalog). Expect: exit 1; `PASS bin:`, `PASS skill:`, `FAIL hooks:`, `FAIL catalog:`, `FAIL docs:`; nothing in the temp home changed.
- `live mode never writes`. Input: hash the temp home before and after. Expect: identical.

- [ ] **Step 2: Run.** `bun test fanout/tests/verify.test.ts`. Expected: FAIL (the script does not exist).
- [ ] **Step 3: Write** `verify.sh` with the two modes.
- [ ] **Step 4: Run it for real, with a timer.** `time bash fanout/install/verify.sh`. Expected: `ALL PASS`, real time under 5 minutes (target about 1 minute). Then `bun test` for the whole repo and `bun run typecheck`: all pass.
- [ ] **Step 5: Commit.** Title `feat(fanout): end-to-end verify script`.

### Task 48: Pointer lines in the old skills

The seven old backend skills stay intact: they are the manual path and the knowledge base for the adapters. Each gets one added line that points to `fanout run`. The retired skills (kd, respan, devin, gonka) are not touched. Nothing is deleted.

**Files** (outside this repo; each is its own repo under `~/CS/` except `meta-fanout`, which is not a git repo): `agy-fanout/SKILL.md`, `codex-fanout/SKILL.md`, `meta-fanout/SKILL.md`, `river-fanout/SKILL.md`, `opencode-fanout/SKILL.md`, `claude-fanout/SKILL.md`, `modelscope-fanout/SKILL.md`.

The line, inserted directly under the H1 title (before the existing blank line, so the diff is exactly one added line):

```markdown
> Prefer `fanout run --harness <h>` when `command -v fanout` succeeds: it picks the model, falls back and reports cost. This skill stays as the manual path.
```

`<h>` is `agy`, `codex`, `meta`, `river`, `opencode`, `claude-fanout` or `modelscope`.

- [ ] **Step 1: Write the failing check** (a shell check; these are documents, not code):

```bash
for s in agy codex meta river opencode claude modelscope; do
  grep -q '^> Prefer `fanout run --harness' ~/CS/$s-fanout/SKILL.md || echo "FAIL $s"
done
```

Run it. Expected: seven `FAIL` lines.

- [ ] **Step 2: Back up, then insert.** Copy the seven files to `~/.agents/backups/fanout-pointers-<timestamp>/<s>-SKILL.md`. For each, insert the line after the first line that starts with `# ` (use `sed -i '0,/^# /s//&/;...'` or a short Bun script; do not retype the files).
- [ ] **Step 3: Run the check again.** No output. Then prove each file differs only by that line: for each skill, `diff <(grep -v '^> Prefer `fanout run --harness' ~/CS/$s-fanout/SKILL.md) ~/.agents/backups/fanout-pointers-<timestamp>/$s-SKILL.md`prints nothing, and`head -5 ~/.claude/skills/<s>-fanout/SKILL.md` still shows the original frontmatter (the folders are symlinks to these repos).
- [ ] **Step 4: Commit in each git repo** (old content stays in history): `git -C ~/CS/<s>-fanout add SKILL.md && git -C ~/CS/<s>-fanout commit -m "docs: point skill at fanout run"` for the six repos (`meta-fanout` has no repo: skip it and keep its backup).

### Task 49: Go live

This is the last task. It is a runbook, not a feature: every behaviour it switches on was built and tested in Tasks 1 to 48, and each step below is one command or one edit with a check. It is the only task that edits the user's real global configuration. Back up before every edit, and stop at the first failing check.

**Files:** created `~/.local/lib/agent-ops/fanout/`, `~/.agents/bin/fanout`, `~/.local/bin/fanout`, `~/.claude/skills/fanout`, `~/.agents/skills/fanout`, `~/.config/agent-ops/catalog.csv`, `~/.config/systemd/user/fanout-upkeep.{service,timer}`, `~/.agents/docs/24-fanout-ledger.md`; edited `~/.bashrc`, `~/.profile`, `~/.agents/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.claude/settings.json`, `~/.agents/docs/08-fanout.md`, `~/.agents/docs/06-hooks.md`.

- [ ] **Step 1: Gate.** From the repo root on a clean tree: `git status --short` prints nothing; `bun test` and `bun run typecheck` pass; `bash fanout/install/verify.sh` prints `ALL PASS`.
- [ ] **Step 2: Build the copy.** `bash fanout/install/build.sh`. Expected: `BUILD <id> -> ~/.local/lib/agent-ops/fanout/<id>` (the build refuses a dirty tree).
- [ ] **Step 3: Install the copy.** `bash ~/.local/lib/agent-ops/fanout/<id>/install.sh`. Expected: `LINK`, `EDIT` and `BACKUP` lines and a backup folder path. Then `readlink -f ~/.agents/bin/fanout` ends inside `~/.local/lib/agent-ops/fanout/<id>/` (not `~/CS/agent-ops`), and in a new login shell `command -v fanout` prints a path.
- [ ] **Step 4: Create the private catalog.** Write `~/.config/agent-ops/catalog.csv` (mode 0600) with the user's decisions:

```csv
harness,model,tier,status,note
agy,gemini-4-argon,3,,user decision 2026-11-15: Argon is tier 3
kd,*,,retired,retired 2026-11-15
respan,*,,retired,retired 2026-11-15
devin,*,,retired,retired 2026-11-15
gonka,*,,retired,retired 2026-11-15
```

Check: `fanout pick --all --kind edit --harness agy --brief <any file> --dir .` lists `agy/gemini-4-argon tier=3` and no `kd/`, `respan/`, `devin/` or `gonka/` line.

- [ ] **Step 5: Sync the skills to every harness.** `bash ~/.agents/bin/sync-harnesses.sh --dry-run`, read the output (expect `add fanout` for agy and antigravity-ide and no second copy for harnesses that scan `~/.agents/skills`), then `bash ~/.agents/bin/sync-harnesses.sh`. Check: `for d in ~/.claude/skills ~/.agents/skills ~/.gemini/config/skills ~/.gemini/antigravity/skills ~/.gemini/skills ~/.codex/skills ~/.copilot/skills; do ls -d $d/fanout 2>/dev/null || echo "via shared dir: $d"; done`. Expected: `fanout` resolves in the Claude, shared, agy and antigravity folders; the rest are reached through `~/.agents/skills`. Record any harness that does not see it for doc 24.
- [ ] **Step 6: Verify the desktop notification.** `fanout doctor --notify-test`. Expected: exit 0 and a toast titled `fanout: test` on the Windows desktop (ask the user whether it appeared). If no notifier works, the `notify` check stays a `WARN`, doc 24 records "no toast support on this install (checked <date>)", and fanout keeps working (the notifier is fail-open).
- [ ] **Step 7: Write doc 24.** Create `~/.agents/docs/24-fanout-ledger.md` (about 160 lines, in the house style of the neighbouring docs) with these sections: what and why; layout (repo module, built copy and `current`, data dir, `~/.config/agent-ops`, symlinks, skill, timer); the event schema (the spec table plus the additive fields of Call 4) and the `learned/` files; the catalog (columns, the three layers, how to change a tier privately, retire a model, the `climb` and `upstream` columns and why the data class follows the upstream); how a job flows (pick, run with `--expect`, detach and wait, fallback, cooldowns, escalate, verdict, ack); the three reporting layers, the desktop notification and what to do when a hook did not fire; upkeep steps and `status --brief`; benchmarks (the Artificial Analysis refresh and its key in the secrets file, `benchmarks import` for Arena and FrontierCode, the 20-judged-job rule, the attribution); runbooks (a fallback did not happen; a cooldown looks stuck and how to read it from the ledger; a real error text appeared and how to capture it with the mining tool into `patterns/` and a fixture; a new harness or model; a paid model waiting for its first use; rebuild and reinstall, and roll back by running an older build's `install.sh`; the AA key is missing); how to add an adapter (checklist: file, patterns, registration, catalog rows, stub-based tests, `listModels` fixture); DuckDB queries (`report.sql` and three ad-hoc); a harness table with caller detection (verified or not), hook support (evidence) and skill visibility; known limits (ModelScope measurement needs a lone job; the codex quota finding from Task 27; the notification result of Step 6); uninstall.
- [ ] **Step 8: Check the other harnesses for a turn-end hook.** For codex, gemini, copilot, opencode and antigravity, run the CLI's `--help` and read the installed docs for a command-hook system with a turn-end event that can continue the turn. Wire the equivalent of `fanout-stop-hook` only where the harness documents it (back up its config first); record each harness in the doc 24 table with the command you ran and the finding, or `not supported (checked <date>, <version>)`. Layers 1 and 3 cover the rest.
- [ ] **Step 9: Edit the policy doc.** Back up `~/.agents/docs/08-fanout.md`, then (keeping "What qualifies" and "What never qualifies" unchanged): in "Look for one when the work fits" check `command -v fanout` and `fanout status --brief`, and say the old `*-fanout` skills stay as the manual path; in "Asking first" keep the initial dispatch question and make it name the chunks plus the `fanout pick` result (harness, model, tier, billing and the `PAID` estimate), adding "**An approved dispatch covers its own automatic fallbacks, retries and escalations; each is reported to the user after it happens, with cost when paid.**"; in "Before and after a dispatch" replace "list its models, and ask which to use" with `fanout pick`, and after a dispatch: tell the user every `FALLBACK` and `COST` line, then `fanout ack`, verify the artifacts, `fanout verdict`; in "Check" use `fanout doctor`, then `fanout run --dry-run`; link doc 24.
- [ ] **Step 10: Record the hook exception.** Back up `~/.agents/docs/06-hooks.md`, then add under "The global-hook trap" an "Exception" paragraph: a hook keyed to the session id whose work is owed to the session even when it started in `$HOME` keeps the empty-context guard and drops the `$HOME` guard; the fanout Stop and SessionStart hooks are the two such hooks (2026-11-15), because a fallback or a paid job in a `$HOME` session still has to be reported; every other global hook keeps both guards.
- [ ] **Step 11: Add the pointer lines.** Back up `~/.agents/AGENTS.md` and `~/.claude/CLAUDE.md` to `~/.agents/backups/fanout-install-<timestamp>/`. In both, replace the rule "Fan work out to worker CLIs by kind, never for design work, and ask before every dispatch." (in `AGENTS.md` it wraps over two lines and is followed by a sentence about the `*-fanout` skills; replace that sentence too) with: "Fan work out to worker CLIs by kind, never for design work, with the `fanout` skill (`fanout pick`, then `fanout run --expect <harness>/<model>`). Ask once per dispatch; an approved dispatch covers its own fallbacks. Tell the user about every `FALLBACK` and `COST` line, then `fanout ack`. Details: [Fanout ledger](<link to ~/.agents/docs/24-fanout-ledger.md in the same form as the neighbouring links>)." Add the Documents-table row `| Dispatching, debugging or maintaining fanout (the ledger, adapters, upkeep) | [Fanout ledger](<same link>) |` to both tables. `diff` each file against its backup: only these lines differ.
- [ ] **Step 12: Wire the hooks through the `update-config` skill.** Invoke the `update-config` skill and back up `~/.claude/settings.json` first. Add a `hooks.Stop` group running `~/.local/lib/agent-ops/fanout/current/fanout-stop-hook` (type `command`, `timeout` 5, `statusMessage` "Fanout report check") and a `hooks.SessionStart` group running `~/.local/lib/agent-ops/fanout/current/fanout-session-hook` (`timeout` 5), written as the absolute path of the user's home. Existing Stop and SessionStart groups stay.
- [ ] **Step 13: Test the hooks as doc 06 prescribes.** `jq -e '.hooks.Stop, .hooks.SessionStart' ~/.claude/settings.json` exits 0 and lists the new groups. Then pipe-test the live wrappers against a temp ledger that holds one unreported fallback (create it with a fake-adapter run through the live CLI): `echo '{"session_id":"S1","stop_hook_active":false}' | CLAUDE_PROJECT_DIR=/tmp/p FANOUT_HOME=<tmp> ~/.local/lib/agent-ops/fanout/current/fanout-stop-hook` prints the block JSON and exits 0; the same with `CLAUDE_PROJECT_DIR=$HOME` prints the block too (the exception); with `CLAUDE_PROJECT_DIR=` empty it prints nothing and exits 0.
- [ ] **Step 14: Confirm the timer.** `systemctl --user list-timers --no-pager | grep fanout`. Expected: one `fanout-upkeep.timer` row with a NEXT time within 25 hours.
- [ ] **Step 15: Verify the live install.** `bash ~/.local/lib/agent-ops/fanout/current/verify.sh --live`. Expected: `ALL PASS`. Then `fanout doctor` prints no `FAIL` line, and `fanout status --brief` prints `fanout: ok` (or only the lines of an upkeep that is already running).
- [ ] **Step 16: Leave the repo clean.** `git status --short` in `~/CS/agent-ops` shows nothing from this task (every edit above is outside the repo). The optional real probe of a worker (it spends subscription quota, for example `fanout run` of a tiny brief on `codex/gpt-6-luna`) is the user's call, not a step of this plan.

## Spec coverage

**Review revisions** ("Review revisions (Fable consultant, 2026-11-15)" in the spec).

| Revision item                                                                                      | Where it is built                                                                                        |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Blocker 1: report only after the final `job_end`; `ack` refused while a lease lives                | Tasks 21 (finished chains), 22 (`ack`), 25 (Stop hook); Call 9                                           |
| Blocker 2: `--detach`, `fanout wait`, process-group kill, SIGTERM trap, orphan cost                | Tasks 7 (group, trap), 8 (detach, wait), 19 (interrupted cost), 23 (reaper cost)                         |
| Blocker 3: data class from the upstream name; `muse-spark-1.3` test                                | Tasks 4 (rule), 39 (config reader, alias test, unknown OpenRouter rows); Call 16                         |
| Blocker 4: no `$HOME` guard on the two hooks; exception in `06-hooks.md`                           | Tasks 25 (wrappers and tests), 49 Step 10 (doc); Call 19                                                 |
| Blocker 5: `FALLBACK` on a pre-start reroute with `--expect`                                       | Tasks 16 (`--expect`), 21 (unreported reroute), 43 (skill); Call 4                                       |
| `job_error` and `no_effect`                                                                        | Task 15; patterns in Tasks 27 to 29 and 39 to 41; Call 8                                                 |
| Backoff counts one `limit_hit` per model per 60 seconds                                            | Task 12                                                                                                  |
| Ranking: billing, estimated cost, benchmarks on shared metrics, success rate                       | Tasks 5 (cost key), 37 (shared metrics), 38 (user band); Call 10                                         |
| Worker environment allowlist, `FANOUT_DEPTH`, agy `--disable-slash-commands`                       | Tasks 7 (allowlist, depth), 28 (agy flag)                                                                |
| Go-live is the last task, from a built copy                                                        | Tasks 44 (build), 45 (installer), 46 (units), 47 (verify), 49 (runbook); Call 1                          |
| Old skills kept intact with one pointer line                                                       | Task 48                                                                                                  |
| `learned/` persistence for `model_gone`, graduation, learned patterns                              | Tasks 22 (`judged`), 32 (`gone`, `back`), 33 (`smoke`, `first_use`), 34 (patterns); Call 4               |
| New outcome `no_effect`                                                                            | Task 15                                                                                                  |
| Desktop notification, fail-open                                                                    | Task 24; verified on this install in Task 49 Step 6; Call 20                                             |
| Private catalog and `catalog.default.csv` with public data                                         | Tasks 3 (layers), 49 Step 4 (the user's file); Global constraints                                        |
| Climb lists, agy effort before tier                                                                | Tasks 17 (mechanism), 28 (agy test); default row in Task 3; Call 17                                      |
| The paid estimate in `pick`                                                                        | Task 5 (`PAID` line); Task 43 (the question quotes it)                                                   |
| Promote-on-first-use for new paid models                                                           | Task 33; Call 12                                                                                         |
| Artificial Analysis Data API refresh, missing key path tested                                      | Task 36; Open question 1                                                                                 |
| `fanout benchmarks import` for Arena and FrontierCode                                              | Task 37                                                                                                  |
| User results outrank benchmarks after 20 judged jobs                                               | Tasks 22 (`judged` lines), 38; Call 11                                                                   |
| Pattern-learning guardrails (denylist, rank below built-ins, 3 matches in 2 chains, 60-day expiry) | Tasks 26 (denylist seed), 34; Call 18                                                                    |
| Cuts: HTML scraper, `cost_source: reported`, `bun:ffi` flock                                       | Not built (Global constraints); Tasks 19 and 6 test the replacements; Task 22 stress-tests plain appends |
| Seed task: real limit and error texts mined from transcripts                                       | Task 26, consumed by Tasks 27 to 29 and 39 to 41                                                         |

**Original design sections.**

| Spec section                                                                       | Where it is built                                           |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Layout                                                                             | Calls 1 to 3; Tasks 1, 44 to 46, 49                         |
| The CLI (`run`, `pick`, `status`, `ack`, `verdict`, `report`, `upkeep`, `doctor`)  | Tasks 3 to 5, 6, 8, 16 to 18, 21, 22, 42, 30, 31            |
| Adapters (build, classify, usage, listModels, preflight)                           | Tasks 6, 27 to 29, 39 to 41                                 |
| Catalog (layers, seed, retirements)                                                | Task 3; discovery in Task 32; the user's file in Task 49    |
| Event schema v1                                                                    | Tasks 6, 10 to 15, 19, 21 to 23; Call 4 for additive fields |
| Picking (tier, billing, benchmark, success, data class, trial)                     | Tasks 3 to 5, 16, 33, 37, 38                                |
| Fallback and escalation, cooldowns                                                 | Tasks 10 to 17                                              |
| Reporting to the user (result block, three layers, cost, notification)             | Tasks 6, 11, 16, 19, 21, 22, 24, 25, 43                     |
| Self-maintenance (timer, lazy, discover, benchmarks, patterns, status.json)        | Tasks 30 to 36, 46                                          |
| Works from every harness                                                           | Tasks 6, 25, 43, 49                                         |
| Policy change to `08-fanout.md`                                                    | Task 49 Step 9                                              |
| Builder-check resolutions (worktrees, leases, no paid upkeep, `--pin`, fresh repo) | Tasks 9, 7, 23, 30, 16; the repo already exists             |
| User answers (River paid, retired marked, ModelScope per-call, smoke tests)        | Tasks 3, 40, 33, 19, 49 Step 4                              |
| Fail open and public-repo hygiene                                                  | Tasks 2, 20, 25                                             |
| Final verification                                                                 | Tasks 47, 49                                                |
