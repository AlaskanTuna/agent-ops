---
name: fanout
description: Dispatch bulk mechanical chunks to cheap worker models from any harness with automatic fallback. Use fanout pick and fanout run. Replaces the per-backend *-fanout skills.
---

# Fanout

One CLI routes each chunk of bulk work to the right worker model, falls back on quota or credit walls, and records every job. The old `*-fanout` skills stay as the manual path.

## 1. When

By kind, never by size. Mechanical, fully specified work only: transcribe, reformat, rename, summarize, extract, inventory, edit, refactor, test, issue. Never design, review, or verification.

## 2. Preflight

Run `command -v fanout`. If missing, stop and say so. Then run `fanout status --brief` and act on whatever it lists. Harnesses without hooks get status this way.

## 3. Ask the user once

Write the brief files first. Run `fanout pick --brief <f> --dir <d> --kind <k>`. Then ask one question naming the chunks, the `PICK` line, and the `PAID` line (the estimate of the first paid model in the chain, or "no paid model"). The answer covers automatic fallbacks, retries, and escalations of that dispatch.

## 4. Brief

A work order: name every file and say "and nothing else". Inputs as paths. Concrete output format. House rules. Preserve verbatim. Short report at the end. Add "Do not run git" and "Do not write report or notes files". Bundle related small files into one large brief: the picker sends only large briefs to ModelScope.

## 5. Dispatch

Run `fanout run --brief <f> --dir <d> --kind <k> --expect <harness>/<model>` with the harness and model copied from the `PICK` line. One background command per chunk, at most 6 at once, at most 3 to 6 heavy workers (memory). Workers do not run builds or e2e. For a chain that may take more than a few minutes use `--detach`, then call `fanout wait <job>` again and again (each call waits up to 9 minutes; exit 4 means still running). Whole-issue runs add `--timeout 7200 --max-turns 500`. `--model` is a starting point, `--pin` forbids fallback, `--public` and `--private` override the data class. When the user names a model as `<harness>/<model>` (for example "use omp/claude-fable-5-2 xhigh"), dispatch it as `fanout run --model <harness>/<model> --pin --effort <effort>`. Never call the harness CLI (`omp`, `codex`, `agy`, `opencode`) directly for delegated work: a raw call skips the isolated worker config, the time cap and the cost ledger. The `omp` harness runs Claude models on Anthropic API credits (real money, tier 3): its `COST` line is the cost OMP itself reports, cache writes included.

## 6. Result block rules (hard)

For every `FALLBACK` line (including `not started`, a pre-start reroute) and every `COST` line, tell the user in the next message (fallback: from, to, why; cost: estimate and actual, calls and MC for per-call), then run `fanout ack <job>`. `ack` is refused while the chain still runs, so use `fanout wait`. Never present an estimate as an actual. `FAILED job_error` means the chunk is too large or malformed (split it). `FAILED no_effect` means the worker changed nothing (read `LOG=`, re-brief). `RETRY`, `NOTE`, and `DENIALS` are informational. A desktop notification repeats each `FALLBACK` and `COST` line, but the user still hears it from you.

## 7. Verify, then record

Open `PATCH=` or `WORKTREE=`. Check artifacts against the brief (an exit code is not proof: agy exits 0 on timeout, opencode exits 0 having done nothing). Apply the patch yourself after review. Then run `fanout verdict <job> accepted|rejected`. On rejection write a new brief naming the defect and run `fanout run --escalate-from <job>`.

## 8. Benchmarks

When the user has fresh Arena WebDev or FrontierCode 2.0 figures, produce a CSV `name,metric,value,as_of` (metric `arena_webdev` or `frontiercode2`) and run `fanout benchmarks import <file>`.

## 9. Never

Paste keys. Hand-pick a `public-only` model for private data (the CLI refuses). Skip the ack. Run `fanout` from inside a worker (the CLI refuses a nested run).
