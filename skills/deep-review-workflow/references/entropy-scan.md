# entropy-scan — `--entropy` 스캔 (review-execution 에서 on-demand Read)

<!-- review-execution.md 가 --entropy 일 때 Read 되어 그대로 수행된다. 동작 SSOT. -->

## Stage 6 — 엔트로피 스캔 (--entropy)

`--entropy` 플래그가 있으면 추가 스캔:
- 프로젝트 전체에서 중복 코드 블록 탐지
- 기존 유틸리티와 중복되는 새 헬퍼 함수 탐지
- 네이밍 컨벤션 불일치 탐지
- 결과를 `.deep-review/entropy-log.jsonl`에 append
