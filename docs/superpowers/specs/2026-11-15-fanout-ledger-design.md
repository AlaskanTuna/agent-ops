# Fanout Ledger: Design

Date: 2026-11-15. Status: draft for approval.

## Intent

The user runs bulk work through many worker CLIs (codex, agy, meta, river, opencode, claude-fanout) from several agent
harnesses (Claude Code, Codex, Gemini CLI, Antigravity, Copilot). Today each `*-fanout` skill picks its own model from
prose, nothing records how jobs went, and a run that hits a quota or credit wall just fails. The user wants fanout that
is **reliable, easy to invoke, fully automatic and self-maintaining**, with no manual tuning, and that works the same
from every harness.

The ledger is the memory that makes this possible: every job, quota hit, model sighting and benchmark is recorded, and
model choice, fallback and cooldowns are derived from that record.

## Goals

1. One command (`fanout run`) dispatches a chunk to the right model, from any harness.
2. Model choice follows a cost-ascending tier ladder; quality failures climb one tier.
3. Quota, rate-limit and credit failures fall back automatically to another model, across harnesses.
4. **Every fallback is reported to the user** by the calling agent. **Every job on paid API credit gets a cost
   estimate before and an actual cost after**, reported to the user. These are hard requirements.
5. New models, removed models, stale benchmarks and recovered quotas are handled without the user.
6. History is kept long-term in a plain, tool-independent format.
7. A technical doc at `~/.agents/docs/24-fanout-ledger.md` lets a future agent or the user maintain it.

## Non-goals

- No daily or per-task spend cap (user decision, 2026-11-15). Reporting replaces the cap.
- No multi-account rotation on one provider (ToS risk). One login or key per harness.
- No automation of logins or key entry. Adding a key stays a manual user step.
- No dashboard. Reports are CLI output and DuckDB queries.

## Anti-goals (failure even if it "works")

- A ledger, DuckDB or upkeep failure blocks or breaks a worker run. The system **fails open**.
- A fallback or a paid-credit job finishes without the user being told.
- A `-contributor` model (Meta trains on its input) receives private data.
- Prompt text, file content or secrets end up in the ledger.

## Constraints

- Machine: WSL2 Linux, 15 GiB RAM, systemd user session running, Bun is the JS runtime, DuckDB CLI 2.0 at
  `~/.local/bin/duckdb`.
- Shared agent infrastructure already exists: `~/.agents/bin`, `~/.agents/skills` distributed by
  `~/.agents/bin/sync-harnesses.sh` to `~/.claude`, `~/.codex`, `~/.gemini`, `~/.gemini/antigravity`,
  `~/.gemini/config` and `~/.copilot` skill folders; `~/.agents/AGENTS.md` is symlinked as Codex `AGENTS.md` and
  `GEMINI.md`.
- Up to 6 workers run at once and may append concurrently.
- Policy in `~/.agents/docs/08-fanout.md`: ask the user before every dispatch, naming chunks, CLI and model. See
  "Policy change" below.

## Approaches considered

|                | Approach                                                          | Trade-off                                                                                                             |
| -------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **A (picked)** | Append-only JSONL events + curated catalog + DuckDB for analytics | Plain text, survives tool upgrades, safe concurrent appends, full history. Current state must be derived.             |
| B              | One DuckDB database file                                          | Simplest queries, but one writer at a time (parallel workers collide) and the file format is tied to DuckDB versions. |
| C              | SQLite with mutable rows                                          | Concurrent writes are fine, but updates erase history, and it adds a second engine.                                   |

The user accepted A on 2026-11-15.

## Decisions

### Layout

| Path                                         | What                                                                                        | Owner   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- | ------- |
| `~/CS/fanout-ledger/`                        | Git repo: CLI source, adapters, shipped error patterns, manual catalog, tests, this spec    | Code    |
| `~/.agents/bin/fanout`                       | Symlink to the CLI entry point. `~/.agents/bin` gets added to PATH in the shell profile     | Install |
| `~/.agents/skills/fanout/`                   | The one shared skill, distributed by `sync-harnesses.sh`                                    | Install |
| `~/.local/share/fanout/events/YYYY-MM.jsonl` | The ledger. Append-only, one JSON object per line                                           | Runtime |
| `~/.local/share/fanout/learned/`             | Auto-learned error patterns and auto catalog entries                                        | Runtime |
| `~/.agents/docs/24-fanout-ledger.md`         | Technical and maintenance doc, linked from `08-fanout.md` and the CLAUDE.md Documents table | Docs    |

### The CLI (`fanout`, Bun, TypeScript)

| Command                                     | Job                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`                                       | Dispatch one chunk: pick a model, run the worker through its adapter, classify the outcome, fall back on limits, log every step, print the result block |
| `pick`                                      | Print the model `run` would choose, with its tier, billing type and cost estimate. Used in the dispatch question to the user                            |
| `status [--brief]`                          | Health, cooldowns, new/retired models, stale benchmarks, unreported fallbacks                                                                           |
| `ack <job>`                                 | Mark that the agent told the user about a fallback or paid cost                                                                                         |
| `verdict <job> accepted\|rejected [--note]` | Record whether the output passed review. Feeds escalation and success rates                                                                             |
| `report`                                    | Success rate, cost per accepted job, fallbacks, per model and task kind (DuckDB)                                                                        |
| `upkeep`                                    | Discover models, refresh benchmarks, health-check adapters, learn patterns. Idempotent, locked                                                          |
| `doctor`                                    | Self-check of the install, data dir, adapters and DuckDB                                                                                                |

**The hot path (`run`, `pick`, `status`) does not need DuckDB.** It reads the last 30 days of JSONL directly in
TypeScript. DuckDB is used only for `report`, upkeep analytics and ad-hoc queries. If DuckDB is missing or broken, only
reports degrade.

`run` input is harness-neutral: `--brief <file> --dir <workdir> --kind <kind>` plus optional `--harness`, `--model`,
`--tier`, `--public|--private`, `--timeout`, `--escalate-from <job>`. Because the input is neutral, `run` can re-route the
same chunk to another harness on fallback.

### Adapters

One small module per worker CLI: codex, agy, meta, river, opencode, claude-fanout. Each provides:

- `build(model, effort, dir, brief)`: the exact command, including known gotchas (agy needs `cd` + `--add-dir` + an effort
  the model supports; meta rounds `max` to `xhigh` on contributor models).
- `classify(exit, stdout, stderr)`: outcome class, using shipped + learned patterns, and a reset time when the error
  states one.
- `usage(stdout)`: tokens in/out/cached when the CLI reports them.
- `listModels()`: for discovery (`agy models`, `/v1/models` on Meta and River, `opencode models`, codex as available).
- `preflight()`: CLI present and authenticated.

The knowledge now in each `*-fanout` SKILL.md moves into its adapter. The old skills become thin pointers to
`fanout run --harness <name>`, kept for discoverability.

### Catalog

A model's row merges two sources; **manual always wins**:

- `catalog.manual.csv` in the repo: the user's decisions (e.g. Argon is tier 3), prices, data class, retirements
  (kd, respan, devin, gonka retired 2026-11-15).
- Auto entries from upkeep: newly discovered models with an auto tier from price band and benchmarks.

Columns: harness, model, efforts, tier, billing (`subscription` | `free` | `paid`), price in / cached / out per 1M,
data class (`public-only` for `-contributor`, else `any`), status (`trial` | `active` | `retired`), benchmark aliases.

Seed: the table in `~/.local/share/cc-duckdb/fanout_models.csv`.

### Event schema (v1)

Every line: `v`, `ts`, `event`, `id` (ULID), `job` (when job-related), `caller` (harness that ran `fanout`), `session`
(caller's session id when known), `repo`. Readers ignore unknown fields, so new fields never break old data; a breaking
change bumps `v`.

| Event                       | Key fields                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job_start`                 | harness, model, effort, tier, kind, data_class, attempt, reason (`initial` \| `escalate` \| `fallback`), from_job, billing, cost_est_usd, brief_sha |
| `job_end`                   | outcome, exit, duration_s, tokens_in / out / cached, cost_usd, cost_source (`computed` \| `reported` \| `unknown`), stderr_tail (scrubbed)          |
| `limit_hit`                 | harness, model, scope (`model` \| `account`), until, source (`stated` \| `backoff`)                                                                 |
| `verdict`                   | accepted, note                                                                                                                                      |
| `reported`                  | job (the fallback or paid job the agent told the user about)                                                                                        |
| `model_seen` / `model_gone` | harness, model                                                                                                                                      |
| `tier_set`                  | model, tier, source (`auto` \| `manual`)                                                                                                            |
| `benchmark`                 | model, source, metric, value, as_of                                                                                                                 |
| `pattern_learned`           | harness, regex, outcome                                                                                                                             |
| `upkeep`                    | step, status, detail                                                                                                                                |

Outcome classes: `ok`, `rate_limited`, `quota_exhausted`, `credits_exhausted`, `auth_error`, `model_unavailable`,
`timeout`, `worker_error`, `unknown`. Quality failure is not an outcome; it is a `verdict` with `accepted: false`.

Appends take an `flock` on the month file. Corrupt lines are skipped on read.

### Picking

Candidates are catalog models that are not retired, allow the chunk's data class, and are not in cooldown. Sort by:
tier ascending (starting at `--tier` or the kind's default) → billing (`subscription`/`free` before `paid`) → benchmark
score → recent success rate. A preferred harness, when given, wins ties within a tier.

Data class is automatic: a repo with a private remote, or with no remote, is `private`; a public remote is `public`.
`--public`/`--private` override it. Private chunks never go to `public-only` models.

`trial` models (auto-discovered, under 5 accepted jobs) take at most one concurrent job and only when no proven model
of the same tier is free.

### Fallback and escalation

- **Fallback** (limits, auth, model unavailable): log `limit_hit`, then re-run the same chunk on the next candidate in
  the same tier, then the next tier up. Never down a tier. If nothing is left, wait for the earliest stated reset when it
  is under 30 minutes; otherwise fail with a clear message listing every model tried.
- **Escalation** (output rejected): the caller runs `fanout run --escalate-from <job>`, which starts one tier above.
- **Unknown errors**: retry once on the same model. A repeat counts as a limit with backoff. The same unmatched error
  three times in 24 hours becomes a learned pattern (`pattern_learned`).
- **Cooldowns** use a circuit breaker: until the stated reset (or a backoff of 15 min doubling to 4 h), the model is
  skipped. Then one trial job is allowed. Success clears the cooldown; failure re-arms it with a doubled backoff.

### Reporting to the user (hard requirement)

`run` ends with a fixed result block on stdout:

```
FANOUT job=01J… harness=codex model=gpt-6.1-sol outcome=ok attempt=2
FALLBACK agy/gemini-4-hydrogen quota_exhausted (resets 18:00) -> codex/gpt-6.1-sol. Tell the user, then run: fanout ack 01J…
COST paid API (meta/muse-wonder-1.0): estimated $0.40, actual $0.31 (computed from tokens). Tell the user, then run: fanout ack 01J…
```

Three layers make sure it reaches the user:

1. The result block, and the shared skill's rule: report every `FALLBACK` and `COST` line in the next message to the
   user, then `fanout ack`.
2. Claude Code `Stop` hook: if this session has fallback or paid jobs without a `reported` event, block stopping and
   tell the agent which ones. Add the equivalent hook to other harnesses that support hooks.
3. `fanout status --brief` at the next session start lists anything still unreported, so a missed report still surfaces.

**Cost estimate before a paid job**: median tokens of past accepted jobs for the same kind and model family × catalog
prices. With fewer than 5 samples, use a per-kind default. **Actual cost**: adapter token usage × catalog prices, or
the CLI's own figure when it reports one (meta `worker.sh` already does). When usage is not available, say "actual
unknown". Never present the estimate as the actual.

### Self-maintenance

`fanout upkeep` runs:

- **daily** from a systemd user timer, and
- **lazily**: any `fanout` command starts it detached in the background when the last successful upkeep is over 24 h old.

Steps, each independent and logged as an `upkeep` event:

1. `doctor`: CLIs present, auth valid, data dir writable.
2. Discover: diff each adapter's `listModels()` against the catalog. New models are auto-tiered as `trial`; missing ones
   get `model_gone` and stop being routed.
3. Benchmarks: refresh from Artificial Analysis, Arena WebDev and FrontierCode 2.0 when the newest snapshot is over 7
   days old. Extraction is done by a cheap worker through `fanout run` on public data. Failure keeps the old values.
4. Learn patterns from repeated unknown errors.
5. Write `~/.local/share/fanout/status.json` for fast reads.

Nothing in upkeep asks the user. Results surface through `fanout status --brief`.

### Works from every harness

1. The CLI on PATH through `~/.agents/bin`.
2. The shared `fanout` skill in `~/.agents/skills`, synced to all six skill folders. Its preflight runs
   `fanout status --brief`, so status works without hooks.
3. One pointer line in `~/.agents/AGENTS.md` (reaches Codex and Gemini) and in `~/.claude/CLAUDE.md`.
4. Hooks where a harness supports them (Claude Code: SessionStart status line, Stop report check).
5. The caller is detected from environment variables, with `unknown` as the fallback.

### Policy change to `08-fanout.md`

- Still asked: the initial dispatch. The question names the chunks plus the `fanout pick` result: harness, model, tier,
  billing and the cost estimate when paid.
- New: **an approved dispatch covers its own automatic fallbacks, retries and escalations.** Each one is reported to the
  user after it happens, with cost when paid.
- `fanout pick` replaces "list the models and ask which to use".

## Build order

All phases ship as one delivery. The order only reduces risk.

1. Core: event writer, catalog merge, `run`/`pick`/`status`/`ack`/`verdict`, adapters for codex, agy and meta, fallback,
   cost, result block, Stop hook, shared skill, PATH, AGENTS.md pointer.
2. Upkeep: timer, lazy trigger, discovery, auto-tier, trial gating, doctor, learned patterns.
3. Benchmarks auto-refresh, adapters for river, opencode and claude-fanout, `report`, doc 24, thinning the old skills.

Tests use a fake adapter that replays scripted outputs (ok, 429 with a reset time, credits exhausted, auth error,
unknown error, timeout) so fallback, cooldown and reporting are tested without spending quota.

## Builder-check resolutions (designer's calls, 2026-11-15)

- **Workspace on fallback:** `run` gives every attempt a fresh workspace. In a git repo: a new worktree from the same
  base commit per attempt; a failed attempt's worktree is kept for inspection and removed by upkeep after 7 days. Outside
  git: fall back only when the failed attempt changed no files; otherwise stop and report.
- **Concurrency:** `run` is a blocking, foreground command, one per chunk. Running jobs hold a lease file (PID + heartbeat)
  in `~/.local/share/fanout/run/`. A lease with a dead PID is stale and ignored; its job is logged as `worker_error`.
- **Upkeep never spends paid credit.** It may use only `free` or `subscription` models. Anything it did is listed by
  `fanout status --brief` at the next session.
- **`--model` is a starting point, not a pin.** Fallback still applies and is reported. `--pin` forbids fallback.
- **The repo starts fresh** with `git init` and no remote.

## User answers (2026-11-15)

- **River is paid credit in USD.** River jobs get COST lines like Meta.
- **kd, respan, devin, gonka are marked retired** in the catalog. Their skill folders stay; nothing is deleted.
- **ModelScope gets an adapter.** It bills Magicubes (MC) per upstream call (about 1 MC standard, 2 MC flagship), not
  tokens. So:
  - Billing type `per_call`, unit `MC`. The COST line reports calls and MC, never USD.
  - Estimate = turn allowance x tier rate, labelled as an upper-bound guess. Actual = upstream calls counted from the
    CLIProxyAPI request log for the job's time window and route, when the log allows it; otherwise "unmeasured".
  - The picker sends ModelScope **bundled, large chunks** and keeps many small chunks elsewhere, as the existing skill
    requires.
  - ModelScope lists many models. Discovery auto-tiers them from benchmarks like any other harness.
- **Every new model, on any harness, passes a smoke test before routing**: one bounded tool-edit task (write one file,
  check its bytes). Catalog membership is not compatibility. Smoke tests use only free or subscription models, or at
  most 2 calls on per-call billing; they are reported by `fanout status --brief`.

## Left to the builder

- Exact regexes per adapter, and the default tier per task kind.
- How each harness exposes a session id and identifies itself through environment variables.
- Per-kind default token priors for cost estimates.
- Whether codex exposes remaining quota. If it does, add a proactive probe to its adapter.
- File and module names inside the repo.
