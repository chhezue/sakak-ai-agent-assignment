// 저장 출력을 공개 API에 재생해 전달 결과만 비교한다. 새 추론이나 사실 정확도 검사가 아니다.
const fs = require('node:fs');
const path = require('node:path');
const { startApp } = require('../dist/app.js');
const cases = [
  ...require('./golden.json'),
  ...require('./fresh.json'),
  ...require('./diagnostics.json'),
];
async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('사용법: node evaluation/replay.cjs <현재 평가 실행의 모델.jsonl>');
  const protocol = path.join(path.dirname(file), 'prompt-protocol.json');
  if (
    fs.existsSync(protocol) &&
    !JSON.parse(fs.readFileSync(protocol, 'utf8')).outputSchema?.properties?.sources
  )
    throw new Error(
      '이 실행의 출력 형식은 현재 API와 다릅니다. 당시 최종 답변은 JSONL의 response에서 확인하세요.',
    );
  const rows = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  if (
    rows.some(
      (row) =>
        !Array.isArray(row.attempts) ||
        row.attempts.some((attempt) => !Array.isArray(attempt.selectedIds)),
    )
  )
    throw new Error('이 파일은 이전 출력 형식으로 측정한 실행입니다.');
  let attempt;
  const app = await startApp({
    port: 0,
    log: () => {},
    model: {
      generate: async () => {
        if (!attempt || !attempt.raw) throw new Error('저장한 생성 결과 없음');
        return attempt.raw;
      },
    },
  });
  try {
    for (const row of rows) {
      const c = cases.find((c) => c.id === row.id);
      attempt = row.attempts[0];
      const res = await fetch((await app.getUrl()) + '/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patientId: c.patient, question: row.question }),
      });
      const body = await res.json();
      const matches =
        res.status === row.httpStatus &&
        body.status === row.response.status &&
        body.answer === row.response.answer;
      console.log(row.id, body.status, 'saved-response-match', matches);
      if (!matches) process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
