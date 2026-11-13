# 사각 Software Engineer (AI Agent) 기술 과제

| 과제 | 구현 결과 |
| --- | --- |
| [개미수열](algorithm/README.md) | 독립적으로 변환할 수 있는 구간의 길이를 계산해 392,187,941,864자리인 99항의 가운데 두 문자 `11`을 구했습니다. |
| [건강검진 AI 비서](health-assistant/README.md) | 검진표의 기준은 서버가 적용하고, 질문에 맞는 기록 선택과 설명은 로컬 모델이 맡습니다. 구현 보고서에 재시도를 줄인 과정과 Qwen을 선택한 근거를 담았습니다. |

## 실행 방법

두 과제 모두 Node.js 20.19 이상을 사용합니다. 각 명령은 저장소 루트에서 시작합니다.

- **개미수열**은 `cd algorithm && npm ci && npm test`로 두 풀이를 검증합니다. 이어서 `npm run benchmark:segment-length-dp -- 99`로 99항을 계산합니다.
- **검진 비서**는 Ollama를 실행하고 `ollama pull qwen2.5:7b`로 모델을 설치합니다. `cd health-assistant && npm ci && npm start`로 서버를 시작한 뒤 [검진 상담 화면](http://127.0.0.1:3000/)을 엽니다.

[과제 안내](https://docs.google.com/document/d/1Yy7j8-3thG95YvcmjM-J84J5_Bycl-3pTTUmZORdOOA/edit?tab=t.0) · [알고리즘 풀이 소감](algorithm/README.md#반례에서-분할-조건을-찾았습니다) · [AI 활용 계획과 프롬프트](health-assistant/ai-usage.md)
