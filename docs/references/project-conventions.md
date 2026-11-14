# Project conventions

- agent-ops is a local operations platform for every agent harness on one machine: fanout routing and its ledger first, then DuckDB audits over each harness's own data. The design lives in [docs/superpowers/specs](/docs/superpowers/specs/).
- Refer to [markdown-style.md](/docs/references/markdown-style.md) before creating markdowns, root README.md bypass this rule.
- File every follow-up as a GitHub issue per [issue-tracker.md](/docs/agents/issue-tracker.md) and link it in your reply, instead of printing it to the terminal or leaving a checklist.
- Title commits, issues and PRs as Conventional Commits headers of at most 50 characters that pass [commitlint.config.mjs](/commitlint.config.mjs), checked with `echo "<title>" | bunx commitlint`. Squash merges append ` (#N)` to PR titles, so check those as `echo "<title> (#N)" | bunx commitlint`.
- This repo is public. Keep runtime data, ledger events, transcripts, keys and personal paths out of it; runtime data lives under `~/.local/share/agent-ops/`.
- Use each tool, API and service the way its official docs recommend: the supported command, endpoint or SDK instead of deprecated paths and workarounds. Read the docs page before relying on behavior you haven't confirmed this session, and link the pages you followed in the PR body.
- Test at the outermost seam: drive the `fanout` CLI through its public interface with the fake adapter and assert on observable results (stdout, exit code, ledger lines). Avoid unit tests of single functions or mocked collaborators. See [Matt Pocock on test seams](https://x.com/mattpocockuk/status/2059955079067713960).
- Verify every change by running `bun test` and reading its output.
- When the user corrects you, add or sharpen a rule here in the same PR, and delete rules that no longer change behavior.
- Write each rule so compliance can be checked in five seconds, and pair every don't with the do.
