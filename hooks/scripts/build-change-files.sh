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
def add(rec):  # rec is a dict with bytes 'p' key
    items.setdefault(rec.pop("p"), rec)
def dec(b): return b.decode("utf-8","surrogateescape")
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
if state=="clean":      parse_name_status(git_z("diff","-z","--name-status","-M","-C",f"{base}..HEAD"))
elif state=="staged":   parse_name_status(git_z("diff","-z","--name-status","-M","-C","--cached"))
elif state=="unstaged": parse_name_status(git_z("diff","-z","--name-status","-M","-C"))
elif state=="mixed":    parse_name_status(git_z("diff","-z","--name-status","-M","-C","HEAD"))
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
