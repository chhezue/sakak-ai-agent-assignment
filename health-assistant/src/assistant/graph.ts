import { performance } from 'node:perf_hooks';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { patientEvidence, type Evidence } from '../health/evidence';
import type { HealthDocument } from '../health/records';
import { draftSchema, sourceId, modelFailureCode, userPrompt, type Model } from './model';

export type Status =
  | 'generated'
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
/** 합성 평가에서만 수집하는 원응답. 운영 Trace에 질문·모델 원문을 섞지 않는다. */
export interface Attempt {
  requestId: string;
  attempt: number;
  raw: string;
  selectedIds: string[];
  prompt: string;
  issues: string[];
  durationMs: number;
}
export type Lookup = (id: string) => Promise<HealthDocument | undefined>;

const State = Annotation.Root({
  requestId: Annotation<string>(),
  patientId: Annotation<string>(),
  question: Annotation<string>(),
  started: Annotation<number>(),
  candidates: Annotation<Evidence[]>(),
  evidence: Annotation<Evidence[]>(),
  status: Annotation<Status>(),
  attempt: Annotation<number>(),
  answer: Annotation<string>(),
});
type S = typeof State.State;
type Reply = Pick<Answer, 'status' | 'answer'> & { evidence: Evidence[] };

function unresolved(): Reply {
  return { status: 'unsupported', answer: '해당 검진을 특정할 수 없습니다.', evidence: [] };
}

/** JSON과 현재 환자의 출처만 확인한다. 설명의 사실 일치나 질문 적합성은 판정하지 않는다. */
export function resolveDraft(raw: string, candidates: Evidence[]): Reply {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return unresolved();
  }
  const draft = draftSchema.safeParse(json);
  if (!draft.success || !draft.data.sources.length || !draft.data.explanation.trim())
    return unresolved();
  const byId = new Map(candidates.map((row) => [sourceId(row), row]));
  const evidence: Evidence[] = [];
  for (const id of new Set(draft.data.sources)) {
    const row = byId.get(id);
    if (!row) return unresolved();
    evidence.push(row);
  }
  return { status: 'generated', answer: draft.data.explanation, evidence };
}

export function buildAssistant(
  lookup: Lookup,
  model: Model,
  log: (event: Trace) => void,
  capture?: (attempt: Attempt) => void,
) {
  const trace = (s: S, stage: string, outcome: string, since: number) =>
    log({
      requestId: s.requestId,
      stage,
      outcome,
      durationMs: Math.round(performance.now() - since),
    });
  return new StateGraph(State)
    .addNode('lookup', async (s) => {
      const start = performance.now();
      let record;
      try {
        record = await lookup(s.patientId);
      } catch {
        trace(s, 'lookup', 'lookup-unavailable', start);
        return { status: 'lookup-unavailable' as const, answer: '검진 API에 연결할 수 없습니다.' };
      }
      const candidates = record ? patientEvidence(record) : [];
      trace(s, 'lookup', record ? 'ok' : 'not-found', start);
      if (!record) return { status: 'not-found' as const, answer: '해당 환자를 찾을 수 없습니다.' };
      if (!candidates.length)
        return { status: 'no-record' as const, answer: '검진 기록이 없습니다.' };
      return { candidates };
    })
    .addNode('generate', async (s) => {
      const start = performance.now();
      const input = { question: s.question, evidence: s.candidates };
      let raw = '',
        issues: string[] = [],
        reply: Reply;
      try {
        raw = await model.generate(input);
        reply = resolveDraft(raw, s.candidates);
      } catch (error) {
        issues = [modelFailureCode(error)];
        reply = {
          status: 'model-unavailable',
          answer: '모델에 연결하지 못해 해당 검진을 특정할 수 없습니다.',
          evidence: [],
        };
      }
      trace(s, 'generate', reply.status, start);
      capture?.({
        requestId: s.requestId,
        attempt: 1,
        selectedIds: reply.evidence.map((row) => row.id),
        prompt: userPrompt(input),
        raw,
        issues,
        durationMs: Math.round(performance.now() - start),
      });
      return { ...reply, attempt: 1 };
    })
    .addNode('complete', (s) => {
      trace(s, 'complete', s.status, s.started);
      return {};
    })
    .addEdge(START, 'lookup')
    .addConditionalEdges('lookup', (s) => (s.candidates?.length ? 'generate' : 'complete'), [
      'generate',
      'complete',
    ])
    .addEdge('generate', 'complete')
    .addEdge('complete', END)
    .compile();
}
