# agent-ops

A local operations platform for every agent harness on one machine (Claude Code, Codex, Gemini CLI, Antigravity, Copilot).

- **fanout**: one `fanout` CLI that routes bulk work to worker models on a cost-ascending tier ladder, falls back automatically on quota or credit limits, and records every job in an append-only JSONL ledger.
- **audits** (planned): DuckDB views that read each harness's own data in place: skill usage, memory value, cross-harness usage, tool errors.

Status: design. See [the design spec](docs/superpowers/specs/2026-11-15-fanout-ledger-design.md).
