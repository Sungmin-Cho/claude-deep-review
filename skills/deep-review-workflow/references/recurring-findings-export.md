# recurring-findings-export — Stage 5.5 Recurring Findings Export (review-execution 에서 on-demand Read)

<!-- review-execution.md 의 Stage 5.5 precheck 에서 리포트 ≥2 일 때 Read 되어 그대로 수행된다. 동작 SSOT. -->

## Stage 5.5 — Recurring Findings Export

리포트 생성 후 자동 실행. `.deep-review/reports/` 내 리포트가 2개 미만이면 건너뜀.

**Finding Taxonomy (v1.0):**

분류 카테고리:
- `error-handling` — try-catch 누락, 에러 전파 미흡
- `naming-convention` — 네이밍 불일치, 스타일 혼용
- `type-safety` — any 타입, 타입 단언 남용
- `test-coverage` — 테스트 누락, 경계값 미검증
- `security` — 인젝션, 인증/인가 미흡
- `performance` — N+1, 불필요한 재계산
- `architecture` — 순환 의존, 레이어 침범, SRP 위반

**프로세스:**

1. `.deep-review/reports/` 내 모든 리포트를 읽어 🔴 Critical + 🟡 Warning 항목 수집

2. 각 항목을 taxonomy 카테고리로 LLM 의미 기반 분류:
   - 항목의 설명과 코드 컨텍스트를 읽고 7개 카테고리 중 가장 적합한 것을 선택
   - 하나의 LLM 호출로 전체 항목을 일괄 분류 (호출 간 비결정성 방지)

3. 같은 카테고리가 3회 이상 나타나면 "recurring"으로 분류
   - 같은 카테고리에서 severity가 혼재하면 (critical + warning), 가장 높은 severity를 채택
   - 예: error-handling이 critical 3회, warning 2회이면 → severity: "critical", occurrences: 5

4. **Payload 합성 → envelope wrap → atomic write** (M3 Phase 2 envelope adoption, v1.4.0+):

   먼저 위 분류 결과를 *payload* JSON 으로 임시 파일에 기록한다 (구조는 v1.3.x 와 동일 — envelope 으로 감쌀 뿐):

   ```json
   {
     "updated_at": "<ISO 8601>",
     "taxonomy_version": "1.0",
     "findings": [
       {
         "category": "<taxonomy category>",
         "severity": "critical|warning",
         "occurrences": "<count>",
         "example_files": ["<file:line>"],
         "description": "<패턴 설명>",
         "source_reports": ["<report filename>"]
       }
     ]
   }
   ```

   그 다음 `hooks/scripts/wrap-recurring-findings-envelope.js` 가 envelope wrap + atomic temp+rename 으로 최종 위치 (`.deep-review/recurring-findings.json`) 에 emit 한다. 이 helper 는 zero-dep, plugin module 경로 기반 (literal-cwd-resolve), `fs.renameSync` 원자 교체이므로 mid-write 중단이나 동시 실행에도 truncated JSON 을 만들지 않는다.

   **chain 의무 (handoff §3.3 mirror)**: §3 Receipt health_report 주입 단계에서 발견된 deep-work session-receipt 가 envelope-wrapped 라면 그 `envelope.run_id` 를 `--source-session-receipt <path>` 로 helper 에 전달한다 — helper 가 strict 3-way identity check (producer=deep-work, artifact_kind=session-receipt, schema.name match) 후 `parent_run_id` 로 자동 chain. legacy session-receipt 또는 foreign envelope 이면 path 만 source_artifacts 에 들어가고 chain 은 set 되지 않는다.

   **Bash snippet** (markdown agent prompt — self-contained: Bash tool 호출 간 env var 이 persist 되지 않으므로 stage 간 변수 공유 가정 금지. session-receipt 경로는 본 snippet 안에서 재탐색 — deep-evolve round-1 C1 / round-2 R2-3 교훈):

   ```bash
   set -euo pipefail
   PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
   WRAP_HELPER="${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT not set}/hooks/scripts/wrap-recurring-findings-envelope.js"
   OUTPUT_PATH="$PROJECT_ROOT/.deep-review/recurring-findings.json"
   PAYLOAD_TMP="$PROJECT_ROOT/.deep-review/.tmp-recurring-payload.$$.$RANDOM.json"

   mkdir -p "$PROJECT_ROOT/.deep-review"

   # 위 분류 단계가 PAYLOAD_TMP 에 다음 shape 의 JSON 을 기록했다고 가정:
   #   { "updated_at": "...", "taxonomy_version": "1.0", "findings": [...] }
   # (LLM 일괄 분류 결과를 jq 또는 직접 JSON 파일 작성)

   # parent_run_id chain — 본 snippet 안에서 deep-work session-receipt 재탐색.
   # SOURCE_SESSION_RECEIPT 환경변수로 caller override 가능 (있으면 우선).
   # 없으면 deep-work canonical layout `.deep-work/<sid>/session-receipt.json`
   # 의 가장 최근 파일을 자동 선택 (sid = timestamp slug, lex-sortable).
   # mindepth=2 maxdepth=2 — `.deep-work/<sid>/<file>` 만 매치, deep-review
   # imagined `.deep-work/sessions/<sid>/...` 같은 깊은 layout 은 의도적 제외
   # (Codex Round-1 Q4 lesson — sessions/ prefix 가 lex-sort 에서 timestamp 보다
   # 우선시 되어 잘못된 source 를 픽하던 회귀; helper 의 strict 3-way identity
   # guard 가 차단하므로 정확성 영향은 없었지만 UX 측면 fix).
   #
   # awk 'NR==1' 사용 (head -1 대신) — set -o pipefail 하에서 head 의 early-close 가
   # 상류 sort 로 SIGPIPE (exit 141) 를 보내 pipeline 을 abort 시키는 것을 회피
   # (Codex Round-1 Q5 lesson; macOS bash 3.2 에서 재현 확인됨).
   SESSION_RECEIPT="${SOURCE_SESSION_RECEIPT:-}"
   if [ -z "$SESSION_RECEIPT" ] && [ -d "$PROJECT_ROOT/.deep-work" ]; then
     SESSION_RECEIPT=$(find "$PROJECT_ROOT/.deep-work" -mindepth 2 -maxdepth 2 \
       \( -name 'session-receipt.json' -o -name 'receipt.json' \) -type f 2>/dev/null \
       | sort -r | awk 'NR==1')
   fi

   WRAP_ARGS=(--payload-file "$PAYLOAD_TMP" --output "$OUTPUT_PATH")
   if [ -n "$SESSION_RECEIPT" ] && [ -f "$SESSION_RECEIPT" ]; then
     WRAP_ARGS+=(--source-session-receipt "$SESSION_RECEIPT")
   fi

   # Multi-source 추적 — review report markdown 들도 source_artifacts 에 기록
   # (path-only; envelope detect 안 됨 → run_id 없음). 최근 N=20 개로 제한해
   # source_artifacts 폭증 방지. while-read 루프 + awk 'NR<=20' 사용 — head 의
   # SIGPIPE 와 IFS subshell expansion 을 모두 회피 (bash 3.2 호환).
   shopt -s nullglob
   reports=("$PROJECT_ROOT"/.deep-review/reports/*.md)
   shopt -u nullglob
   if [ ${#reports[@]} -gt 0 ]; then
     while IFS= read -r r; do
       WRAP_ARGS+=(--source-artifact "$r")
     done < <(printf '%s\n' "${reports[@]}" | sort -r | awk 'NR<=20')
   fi

   # Gated cleanup: helper 성공 시에만 PAYLOAD_TMP 제거. 실패 시 보존 → 재실행 가능
   # (deep-work round-1 C2 lesson — 이전 버전은 unconditional rm 으로 silent loss 발생).
   if node "$WRAP_HELPER" "${WRAP_ARGS[@]}"; then
     rm -f "$PAYLOAD_TMP"
   else
     echo "[deep-review/Stage5.5] wrap-recurring-findings-envelope.js failed — payload preserved at $PAYLOAD_TMP for retry" >&2
     exit 1
   fi
   ```


   결과 파일 모양 (envelope shape — 자세한 명세는 `claude-deep-suite/docs/envelope-migration.md` §1):

   ```json
   {
     "$schema": "https://raw.githubusercontent.com/Sungmin-Cho/claude-deep-suite/main/schemas/artifact-envelope.schema.json",
     "schema_version": "1.0",
     "envelope": {
       "producer": "deep-review",
       "producer_version": "<plugin.json.version>",
       "artifact_kind": "recurring-findings",
       "run_id": "<ULID>",
       "parent_run_id": "<consumed session-receipt run_id, optional>",
       "generated_at": "<RFC 3339>",
       "schema": { "name": "recurring-findings", "version": "1.0" },
       "git": { "head": "<sha>", "branch": "<name>", "dirty": false },
       "provenance": {
         "source_artifacts": [
           { "path": ".deep-work/.../session-receipt.json", "run_id": "<sess run_id>" },
           { "path": ".deep-review/reports/<ts>-review.md" }
         ],
         "tool_versions": { "node": "<version>" }
       }
     },
     "payload": {
       "updated_at": "<ISO 8601>",
       "taxonomy_version": "1.0",
       "findings": [/* 위와 동일 */]
     }
   }
   ```

5. 이 파일은 deep-evolve init Stage 3.5 + deep-work `gather-signals.sh` 가 envelope-aware 로 소비한다 (forward-compat unwrap — payload.findings 추출). legacy (pre-1.4.0) recurring-findings.json 도 양쪽 consumer 가 fall-through 로 그대로 처리.

6. **자체 검증 (선택)** — release lint 또는 dev workflow 에서 emit 결과를 검증하려면:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-envelope-emit.js" .deep-review/recurring-findings.json
   ```

   이 validator 는 suite repo 의 `artifact-envelope.schema.json` 을 zero-dep 로 mirror 한다 (additionalProperties:false, ULID/SemVer 2.0.0/RFC 3339 정규식, identity check). plugin self-test (`tests/envelope-emit.test.js` + `tests/envelope-chain.test.js`) 가 동일 패턴을 자동 실행.
