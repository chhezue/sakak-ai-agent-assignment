import { performance } from 'node:perf_hooks';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { factSentence, selectEvidence, type Evidence } from '../health/evidence';
import type { HealthDocument } from '../health/records';
import { modelFailureCode, userPrompt, validateDraft, type Model } from './model';

export type Status =
  | 'generated'
  | 'reference-only'
  | 'verified-fallback'
  | 'model-unavailable'
  | 'no-record'
  | 'unsupported'
  | 'not-found'
  | 'lookup-unavailable';
export interface Answer {
  requestId: string;
  model?: string;
  status: Status;
  answer: string;
  evidence: Evidence[];
}
export interface Trace {
  requestId: string;
  stage: string;
  outcome: string;
  durationMs: number;
  count?: number;
  attempt?: number;
  issues?: string[];
}
/** 합성 데이터 평가에만 쓰는 원응답. 일반 요청의 Trace와 다른 저장 경로로 전달한다. */
export interface Attempt {
  requestId: string;
  attempt: number;
  raw: string;
  prompt: string;
  issues: string[];
  durationMs: number;
}
export type Lookup = (id: string) => Promise<HealthDocument | undefined>;
type LookupOutcome = 'ok' | 'not-found' | 'lookup-unavailable';
const State = Annotation.Root({
  requestId: Annotation<string>(),
  patientId: Annotation<string>(),
  question: Annotation<string>(),
  started: Annotation<number>(),
  record: Annotation<HealthDocument | null>(),
  lookupOutcome: Annotation<LookupOutcome>(),
  evidence: Annotation<Evidence[]>(),
  status: Annotation<Status>(),
  attempt: Annotation<number>(),
  raw: Annotation<string>(),
  issues: Annotation<string[]>(),
  modelMs: Annotation<number>(),
  answer: Annotation<string>(),
});
type S = typeof State.State;
const responseText: Partial<Record<Status, string>> = {
  'no-record': '요청한 날짜 또는 항목에 해당하는 검진 기록이 없습니다.',
  unsupported:
    '검진 기록으로 확인할 수 있는 항목을 물어보세요. 예를 들어 최근 혈압이나 공복혈당을 확인할 수 있습니다.',
  'not-found': '해당 환자를 찾을 수 없습니다.',
  'lookup-unavailable': '검진 API에 연결할 수 없습니다.',
};
function render(evidence: Evidence[], sentences: Record<string, string> = {}): string {
  const dates = [...new Set(evidence.map((e) => e.date))];
  return dates
    .map(
      (date) =>
        date +
        ' 검진\n' +
        evidence
          .filter((e) => e.date === date)
          .map((e) => sentences[e.id] || factSentence(e))
          .join('\n'),
    )
    .join('\n\n');
}
/**
 * 앱별로 그래프를 한 번 컴파일하고 요청별 상태는 invoke 안에 둔다.
 * capture는 오프라인 평가에서만 주입한다. 일반 서버는 검증 사유 코드와 시각 정보만 기록한다.
 */
export function buildAssistant(
  lookup: Lookup,
  model: Model,
  log: (event: Trace) => void,
  capture?: (attempt: Attempt) => void,
) {
  const trace = (s: S, stage: string, outcome: string, since: number, extra: Partial<Trace> = {}) =>
    log({
      requestId: s.requestId,
      stage,
      outcome,
      durationMs: Math.max(0, Math.round(performance.now() - since)),
      ...extra,
    });
  return new StateGraph(State)
    .addNode('lookup', async (s) => {
      const t = performance.now();
      let record: HealthDocument | undefined,
        lookupOutcome: LookupOutcome = 'ok';
      try {
        record = await lookup(s.patientId);
        if (!record) lookupOutcome = 'not-found';
      } catch {
        lookupOutcome = 'lookup-unavailable';
      }
      trace(s, 'lookup', lookupOutcome, t);
      return {
        lookupOutcome,
        record: record || null,
        ...(lookupOutcome === 'ok' ? {} : { status: lookupOutcome }),
      };
    })
    .addNode('select', (s) => {
      const t = performance.now();
      const result = selectEvidence(s.question, s.record!);
      const status: Status =
        result.kind === 'ready'
          ? result.evidence.some((e) => e.band)
            ? 'generated'
            : 'reference-only'
          : result.kind;
      trace(s, 'select', status === 'generated' ? 'model-route' : status, t, {
        count: result.evidence.length,
      });
      return { evidence: result.evidence, status };
    })
    .addNode('generate', async (s) => {
      const t = performance.now(),
        attempt = (s.attempt || 0) + 1;
      try {
        const raw = await model.generate({
          question: s.question,
          evidence: s.evidence,
          previousIssues: s.issues || [],
        });
        trace(s, 'generate', 'received', t, { attempt });
        return { raw, attempt, modelMs: Math.round(performance.now() - t) };
      } catch (error) {
        const issues = [modelFailureCode(error)];
        trace(s, 'generate', 'unavailable', t, { attempt, issues });
        capture?.({
          requestId: s.requestId,
          attempt,
          raw: '',
          prompt: userPrompt({
            question: s.question,
            evidence: s.evidence,
            previousIssues: s.issues || [],
          }),
          issues,
          durationMs: Math.round(performance.now() - t),
        });
        return { status: 'model-unavailable' as Status, attempt };
      }
    })
    .addNode('validate', (s) => {
      const t = performance.now(),
        { issues, sentences } = validateDraft(s.raw, s.evidence);
      trace(s, 'validate', issues.length ? 'rejected' : 'accepted', t, {
        attempt: s.attempt,
        issues,
      });
      capture?.({
        requestId: s.requestId,
        attempt: s.attempt,
        raw: s.raw,
        prompt: userPrompt({
          question: s.question,
          evidence: s.evidence,
          previousIssues: s.issues || [],
        }),
        issues,
        durationMs: s.modelMs,
      });
      if (!issues.length) return { issues, answer: render(s.evidence, sentences) };
      // 출력 오류는 한 번만 교정한다. 두 번째 실패는 근거 카드로 종료해 요청당 생성 횟수를 제한한다.
      return { issues, ...(s.attempt >= 2 ? { status: 'verified-fallback' as Status } : {}) };
    })
    .addNode('complete', (s) => {
      trace(s, 'complete', s.status, s.started, { count: s.evidence?.length || 0 });
      return { answer: s.answer || responseText[s.status] || render(s.evidence || []) };
    })
    .addEdge(START, 'lookup')
    .addConditionalEdges('lookup', (s) => (s.lookupOutcome === 'ok' ? 'select' : 'complete'), [
      'select',
      'complete',
    ])
    .addConditionalEdges('select', (s) => (s.status === 'generated' ? 'generate' : 'complete'), [
      'generate',
      'complete',
    ])
    .addConditionalEdges(
      'generate',
      (s) => (s.status === 'model-unavailable' ? 'complete' : 'validate'),
      ['complete', 'validate'],
    )
    .addConditionalEdges(
      'validate',
      (s) => (s.issues.length && s.attempt < 2 ? 'generate' : 'complete'),
      ['generate', 'complete'],
    )
    .addEdge('complete', END)
    .compile();
}
