-- One-off transcript mining: narrow ev to transcript files that may hold a fanout worker launch.
-- Deep parsing (tool_use/tool_result blocks, launch classification, foreground/background
-- pairing, queue-operation notifications) happens in mine.ts; this query only narrows the
-- file list so irrelevant transcripts are never read. Written for DuckDB 2.0 (lambda x: ...
-- form; no subquery in a table function, so the glob intersect happens in mine.ts via the
-- filesystem instead).
SELECT DISTINCT file, sessionId AS session
FROM ev
WHERE cmds IS NOT NULL
  AND len(
    list_filter(
      cmds,
      lambda c: c LIKE '%codex%exec%'
        OR c LIKE '%agy%'
        OR c LIKE '%worker.sh%'
        OR c LIKE '%worker.py%'
        OR c LIKE '%opencode%run%'
        OR c LIKE '%claude -p%'
    )
  ) > 0;
