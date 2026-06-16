# ultracode Integration Guide — `--ultracode` 하이브리드 fan-out

> Related: [`codex-integration.md`](./codex-integration.md) (Codex 교차검증), [`review-criteria.md`](./review-criteria.md) (6개 리뷰 관점).
> 이 문서는 ultracode fan-out 의 **단일 출처(SSOT)** 다 — collapse 알고리즘/키/verify 정책은 여기에만 정의하고 다른 문서는 링크만 한다(중복 금지).

## 목차
- 1. 차원 샤딩
- 2. 경로 선택 (하이브리드)
- 3. 백그라운드 join 계약
- 4. 내부 합성 → 단일 "Claude(ultracode)" 보이스
- 5. 비용 / opt-in

## 1. 차원 샤딩

`--ultracode` 는 단일 Opus 서브에이전트를 **6개 병렬 리뷰어 샤드**로 교체한다 (`review-criteria.md` 의 6관점):

1. 정확성 (Correctness)
2. 아키텍처 정합성 (Architecture Compliance)
3. 엔트로피 (Entropy Detection)
4. 테스트 충분성 (Test Adequacy)
5. 가독성 (Agent Readability)
6. 보안 (Security)

각 샤드는 기존 `agents/code-reviewer.md` 에이전트를 **prompt 로 한 관점에 집중**시켜 spawn(에이전트 frontmatter 변경 불필요). 각 샤드 prompt 에는 단일 Opus 리뷰어와 **동일한 컨텍스트**(diff, rules.yaml, fitness.json, health_report, contract)를 포함한다. 차원 수는 6으로 고정(가변 샤드는 백로그).

## 2. 경로 선택 (하이브리드 — orchestrator 결정)

`Workflow` 가용성은 셸로 probe 불가 → **결정 규칙(기계적)**: 도구 목록에 `Workflow` 가 **문자 그대로 존재할 때만** 경로 (A), 그 외 전부 (B). (A) 호출이 에러/거부를 반환하면 **반드시 (B) 로 재진입**하고 Review Mode 에 폴백 라벨을 찍는다.

**(A) Workflow 경로 (Claude Code + Workflow 가용):** `Workflow` 도구 1회 호출 — Phase "Review"(6 차원 `agentType: code-reviewer`, 구조화 출력) → Phase "Verify"(finding 별 적대적 refute, pipeline). refute 된 finding 은 **무음 삭제하지 않고** `confidence = low` 로 강등·보존한다(§4 VOICE-6).

**(B) Agent fan-out 폴백 (Codex CLI/SDK 또는 Workflow 불가):**
- Claude Code: 6개 백그라운드 `Agent(code-reviewer, run_in_background:true)`.
- 비-Claude: `hooks/scripts/run-claude-reviewer.sh` 브리지를 차원별 호출(런타임 허용 범위 내; 직렬화/축소 샤딩 가능).
- **partial-failure 의미(ARCH-8) & `opus_status`(CONS-10) — 이 절이 단일 출처(SSOT)**: 성공 샤드 수 K 로 `opus_status` 를 **disjoint quorum 밴드**(우선순위 failed→partial→success)로 정한다(쿼럼 = `floor(n/2)+1`, n=6 → 4): **`failed` iff K=0; `partial` iff 1 ≤ K < 4; `success` iff K ≥ 4.** K≥1 이면 성공분만 collapse 해 단일 보이스를 만들고(K<6 면 Review Mode 에 일부 lens 누락 표기), `opus_status != success`(즉 K<4) 면 degraded 마커가 발동한다(단일 Opus 와 동등 이상 안전성). K=0 이면 Claude 를 `not_attempted` 로 두고 codex/agy 로 N-way 계속. 단, 쿼럼 상향(과반 기준 3 → 4)은 `--ultracode` 단독 경로에서 degraded 판정을 더 자주 발동시킨다(과반 유지의 비용).
- adversarial verify 는 (B) 에 미내장 — 생략 시 Review Mode 에 `UNVERIFIED fallback` 명시(경로 A/B 의 drop 정책은 §4 에서 동일하게 강제).

두 경로 모두 **에러로 죽지 않는다.**

## 3. 백그라운드 join 계약 (ARCH-1)

기존 파이프라인은 codex(2 백그라운드 Bash) + agy(1 백그라운드 Bash)를 `run_in_background` 로 띄우고 완료 알림으로 Stage 4 를 join 한다.

- ultracode 는 `reviewers_planned` 의 **단일 entry**(단일 Opus spawn 자리 대체)로 취급.
- **순서**: 먼저 codex/agy 백그라운드 잡 spawn → **그 다음** ultracode 호출. (A) 의 `Workflow` 호출은 main 세션을 blocking 하므로, codex/agy 를 먼저 띄우지 않으면 직렬화되어 wall-clock 이 ~2배가 된다.
- **join**: Stage 4 진입 전 **(ultracode 결과) AND (모든 codex/agy 완료 알림)** 을 모두 받는다. 이 계약으로 loop 의 "한 라운드 모든 백그라운드 리뷰어 완료까지 다음 라운드 금지" invariant 가 ultracode leg 에도 성립한다.

## 4. 내부 합성 → 단일 "Claude(ultracode)" 보이스

두 경로의 샤드 findings 를 **하나로 병합**:

- **identity 키**: `{file}:{line_bucket}` 만 사용. **severity·category 는 키에서 제외.**
  - severity 제외: 키에 severity 가 있으면 같은 줄의 다른-severity 중복이 dedup 안 돼 max 승격과 모순. severity 는 collision 그룹 내 승격 입력일 뿐.
  - category 제외: 6렌즈(샤드)와 7-카테고리 taxonomy 는 1:1 이 아님 — 같은 model·같은 diff 이므로 **같은 줄 ≈ 같은 이슈**. category 로 쪼개면 이중 계산. 7-taxonomy 는 downstream recurring-findings/loop signature 전용으로 분리.
  - `line_bucket = floor(line / 7)` (고정 버킷 — `±3` 슬라이딩은 비추이적이라 금지). file 없는 finding 은 정규화된 title 지문, range 는 시작줄로 버킷.
- **severity 승격**: collision 그룹을 최댓값 severity 로 1건 합성.
- **verify drop 정책(VOICE-6, 경로 독립)**: 경로 (A)/(B) 동일 정책. refute 된 샤드 finding 은 `confidence = low` 로 강등·보존(무음 삭제 금지). 단일-보이스 finding 집합은 경로에 무관하게 동일해야 한다(cross-model verify 와 이중 억제 방지).
- 결과를 **단일 Claude 리뷰 결과**로 → 기존 Stage 4 cross-model N-way 매트릭스에 **Anthropic 한 표**로 투입.

> ⚠️ **핵심 invariant**: 6 샤드는 same-family(Anthropic). 각각을 cross-model 표로 세면 합의 통계가 왜곡되므로 반드시 한 보이스로 collapse 한 뒤 codex/agy 와 합산한다.

## 5. 비용 / opt-in

- `--ultracode` 플래그 = Workflow opt-in 명시 근거(세션 effort 모드 무관).
- spawn 직전 **1회 경고**: "ultracode fan-out 은 ~5+ 리뷰어 + 적대 검증을 spawn — 토큰 다소비. `--ultracode` 지정으로 진행." (백로그 SEC-3: 대형 diff 시 Y/N 확인 + verify 패널 top-K 상한으로 격상.)
- agy ack / mutation / 민감파일 게이트는 불변.
