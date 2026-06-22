#!/usr/bin/env bash
# Build the change_files manifest (JSONL) for the full Stage-1 review target set.
# Uses python3 for correct JSON encoding (all C0 control bytes), rename/copy
# arity + score splitting, and deterministic path-byte sort. NUL-safe.
set -Eeuo pipefail

repo="."; change_state=""; review_base=""; files_from=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:-.}"; shift 2;;
    --change-state) change_state="${2:-}"; shift 2;;
    --review-base) review_base="${2:-}"; shift 2;;
    --files-from-z) files_from="${2:-}"; shift 2;;   # NUL-delimited manual/session paths
    *) echo "build-change-files: unknown arg: $1" >&2; exit 2;;
  esac
done
command -v python3 >/dev/null 2>&1 || { echo "build-change-files: python3 required (change_files omitted)" >&2; exit 4; }
if [ "$change_state" = "clean" ] && [ -z "$review_base" ]; then
  echo "build-change-files: --review-base required for clean state" >&2; exit 2
fi

REPO="$repo" STATE="$change_state" BASE="$review_base" FILES_FROM="$files_from" \
MAX_ENTRIES="${OCR_CHANGE_FILES_MAX_ENTRIES:-500}" python3 - <<'PY'
import os, json, subprocess, sys
repo=os.environ["REPO"]; state=os.environ["STATE"]; base=os.environ.get("BASE","")
ff=os.environ.get("FILES_FROM",""); maxn=int(os.environ.get("MAX_ENTRIES","500"))
def git_z(*args):
    r=subprocess.run(["git","-C",repo,*args],capture_output=True)
    if r.returncode!=0:
        sys.stderr.write("build-change-files: git %s failed: %s\n"%(" ".join(args), r.stderr.decode("utf-8","replace")))
        sys.exit(5)                      # → orchestrator omits change_files + warns
    return [x for x in r.stdout.split(b"\0") if x!=b""]
items={}  # path-bytes -> record dict (later inserts do not override earlier richer ones)
# --- Stage-1 review-target exclusions (MUST mirror commands/deep-review.md:172,
# the diff exclusion list — keep in sync). change_files == the exact review DIFF
# target set (spec §4.1), so any path the diff omits must be omitted here too;
# otherwise reviewers see out-of-scope files (vendored/build/generated/lock/binary).
# Applied to the DECODED path so glob/segment matching is on real path text while
# the dict key stays the raw path-bytes (NUL-safety + byte-sort preserved).
import fnmatch, posixpath
EXCLUDE_SEGMENTS={"node_modules","dist","build",".next","target",".venv",
                  "__pycache__",".pytest_cache","vendor",".git"}
EXCLUDE_BASENAME_GLOBS=("*.min.js","*.generated.*","*.lock",".DS_Store")
def is_excluded(path_str):
    # path_str is the surrogateescape-decoded git path (forward-slash separated).
    parts=path_str.split("/")
    if EXCLUDE_SEGMENTS.intersection(parts):  # any path segment is an excluded dir
        return True
    base=parts[-1] if parts else path_str
    return any(fnmatch.fnmatch(base, g) for g in EXCLUDE_BASENAME_GLOBS)
def add(rec):  # rec is a dict with bytes 'p' key
    if is_excluded(rec["path"]):           # path-glob/segment excludes (required)
        rec.pop("p"); return               # drop out-of-scope path before recording
    if rec["path"] in binary_paths:        # binary excludes (best-effort numstat)
        rec.pop("p"); return
    items.setdefault(rec.pop("p"), rec)
def dec(b): return b.decode("utf-8","surrogateescape")
# Best-effort binary detection: `git diff -z --numstat` emits "-\t-\t" for binary
# blobs. Same -z record model as name-status: a rename/copy row is "added\tdeleted\t"
# (empty path field) followed by two standalone NUL tokens old,new; a normal row is
# one "added\tdeleted\tpath" token. We key on the SURVIVING (new) decoded path, the
# same path parse_name_status records. Failure is non-fatal (binary set stays empty —
# limitation: path-glob excludes still apply, only binary-by-content may slip through).
binary_paths=set()
def collect_binary(*args):
    try:
        r=subprocess.run(["git","-C",repo,*args],capture_output=True)
        if r.returncode!=0: return
        toks=r.stdout.split(b"\0")
        i=0; n=len(toks)
        while i<n:
            if toks[i]==b"": i+=1; continue
            fields=toks[i].split(b"\t",2)
            i+=1
            if len(fields)<3: continue
            added,deleted,pathfield=fields[0],fields[1],fields[2]
            is_bin=(added==b"-" and deleted==b"-")
            if pathfield==b"":                       # rename/copy: next two tokens
                if i+1>=n: break
                new=toks[i+1]; i+=2
                if is_bin: binary_paths.add(dec(new))
            else:
                if is_bin: binary_paths.add(dec(pathfield))
    except Exception:
        pass
def parse_name_status(tokens):
    i=0; n=len(tokens)
    while i<n:
        st=tokens[i].decode("ascii","replace"); i+=1
        letter=st[:1]
        if letter in ("R","C"):
            if i+1>=n: sys.stderr.write("build-change-files: truncated rename/copy record\n"); sys.exit(5)
            old=tokens[i]; new=tokens[i+1]; i+=2
            rec={"p":new,"status":letter,"path":dec(new),"old_path":dec(old)}
            if st[1:]: rec["score"]=st[1:]
            add(rec)
        else:
            if i>=n: sys.stderr.write("build-change-files: truncated status record\n"); sys.exit(5)
            p=tokens[i]; i+=1
            add({"p":p,"status":letter,"path":dec(p)})
# Populate binary_paths from the SAME range before parse_name_status (add() reads it).
if state=="clean":
    collect_binary("diff","-z","--numstat","-M","-C",f"{base}..HEAD")
    parse_name_status(git_z("diff","-z","--name-status","-M","-C",f"{base}..HEAD"))
elif state=="staged":
    collect_binary("diff","-z","--numstat","-M","-C","--cached")
    parse_name_status(git_z("diff","-z","--name-status","-M","-C","--cached"))
elif state=="unstaged":
    collect_binary("diff","-z","--numstat","-M","-C")
    parse_name_status(git_z("diff","-z","--name-status","-M","-C"))
elif state=="mixed":
    collect_binary("diff","-z","--numstat","-M","-C","HEAD")
    parse_name_status(git_z("diff","-z","--name-status","-M","-C","HEAD"))
elif state=="initial":
    for p in git_z("ls-files","-z","--cached","--others","--exclude-standard"):
        add({"p":p,"status":"initial","path":dec(p)})
elif state in ("untracked-only","non-git"): pass
else: sys.stderr.write(f"build-change-files: unknown state {state}\n"); sys.exit(2)
# has_untracked union for every git state except initial/non-git
if state not in ("initial","non-git"):
    for p in git_z("ls-files","-z","--others","--exclude-standard"):
        add({"p":p,"status":"untracked","path":dec(p)})
# manual / session-inferred paths (non-git or session-expansion)
if ff and os.path.exists(ff):
    with open(ff,"rb") as fh:
        for p in fh.read().split(b"\0"):
            if p: add({"p":p,"status":("non-git" if state=="non-git" else "session"),"path":dec(p)})
rows=[items[k] for k in sorted(items)]            # deterministic path-byte sort
# ensure_ascii=True: non-UTF-8 path bytes (surrogateescape) are emitted as \uXXXX,
# keeping the JSONL strictly ASCII/UTF-8 valid (R2 fix — ensure_ascii=False could
# print raw invalid bytes or raise UnicodeEncodeError on lone surrogates).
for d in rows[:maxn]: print(json.dumps(d, ensure_ascii=True))
if len(rows)>maxn: print(json.dumps({"omitted":len(rows)-maxn,"truncated":True}))
PY
