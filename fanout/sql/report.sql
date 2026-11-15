-- Per-model-kind aggregates over the fanout ledger for `fanout report`.
-- Read by fanout/src/commands/report.ts, which replaces two tokens:
--   __EVENTS_GLOB__  absolute glob of the month files (events/*.jsonl)
--   __SINCE_TS__     ISO lower bound; older events are ignored
-- A row groups every attempt of a job id under the harness/model/kind of its
-- job_start. Verdicts join by job. fallbacks_from counts jobs in the group
-- that ended in a limit outcome and were followed by a fallback attempt
-- (a job_start with from_job pointing at them). Cost columns sum the ledger's
-- own cost_usd / cost_mc / calls; the caller fills paid costs from the
-- catalog when an old job_end has tokens but no cost_usd yet.
-- Columns are declared explicitly so a window with only one event type still
-- binds (missing fields read as NULL); unknown fields are ignored.
WITH raw AS (
  SELECT *
  FROM read_json(
    ['__EVENTS_GLOB__'],
    format = 'newline_delimited',
    columns = {
      v: 'BIGINT',
      ts: 'VARCHAR',
      event: 'VARCHAR',
      id: 'VARCHAR',
      job: 'VARCHAR',
      root: 'VARCHAR',
      harness: 'VARCHAR',
      model: 'VARCHAR',
      effort: 'VARCHAR',
      tier: 'BIGINT',
      kind: 'VARCHAR',
      data_class: 'VARCHAR',
      attempt: 'BIGINT',
      reason: 'VARCHAR',
      from_job: 'VARCHAR',
      billing: 'VARCHAR',
      brief_sha: 'VARCHAR',
      caller: 'VARCHAR',
      session: 'VARCHAR',
      repo: 'VARCHAR',
      outcome: 'VARCHAR',
      exit: 'BIGINT',
      duration_s: 'DOUBLE',
      tokens_in: 'BIGINT',
      tokens_out: 'BIGINT',
      tokens_cached: 'BIGINT',
      cost_usd: 'DOUBLE',
      cost_mc: 'DOUBLE',
      calls: 'DOUBLE',
      cost_source: 'VARCHAR',
      accepted: 'BOOLEAN'
    },
    ignore_errors = true
  )
),
ev AS (
  SELECT * FROM raw WHERE v = 1 AND ts >= '__SINCE_TS__'
),
starts AS (
  SELECT job, harness, model, kind FROM ev WHERE event = 'job_start'
),
ends AS (
  SELECT job, outcome, cost_usd, cost_mc, calls, tokens_in, tokens_cached, tokens_out
  FROM ev
  WHERE event = 'job_end'
),
verdicts AS (
  SELECT job, accepted FROM ev WHERE event = 'verdict'
),
fallbacks AS (
  SELECT DISTINCT from_job AS job FROM ev WHERE event = 'job_start' AND from_job IS NOT NULL
),
per_job AS (
  SELECT
    s.harness AS harness,
    s.model AS model,
    s.kind AS kind,
    s.job AS job,
    MAX(CASE WHEN e.outcome = 'ok' THEN 1 ELSE 0 END) AS ok,
    MAX(CASE WHEN vd.accepted IS TRUE THEN 1 ELSE 0 END) AS accepted,
    MAX(CASE WHEN vd.accepted IS FALSE THEN 1 ELSE 0 END) AS rejected,
    MAX(
      CASE WHEN e.outcome IN (
        'rate_limited',
        'quota_exhausted',
        'credits_exhausted',
        'auth_error',
        'model_unavailable'
      ) AND fb.job IS NOT NULL THEN 1 ELSE 0 END
    ) AS fell_back,
    SUM(COALESCE(e.cost_usd, 0)) AS cost_usd,
    SUM(COALESCE(e.cost_mc, 0)) AS cost_mc,
    SUM(COALESCE(e.calls, 0)) AS calls,
    SUM(COALESCE(e.tokens_in, 0)) AS tokens_in,
    SUM(COALESCE(e.tokens_cached, 0)) AS tokens_cached,
    SUM(COALESCE(e.tokens_out, 0)) AS tokens_out
  FROM starts s
  LEFT JOIN ends e ON e.job = s.job
  LEFT JOIN verdicts vd ON vd.job = s.job
  LEFT JOIN fallbacks fb ON fb.job = s.job
  GROUP BY s.harness, s.model, s.kind, s.job
)
SELECT
  harness,
  model,
  kind,
  COUNT(*) AS jobs,
  SUM(ok) AS ok,
  SUM(accepted) AS accepted,
  SUM(rejected) AS rejected,
  SUM(fell_back) AS fallbacks_from,
  SUM(cost_usd) AS cost_usd,
  SUM(cost_mc) AS cost_mc,
  SUM(calls) AS calls,
  SUM(tokens_in) AS tokens_in,
  SUM(tokens_cached) AS tokens_cached,
  SUM(tokens_out) AS tokens_out
FROM per_job
GROUP BY harness, model, kind
ORDER BY harness, model, kind;
