# Coreon Site Auditor (phase 1 — read-only)

A single-agent Python CLI that audits an existing website codebase and emits a
ranked issue report **without modifying any code**. This is phase 1 of the
refactor pipeline (audit → safety net → refactor → review → ship); only the
read-only auditor is built here.

## Safety model

Read-only **by construction**, not by instruction:

- The tool schema handed to the model contains only `list_tree`, `read_file`,
  `grep`, and the terminal `submit_report`. There is no write / edit / exec /
  delete tool anywhere, so the model has no capability to change the repo.
- Every path from the model is resolved with `realpath` and checked against the
  repo root with `commonpath` before any disk access — traversal (`..`) and
  symlink escapes are refused.
- Tool output is capped (bytes / matches / entries) with truncation notices, so
  the agent retrieves selectively instead of dumping the repo into context.

## Install

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
```

## Run

```bash
python auditor.py /path/to/repo
```

Writes to the current working directory:

- `audit-report.json` — structured findings (feeds the next phase)
- `audit-report.md` — human-readable, ranked, with quick wins surfaced

Progress, per-turn timing, and cumulative token usage print to the console as it
runs.

## Config

All knobs are constants at the top of `auditor.py`:

| Knob | Meaning |
|------|---------|
| `MODEL` | model id (default `claude-sonnet-5`; use an opus model for gnarly repos) |
| `MAX_TURNS` | max agent↔tool round-trips before giving up |
| `IGNORE_DIRS` | dirs the walker never descends into |
| `TEXT_EXT` | extensions treated as readable text |
| `READ_BYTE_CAP` | max bytes returned by one `read_file` |
| `GREP_MATCH_CAP` | max matches returned by one `grep` |
| `TREE_ENTRY_CAP` | max entries returned by one `list_tree` |

## Report schema (`submit_report` input)

- `stack`: detected stack, one line
- `summary`: 2–4 sentence overall assessment
- `issues[]`: `title`, `category` (one of correctness, types, tests,
  accessibility, performance, security, dead-code, duplication, maintainability,
  dependencies, seo, config), `severity` (high|medium|low),
  `effort` (small|medium|large), `files[]`, `evidence`, `suggested_fix`

Issues in the Markdown report are ranked by severity descending, then effort
ascending, so quick wins surface at the top.
