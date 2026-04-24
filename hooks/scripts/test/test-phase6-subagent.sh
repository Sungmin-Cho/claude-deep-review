#!/usr/bin/env bash
# test-phase6-subagent.sh — Phase 6 subagent delegation 구조 회귀 검증
# exit 0 = 10개 체크 모두 PASS, exit 1 = 1건 이상 FAIL.

set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PASS=0
FAIL=0
fail() { echo "FAIL [$1] $2"; FAIL=$((FAIL+1)); }
pass() { echo "PASS [$1] $2"; PASS=$((PASS+1)); }

AGENT="$ROOT/agents/phase6-implementer.md"
CMD="$ROOT/commands/deep-review.md"
RCVSKILL="$ROOT/skills/receiving-review/SKILL.md"
PROTO="$ROOT/skills/receiving-review/references/response-protocol.md"
FORMAT="$ROOT/skills/receiving-review/references/response-format.md"

# 범위 추출 헬퍼: 첫 `^<start_pat>` 라인부터 다음 `^<end_pat>` 라인 직전까지
# awk range의 "start==end" 문제를 회피하기 위해 grep -n 으로 라인 번호를 얻어 sed로 자른다.
extract_range() {
  local file="$1"; local start_pat="$2"; local end_pat="$3"
  local start end
  start=$(grep -nE "$start_pat" "$file" | head -1 | cut -d: -f1)
  [[ -z "$start" ]] && return 1
  end=$(tail -n "+$((start+1))" "$file" | grep -nE "$end_pat" | head -1 | cut -d: -f1)
  if [[ -n "$end" ]]; then
    end=$((start + end - 1))
    sed -n "${start},${end}p" "$file"
  else
    sed -n "${start},\$p" "$file"
  fi
}

# 1. agents/phase6-implementer.md 존재 + frontmatter 파싱 가능 (PyYAML 또는 awk fallback)
if [[ ! -f "$AGENT" ]]; then
  fail 1 "agent file missing: $AGENT"
else
  if python3 -c "import yaml" 2>/dev/null; then
    # PyYAML 가용: 엄격 YAML 파싱
    python3 - "$AGENT" <<'PY' 2>/dev/null && pass 1 "agent frontmatter parseable (PyYAML)" || fail 1 "agent frontmatter parse error"
import sys, yaml
with open(sys.argv[1]) as f:
    text = f.read()
parts = text.split("---", 2)
if len(parts) < 3:
    sys.exit(1)
yaml.safe_load(parts[1])
PY
  else
    # PyYAML 부재: awk로 frontmatter 경계만 검증 (--- 2회 존재 확인)
    if awk '/^---$/{c++} END{exit (c>=2?0:1)}' "$AGENT"; then
      pass 1 "agent frontmatter boundaries present (awk fallback — PyYAML not installed)"
    else
      fail 1 "agent frontmatter boundaries missing"
    fi
  fi
fi

# 2. frontmatter에 name, model: sonnet, tools 필드 존재
if [[ -f "$AGENT" ]]; then
  if grep -qE '^name: *phase6-implementer' "$AGENT" \
     && grep -qE '^model: *sonnet' "$AGENT" \
     && grep -qE '^tools:' "$AGENT"; then
    pass 2 "agent frontmatter fields present"
  else
    fail 2 "agent frontmatter missing required fields (name/model/tools)"
  fi
fi

# 3. tools 목록에 Agent/ExitPlanMode/NotebookEdit 불포함 (whitelist)
if [[ -f "$AGENT" ]]; then
  # frontmatter 내의 tools 블록만 검사 (첫 번째 --- 와 두 번째 --- 사이)
  fm=$(awk '/^---$/{c++; next} c==1' "$AGENT")
  if echo "$fm" | grep -qE '^\s*-\s*(Agent|ExitPlanMode|NotebookEdit)\s*$'; then
    fail 3 "tools list contains forbidden tool (Agent/ExitPlanMode/NotebookEdit)"
  else
    pass 3 "tools whitelist respected"
  fi
fi

# 4. commands/deep-review.md 에 phase6-implementer 참조 문자열 존재
if grep -q "phase6-implementer" "$CMD"; then
  pass 4 "phase6-implementer referenced in commands/deep-review.md"
else
  fail 4 "phase6-implementer not referenced in commands/deep-review.md"
fi

# 5. commands/deep-review.md 의 init 모드 .gitignore 권장 블록에 .deep-review/tmp/ 존재
# extract_range: "### 8. .gitignore" 라인부터 다음 "### " 라인 직전까지
gitignore_block=$(extract_range "$CMD" '^### 8\. \.gitignore' '^### [0-9]')
if echo "$gitignore_block" | grep -q "\.deep-review/tmp/"; then
  pass 5 ".deep-review/tmp/ present in init .gitignore block"
else
  fail 5 ".deep-review/tmp/ missing from init .gitignore block"
fi

# 6. response-format.md 에 execution_path 필드 언급 (snake_case 정식 표기, 스펙 §4.2)
if grep -q "execution_path" "$FORMAT"; then
  pass 6 "execution_path field documented in response-format.md"
else
  fail 6 "execution_path field missing from response-format.md"
fi

# 7. commands/deep-review.md --respond Steps 에 "subagent dispatch" 문구 존재
# extract_range로 Steps (대응 모드) ~ Steps (init 모드) 사이만 추출
respond_block=$(extract_range "$CMD" '^## Steps \(대응 모드' '^## Steps \(init 모드')
if echo "$respond_block" | grep -qi "subagent dispatch\|서브에이전트 dispatch"; then
  pass 7 "subagent dispatch section present in --respond Steps"
else
  fail 7 "subagent dispatch section missing from --respond Steps"
fi

# 8. response-protocol.md Phase 6 섹션에 "group dispatch" 키워드
# extract_range로 Phase 6 ~ 다음 ^## 헤더 사이만 추출 (start != end)
phase6_block=$(extract_range "$PROTO" '^## Phase 6' '^## [^P]|^## P[^h]')
if echo "$phase6_block" | grep -qi "group dispatch\|그룹 dispatch\|심각도 그룹"; then
  pass 8 "group dispatch keyword present in response-protocol.md Phase 6"
else
  fail 8 "group dispatch keyword missing from response-protocol.md Phase 6"
fi

# 9. response-format.md 에 execution_path 4개 값 모두 문서화
missing=""
for v in "subagent" "main_fallback" "mixed" "n/a"; do
  if ! grep -q "$v" "$FORMAT"; then missing="$missing $v"; fi
done
if [[ -z "$missing" ]]; then
  pass 9 "all 4 execution_path values documented"
else
  fail 9 "execution_path values missing:$missing"
fi

# 10. 'Execution path' (공백+대문자 backtick 변형) 금지 — 스펙 §4.2 snake_case 원칙
# (대상: commands/, skills/, agents/, docs/ — .deep-review/reports는 사용자 리뷰 기록 자유)
offenders=$(grep -rnE '`Execution path`' "$ROOT/commands" "$ROOT/skills" "$ROOT/agents" "$ROOT/docs" 2>/dev/null || true)
if [[ -z "$offenders" ]]; then
  pass 10 "no 'Execution path' (capitalized backtick variant) in commands/skills/agents/docs"
else
  fail 10 "forbidden 'Execution path' variant found:\n$offenders"
fi

echo "---"
echo "Total: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
