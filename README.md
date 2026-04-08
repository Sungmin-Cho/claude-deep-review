# deep-review

AI 코딩 에이전트의 작업을 독립적으로 평가하는 Evaluator 플러그인.

## Features

- **독립 Evaluator**: Generator와 분리된 Opus 서브에이전트가 코드 리뷰
- **교차 모델 검증**: Codex 플러그인 설치 시 3-way 병렬 리뷰 (Claude + Codex Review + Codex Adversarial)
- **Sprint Contract**: 성공 기준 대비 구조적 검증
- **엔트로피 탐지**: 코드 드리프트, 패턴 불일치, 중복 감지
- **환경 적응**: git/non-git, Codex 유무에 관계없이 동작

## Installation

```bash
claude plugin add deep-review
```

## Commands

| Command | Description |
|---------|-------------|
| `/deep-review` | 현재 변경사항을 독립 에이전트로 리뷰 |
| `/deep-review --contract` | Sprint Contract 기반 리뷰 |
| `/deep-review --entropy` | 엔트로피 스캔 |
| `/deep-review init` | 프로젝트별 리뷰 규칙 초기화 |
