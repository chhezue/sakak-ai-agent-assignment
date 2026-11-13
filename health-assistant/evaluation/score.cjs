const { sourceId, draftSchema } = require('../dist/assistant/model');
const { isDeepStrictEqual } = require('node:util');

// 구조화된 행 ID의 집합만 비교한다. 설명의 사실 일치 여부를 뜻하지 않는다.
function selectionCorrect(ids, expected) {
  return (
    Array.isArray(ids) &&
    isDeepStrictEqual([...ids].sort(), expected.map(([date, key]) => date + '/' + key).sort())
  );
}

const sentences = new Intl.Segmenter('ko', { granularity: 'sentence' });
function observeText(text) {
  const prose = typeof text === 'string' ? text.trim() : '';
  // 분량은 관찰값이다. 문장 수나 특정 표현으로 통과·실패를 판정하지 않는다.
  return {
    sentenceCount: Array.from(sentences.segment(prose)).length,
    characterCount: [...prose].length,
  };
}

function rawSelection(draft, candidates, expected) {
  if (!draftSchema.safeParse(draft).success) return false;
  const bySource = new Map(candidates.map((row) => [sourceId(row), row.id]));
  const ids = [...new Set(draft.sources)].map((source) => bySource.get(source));
  return ids.every((id) => id !== undefined) && selectionCorrect(ids, expected);
}

function scoreStages(history, body, c, candidates) {
  const attempt = history[0];
  let draft;
  try {
    draft = JSON.parse(attempt?.raw);
  } catch {
    /* 호출 실패 또는 잘못된 JSON */
  }
  const draftSelection = attempt ? rawSelection(draft, candidates, c.expected) : null;
  const noMatch = body.status === 'unsupported' && draftSelection && !c.expected.length;
  let disposition;
  if (!attempt) disposition = 'not-called';
  else if (!attempt.raw) disposition = 'no-output';
  else if (body.status === 'generated') disposition = 'accepted';
  else disposition = noMatch ? 'no-match' : 'rejected';
  return {
    disposition,
    draft: attempt?.raw ? { selection: draftSelection, ...observeText(draft?.explanation) } : null,
    final: {
      selection: attempt
        ? selectionCorrect(attempt.selectedIds, c.expected) && (c.expected.length > 0 || noMatch)
        : null,
      ...observeText(body.answer),
    },
  };
}

function summarize(rows) {
  const called = rows.filter((r) => r.attempts.length);
  const times = called.map((r) => r.elapsedMs).sort((a, b) => a - b);
  const percentile = (p) => times[Math.ceil(p * times.length) - 1] ?? null;
  const count = (disposition) =>
    rows.filter((row) => row.scores.disposition === disposition).length;
  const totals = (stage) => {
    const measured = rows
      .map((row) => row.scores[stage]?.selection)
      .filter((v) => typeof v === 'boolean');
    return { selection: { passed: measured.filter(Boolean).length, evaluated: measured.length } };
  };
  return {
    dispositions: Object.fromEntries(
      ['accepted', 'rejected', 'no-match', 'not-called', 'no-output'].map((d) => [d, count(d)]),
    ),
    draftRates: Object.fromEntries(
      ['accepted', 'rejected'].map((d) => [
        d,
        {
          allRequests: rows.length ? count(d) / rows.length : null,
          modelCalls: called.length ? count(d) / called.length : null,
          decidedDrafts:
            count('accepted') + count('rejected')
              ? count(d) / (count('accepted') + count('rejected'))
              : null,
        },
      ]),
    ),
    draft: totals('draft'),
    final: totals('final'),
    requests: rows.length,
    modelRequests: called.length,
    correctSelections: called.filter((r) => r.selectionCorrect).length,
    generated: called.filter((r) => r.response.status === 'generated').length,
    unavailable: called.filter((r) => r.response.status === 'model-unavailable').length,
    modelRouteLatencyMs: { p50: percentile(0.5), p95: percentile(0.95) },
  };
}
module.exports = { selectionCorrect, scoreStages, summarize };
