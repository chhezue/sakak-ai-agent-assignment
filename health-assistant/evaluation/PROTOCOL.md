# 실제 모델의 답변을 비교하는 방법

질문마다 기대한 검사일·항목과 모델의 출처 집합을 비교합니다. 그다음 화면에 표시한 답변을 검진표와 대조해 수치·단위·판정·보류 사유를 확인합니다. 사용자가 어느 답변을 더 적합하다고 골랐는지는 별도로 기록합니다.

## 실행

Ollama를 실행하고 [앱 설치](../README.md#설치와-실행)를 마친 뒤 `health-assistant`에서 실행합니다. 두 모델의 기본 비교에는 Qwen 외에 Llama가 필요합니다. 결과를 보관할 새 경로를 지정합니다.

```sh
ollama pull llama3.1:8b
npm run evaluate -- --repeats 1 --out evaluation/local-runs/model-comparison
npm run evaluate -- --models qwen2.5:7b --repeats 1 --split complete --out evaluation/local-runs/qwen-complete
```

기본 14문항은 [기록 선택·참고표 경계 11개](golden.json)와 [소수·간 수치·골밀도 3개](fresh.json)입니다. 전체 실행에는 [과제 예시·API 처리·간접 질문 7개](diagnostics.json)를 더합니다. 이미 확인한 개발 사례이므로 독립적인 정확도 평가에는 사용할 수 없습니다.

## 결과 해석

준비 호출은 집계에서 제외합니다. 실행기는 환경과 생성 옵션을 manifest에, 프롬프트·원응답·최종 답변을 JSONL에 기록합니다. 문장 수와 지연 시간은 관찰값입니다. 자연어 문자열의 일치 여부를 사실 점수로 사용하지 않습니다.

저장된 출력을 새 모델 호출 없이 다시 검증하려면 빌드 후 아래 명령을 실행합니다. 재생은 HTTP 상태·처리 결과·표시 문장이 저장 당시와 같은지 확인합니다. [실제 비교 결과](RESULTS.md)

```sh
node evaluation/replay.cjs evaluation/results/prompt-examples-2026-11-13/after/qwen2.5_7b.jsonl
```
