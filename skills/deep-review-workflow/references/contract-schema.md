# Sprint Contract Schema

## 파일 위치

`.deep-review/contracts/SLICE-{NNN}.yaml`

## 스키마

```yaml
slice: SLICE-001                    # 슬라이스 ID (plan.md 매핑)
title: "기능 제목"                    # 사람이 읽을 수 있는 제목
source_plan: "plan.md#slice-001"    # plan.md 내 원본 위치
created_at: "2026-04-08T10:00:00Z"  # 생성 시각
status: active                      # active | archived
criteria:
  - id: C1                          # 고유 ID
    description: "성공 기준 설명"     # 검증할 내용
    verification: auto              # auto | manual | mixed
    prerequisites: []               # 전제 조건 (auth, test-data, feature-flag 등)
    status: null                    # PASS | FAIL | PARTIAL | SKIP (Evaluator가 채움)
    evidence: null                  # 검증 근거 (Evaluator가 채움)
```

## verification 타입

- `auto`: Evaluator가 코드 분석 또는 App QA로 자동 검증
- `manual`: 자동 검증 불가. SKIP 처리, 리포트에 "수동 확인 필요"
- `mixed`: 일부 자동, 일부 수동. 자동 가능한 부분만 검증

## 매핑 규칙

plan.md → contract 추출:
- `### SLICE-{NNN}: 제목` → `SLICE-{NNN}.yaml`
- bullet 항목 → criteria 배열
- verification 기본값: `auto`
- "수동", "manual", "확인 필요" 키워드 → `manual`

## 변경 처리

- plan.md 수정 → 기존 contract와 diff → 사용자에게 업데이트 제안
- 새 슬라이스 → 새 contract 생성
- 삭제된 슬라이스 → status를 `archived`로 변경 (파일 삭제 안 함)
- 동일 슬라이스 재실행 → 기존 contract 업데이트 (멱등)
