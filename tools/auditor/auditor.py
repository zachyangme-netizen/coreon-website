#!/usr/bin/env python3
"""
Coreon Site Auditor — phase 1, read-only.

Walks an existing website repo, detects the stack, and emits a ranked issue
report WITHOUT modifying any code. Safety is by construction: the tool schema
handed to the model contains only read-only tools, and every path is resolved
under the target repo root before disk access.

Usage:
    python auditor.py /path/to/repo

Writes to the current working directory:
    audit-report.json   machine-readable findings (feeds the next phase)
    audit-report.md     human-readable, ranked, quick wins surfaced
"""

import json
import os
import re
import sys
import time

# ── Config knobs ────────────────────────────────────────────────────────────
# Everything tunable lives here so behaviour is obvious and greppable.

MODEL = "claude-sonnet-5"          # configurable; use an opus model for gnarly repos
MAX_TURNS = 40                     # hard budget on agent<->tool round-trips

# Directories the walker never descends into (build output / deps / vcs).
IGNORE_DIRS = {
    "node_modules", ".git", "dist", "build", ".next", "out",
    "coverage", ".venv", "venv", "__pycache__", ".cache",
    ".turbo", ".parcel-cache", ".svelte-kit", "vendor",
}

# File extensions we treat as text (read/grep). Anything else is opaque.
TEXT_EXT = {
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte",
    ".html", ".css", ".scss", ".sass", ".less", ".json", ".jsonc",
    ".md", ".mdx", ".txt", ".yml", ".yaml", ".toml", ".ini", ".env",
    ".py", ".rb", ".php", ".go", ".rs", ".java", ".kt", ".sh",
    ".xml", ".svg", ".graphql", ".gql", ".sql", ".astro",
}

READ_BYTE_CAP = 60_000     # max bytes returned from a single read_file call
GREP_MATCH_CAP = 200       # max matches returned from a single grep call
TREE_ENTRY_CAP = 2_000     # max entries returned from a single list_tree call


# ── The sandbox: one chokepoint every path must pass through ─────────────────

class SandboxError(Exception):
    """Raised when a requested path escapes the repo root."""


def _safe_path(repo_root, rel_path):
    """Resolve `rel_path` (given by the model) under repo_root, or refuse.

    Uses realpath (follows symlinks, collapses '..') then checks containment
    with commonpath — component-wise, so string-prefix tricks don't fool it.
    Returns the resolved absolute path. Raises SandboxError on escape.
    """
    rel_path = (rel_path or ".").strip()
    # Treat the model's path as relative to the repo, even if it starts with '/'.
    rel_path = rel_path.lstrip("/\\") if rel_path not in (".", "") else "."
    candidate = os.path.realpath(os.path.join(repo_root, rel_path))
    root = os.path.realpath(repo_root)
    if candidate != root and os.path.commonpath([candidate, root]) != root:
        raise SandboxError(f"path escapes repo root: {rel_path}")
    return candidate


def _is_text(path):
    return os.path.splitext(path)[1].lower() in TEXT_EXT


def _rel(repo_root, abs_path):
    """Display paths relative to the repo root, never leaking absolute paths."""
    return os.path.relpath(abs_path, repo_root)


# ── Tool implementations (all read-only) ────────────────────────────────────

def tool_list_tree(repo_root, path="."):
    try:
        base = _safe_path(repo_root, path)
    except SandboxError as e:
        return f"ERROR: {e}"
    if not os.path.exists(base):
        return f"ERROR: no such path: {path}"
    lines, count, truncated = [], 0, False
    for dirpath, dirnames, filenames in os.walk(base):
        # Prune ignored dirs in place so os.walk never descends into them.
        dirnames[:] = sorted(d for d in dirnames if d not in IGNORE_DIRS)
        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            if count >= TREE_ENTRY_CAP:
                truncated = True
                break
            try:
                size = os.path.getsize(full)
            except OSError:
                size = 0
            lines.append(f"{_rel(repo_root, full)}\t{size}B")
            count += 1
        if truncated:
            break
    header = f"{count} entries under {path} (dirs skipped: {', '.join(sorted(IGNORE_DIRS))})"
    body = "\n".join(lines) if lines else "(empty)"
    note = f"\n... TRUNCATED at {TREE_ENTRY_CAP} entries; list a subdirectory to see more." if truncated else ""
    return f"{header}\n{body}{note}"


def tool_read_file(repo_root, path, start_line=None, end_line=None):
    try:
        target = _safe_path(repo_root, path)
    except SandboxError as e:
        return f"ERROR: {e}"
    if not os.path.isfile(target):
        return f"ERROR: not a file: {path}"
    if not _is_text(target):
        return f"ERROR: not a recognised text file: {path}"
    try:
        with open(target, "r", encoding="utf-8", errors="replace") as f:
            all_lines = f.readlines()
    except OSError as e:
        return f"ERROR: could not read {path}: {e}"

    total = len(all_lines)
    if start_line is not None or end_line is not None:
        s = max(1, int(start_line or 1))
        e = min(total, int(end_line or total))
        selected = all_lines[s - 1:e]
        offset = s
        span = f"lines {s}-{e} of {total}"
    else:
        selected = all_lines
        offset = 1
        span = f"lines 1-{total} of {total}"

    numbered, size, truncated = [], 0, False
    for i, line in enumerate(selected, start=offset):
        size += len(line.encode("utf-8"))
        if size > READ_BYTE_CAP:
            truncated = True
            break
        numbered.append(f"{i}\t{line.rstrip(chr(10))}")
    note = (f"\n... TRUNCATED at {READ_BYTE_CAP} bytes; request a smaller "
            f"start_line/end_line range." if truncated else "")
    return f"{path} ({span})\n" + "\n".join(numbered) + note


def tool_grep(repo_root, pattern, path="."):
    try:
        base = _safe_path(repo_root, path)
    except SandboxError as e:
        return f"ERROR: {e}"
    try:
        rx = re.compile(pattern)
    except re.error as e:
        return f"ERROR: bad regex: {e}"

    targets = []
    if os.path.isfile(base):
        targets = [base]
    else:
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS]
            for fn in sorted(filenames):
                full = os.path.join(dirpath, fn)
                if _is_text(full):
                    targets.append(full)

    matches, truncated = [], False
    for full in targets:
        if truncated:
            break
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                for n, line in enumerate(f, start=1):
                    if rx.search(line):
                        matches.append(f"{_rel(repo_root, full)}:{n}: {line.rstrip()[:300]}")
                        if len(matches) >= GREP_MATCH_CAP:
                            truncated = True
                            break
        except OSError:
            continue
    if not matches:
        return f"no matches for /{pattern}/ under {path}"
    note = (f"\n... TRUNCATED at {GREP_MATCH_CAP} matches; narrow the pattern "
            f"or path." if truncated else "")
    return "\n".join(matches) + note


# ── Tool schemas: THIS list is the capability boundary ──────────────────────
# The model can call exactly these four tools. Three read; one submits and ends.
# There is deliberately no write/edit/exec/delete tool anywhere.

CATEGORIES = [
    "correctness", "types", "tests", "accessibility", "performance",
    "security", "dead-code", "duplication", "maintainability",
    "dependencies", "seo", "config",
]

TOOLS = [
    {
        "name": "list_tree",
        "description": "Recursively list files under a path (relative to repo root). "
                       "Skips build/dependency dirs; shows file sizes; capped. "
                       "Use this to orient before reading.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "dir path relative to repo root; default '.'"}},
        },
    },
    {
        "name": "read_file",
        "description": "Read a text file, or a line-range slice of one. Output is "
                       "byte-capped with a truncation notice; on large files pass "
                       "start_line/end_line to read a slice.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "start_line": {"type": "integer"},
                "end_line": {"type": "integer"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "grep",
        "description": "Regex search across text files. Returns 'path:line: content', "
                       "match-capped. Use to locate patterns without reading whole files.",
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string"},
                "path": {"type": "string", "description": "dir or file relative to repo root; default '.'"},
            },
            "required": ["pattern"],
        },
    },
    {
        "name": "submit_report",
        "description": "Submit the final audit and END the run. Call exactly once, "
                       "when analysis is complete.",
        "input_schema": {
            "type": "object",
            "properties": {
                "stack": {"type": "string", "description": "detected stack, one line"},
                "summary": {"type": "string", "description": "2-4 sentence overall assessment"},
                "issues": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "category": {"type": "string", "enum": CATEGORIES},
                            "severity": {"type": "string", "enum": ["high", "medium", "low"]},
                            "effort": {"type": "string", "enum": ["small", "medium", "large"]},
                            "files": {"type": "array", "items": {"type": "string"}},
                            "evidence": {"type": "string", "description": "concrete, observed; no generic advice"},
                            "suggested_fix": {"type": "string"},
                        },
                        "required": ["title", "category", "severity", "effort", "files", "evidence", "suggested_fix"],
                    },
                },
            },
            "required": ["stack", "summary", "issues"],
        },
    },
]

SYSTEM_PROMPT = """\
You are a senior software auditor with READ-ONLY access to a website codebase. \
You cannot modify anything — you only have tools to list, read, and search files, \
and a tool to submit your findings.

Method:
1. Detect the stack FIRST. Read package.json, config files, and entry points to \
   learn the framework, language, tooling, and conventions actually in use.
2. Audit AGAINST that stack's best practices. Nothing is hardcoded — judge the \
   code by what its own stack expects.
3. Navigate selectively. Use list_tree and grep to find what matters, then read \
   only the relevant slices. Do not read the whole repo; use line ranges on big files.
4. Cite REAL evidence from REAL files — concrete observations with file paths and \
   line numbers, never generic advice.
5. Prefer fewer sharp, high-signal issues over a long shallow list.

When your analysis is complete, call submit_report exactly once. Every issue must \
name real files and describe what you actually observed."""


# ── Tool dispatch ───────────────────────────────────────────────────────────

def dispatch_tool(repo_root, name, args):
    """Route a model tool call to its implementation. Read tools only."""
    if name == "list_tree":
        return tool_list_tree(repo_root, args.get("path", "."))
    if name == "read_file":
        return tool_read_file(repo_root, args["path"], args.get("start_line"), args.get("end_line"))
    if name == "grep":
        return tool_grep(repo_root, args["pattern"], args.get("path", "."))
    return f"ERROR: unknown tool: {name}"


# ── The agent loop ──────────────────────────────────────────────────────────

def run_audit(client, repo_root):
    """Drive the model until it calls submit_report or the turn budget runs out.
    Returns the report dict, or None if no report was produced."""
    messages = [{
        "role": "user",
        "content": f"Audit the repository at its root ('.'). Begin by detecting the stack.",
    }]
    total_in = total_out = 0
    nudged = False

    for turn in range(1, MAX_TURNS + 1):
        t0 = time.time()
        resp = client.messages.create(
            model=MODEL,
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            tools=TOOLS,
            messages=messages,
        )
        dt = time.time() - t0
        total_in += resp.usage.input_tokens
        total_out += resp.usage.output_tokens
        print(f"[turn {turn:>2}] {dt:5.1f}s  "
              f"in={resp.usage.input_tokens:>6} out={resp.usage.output_tokens:>5}  "
              f"cum_in={total_in} cum_out={total_out}  stop={resp.stop_reason}")

        # Record the assistant turn verbatim (required to continue the thread).
        messages.append({"role": "assistant", "content": resp.content})

        tool_uses = [b for b in resp.content if b.type == "tool_use"]

        # Terminal: did the model submit its report this turn?
        for b in tool_uses:
            if b.name == "submit_report":
                print(f"[auditor] report submitted on turn {turn}.")
                return b.input

        if not tool_uses:
            # No tools, no report. Nudge once, then give up.
            if nudged:
                print("[auditor] model produced no tool call twice; stopping.")
                return None
            nudged = True
            messages.append({"role": "user", "content":
                "You did not call a tool. If your analysis is complete, call "
                "submit_report now. Otherwise continue investigating."})
            continue

        # Run each requested read tool; collect results into one user turn.
        results = []
        for b in tool_uses:
            out = dispatch_tool(repo_root, b.name, b.input or {})
            preview = out.splitlines()[0] if out else ""
            print(f"           -> {b.name}({json.dumps(b.input)[:80]}) :: {preview[:80]}")
            results.append({"type": "tool_result", "tool_use_id": b.id, "content": out})
        messages.append({"role": "user", "content": results})

    print(f"[auditor] MAX_TURNS ({MAX_TURNS}) reached with no report.")
    return None


# ── Report rendering ────────────────────────────────────────────────────────

SEV_RANK = {"high": 0, "medium": 1, "low": 2}
EFF_RANK = {"small": 0, "medium": 1, "large": 2}


def _sort_key(issue):
    # severity descending (high first), then effort ascending (small first).
    return (SEV_RANK.get(issue.get("severity"), 9), EFF_RANK.get(issue.get("effort"), 9))


def write_json_report(report, out_path):
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"[auditor] wrote {out_path}")


def _render_issue(issue):
    files = ", ".join(f"`{p}`" for p in issue.get("files", [])) or "_none cited_"
    return (
        f"#### {issue.get('title','(untitled)')}\n\n"
        f"- **Category:** {issue.get('category','?')}  **Effort:** {issue.get('effort','?')}\n"
        f"- **Files:** {files}\n"
        f"- **Evidence:** {issue.get('evidence','')}\n"
        f"- **Suggested fix:** {issue.get('suggested_fix','')}\n"
    )


def write_md_report(report, out_path):
    issues = sorted(report.get("issues", []), key=_sort_key)
    n_high = sum(1 for i in issues if i.get("severity") == "high")
    n_med = sum(1 for i in issues if i.get("severity") == "medium")
    n_low = sum(1 for i in issues if i.get("severity") == "low")
    quick_wins = [i for i in issues
                  if i.get("severity") in ("high", "medium") and i.get("effort") == "small"]

    parts = []
    parts.append("# Audit Report\n")
    parts.append(f"**Detected stack:** {report.get('stack','(unknown)')}\n")
    parts.append(f"\n{report.get('summary','')}\n")
    parts.append(f"\n**Findings:** {n_high} high · {n_med} medium · {n_low} low "
                 f"({len(issues)} total)\n")

    if quick_wins:
        parts.append("\n## Quick wins\n")
        parts.append("_High/medium severity, small effort — do these first._\n\n")
        for i in quick_wins:
            parts.append(_render_issue(i))
            parts.append("\n")

    for sev, label in (("high", "High severity"), ("medium", "Medium severity"), ("low", "Low severity")):
        band = [i for i in issues if i.get("severity") == sev]
        if not band:
            continue
        parts.append(f"\n## {label}\n\n")
        for i in band:
            parts.append(_render_issue(i))
            parts.append("\n")

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("".join(parts))
    print(f"[auditor] wrote {out_path}")


def main():
    if len(sys.argv) != 2:
        print("usage: python auditor.py /path/to/repo", file=sys.stderr)
        sys.exit(2)
    repo_root = os.path.abspath(sys.argv[1])
    if not os.path.isdir(repo_root):
        print(f"not a directory: {repo_root}", file=sys.stderr)
        sys.exit(2)
    print(f"[auditor] target repo: {repo_root}")
    print(f"[auditor] model: {MODEL}  max_turns: {MAX_TURNS}")

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERROR: set the ANTHROPIC_API_KEY environment variable.", file=sys.stderr)
        sys.exit(1)

    try:
        from anthropic import Anthropic
    except ImportError:
        print("ERROR: pip install anthropic", file=sys.stderr)
        sys.exit(1)

    client = Anthropic(api_key=api_key)
    report = run_audit(client, repo_root)

    if report is None:
        print("[auditor] no report produced; nothing written.", file=sys.stderr)
        sys.exit(1)

    write_json_report(report, os.path.join(os.getcwd(), "audit-report.json"))
    write_md_report(report, os.path.join(os.getcwd(), "audit-report.md"))
    issues = report.get("issues", [])
    print(f"[auditor] done: {len(issues)} issue(s).")


if __name__ == "__main__":
    main()
