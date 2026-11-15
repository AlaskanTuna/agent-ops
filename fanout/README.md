# Fanout

One CLI dispatches a chunk of bulk work to the right worker model from any harness, falls back automatically on quota and credit walls, and records every job in an append-only ledger.

## Install

Build a copy of the current tree, then install it:

```bash
bash fanout/install/build.sh
bash ~/.local/lib/agent-ops/fanout/<id>/install.sh
```

The installer links the built copy onto `PATH`, adds the skill links, and wires a daily upkeep timer. Roll back by running an older build's `install.sh`.

## Commands

- `fanout pick --brief <f> --dir <d> --kind <k>` — show the ranked chain.
- `fanout run --brief <f> --dir <d> --kind <k> --expect <h>/<m>` — run it.
- `fanout wait <job>` — block up to 9 minutes for a detached chain.
- `fanout status [--brief]`, `fanout ack <job>`, `fanout verdict <job> accepted|rejected`.
- `fanout report [--since 30d]` — DuckDB analytics over the ledger.
- `fanout doctor`, `fanout upkeep`, `fanout benchmarks import <file>`.

## Data layout

Runtime data lives under `~/.local/share/agent-ops/fanout/` (`events/`, `learned/`, `run/`, `logs/`, `worktrees/`, `patches/`, `smoke/`, `mined/`, `status.json`, `errors.log`). `FANOUT_HOME` overrides it. Never commit ledger data.

## Catalog layers

`~/.config/agent-ops/catalog.csv` (private) over `fanout/catalog/catalog.default.csv` (public data only) over auto-discovered rows. A private row overrides only its non-empty cells; `model` of `*` applies to a whole harness. Change a tier, retire a model, or add a note in the private file, never in the repo.

## How to add an adapter

Add `fanout/src/adapters/<name>.ts` implementing the adapter contract (`fanout/src/adapters/types.ts`): build the argv, classify the outcome, read usage, list models, preflight. Add `fanout/patterns/<name>.json` with the error rules, catalog rows, and CLI-level tests with stub executables on `PATH`.

## Upkeep

`fanout upkeep` runs daily from a systemd timer. It uses only free or subscription models, never spends paid USD, and refreshes benchmarks, learned patterns, and the auto catalog.

Benchmark data: [Artificial Analysis](https://artificialanalysis.ai/)
