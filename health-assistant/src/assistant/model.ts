import { z } from 'zod';
import type { Evidence } from '../health/evidence';

export const draftSchema = z.strictObject({
  sources: z.array(z.string()),
  explanation: z.string(),
});
export const outputSchema = z.toJSONSchema(draftSchema);
export const systemPrompt = [
  '질문에서 지정한 시점의 기록을 사용하고, 시점 언급이 없으면 최근 기록으로 답하세요. sources에는 실제 사용한 검사일/검사명만 넣고 해당 기록이 없으면 빈 배열을 반환하세요.',
  '전체 요약은 BMI·공복혈당·혈압, 콜레스테롤 전반은 기록에 있는 총콜레스테롤·HDL·LDL을 설명하세요.',
  '한국어 한두 문장으로 질문한 항목의 검사일·측정값·단위와 해당 행의 검진표 판정을 그대로 전하세요. 분류 보류면 측정값과 보류 이유만 답하세요.',
  '생활 안내는 필요할 때만 짧게 덧붙이고 질환 확정이나 복약 변경은 피하세요.',
].join('\n');
// 비교에서 설정 차이를 줄인다. 같은 시드도 환경을 넘는 동일 출력을 보장하지 않는다.
export const generationOptions = { temperature: 0, seed: 42, num_ctx: 4096, num_predict: 700 };
export interface GenerationInput {
  question: string;
  evidence: Evidence[];
}
export interface Model {
  generate(input: GenerationInput): Promise<string>;
}
/** 평가 실행기에 전달할 토큰·시간 계측. 질문과 원응답은 이 수치 계약에 포함하지 않는다. */
export interface GenerationMetrics {
  totalDurationNs?: number;
  loadDurationNs?: number;
  promptEvalCount?: number;
  promptEvalDurationNs?: number;
  evalCount?: number;
  evalDurationNs?: number;
}
/** 주소 설정 실수로 근거를 외부 HTTP 서버에 보내지 않도록 루프백만 허용한다. */
export function localOllamaUrl(
  input = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
): string {
  const u = new URL(input);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ||
    u.protocol !== 'http:' ||
    u.username ||
    u.password
  )
    throw new Error('OLLAMA_BASE_URL은 로컬 HTTP 주소여야 합니다.');
  return u.origin;
}
export function itemName(row: Pick<Evidence, 'key' | 'label'>): string {
  if (row.key === 'osteoporosis') return '골밀도(T-score)';
  if (row.key === 'GFR') return '사구체여과율(GFR)';
  return row.label;
}
export function sourceId(row: Evidence): string {
  return row.date + '/' + itemName(row);
}

// 출력 형식과 필요한 내용을 함께 보여주도록 정상·보류 예시를 모두 완전한 JSON으로 준다.
const examples = [
  {
    question: '최근 건강검진 결과는 어때요?',
    answer: {
      sources: ['2025-08-15/BMI', '2025-08-15/공복혈당', '2025-08-15/혈압'],
      explanation:
        '2025-08-15 검진에서 BMI 23.5 kg/m2와 공복혈당 95 mg/dL는 정상(A), 혈압 125/82 mmHg는 정상(B)입니다. 혈압은 약간 높은 편이니 염분 섭취를 줄여 보세요.',
    },
  },
  {
    question: '콜레스테롤 수치가 어때요?',
    answer: {
      sources: ['2025-08-15/총콜레스테롤', '2025-08-15/HDL', '2025-08-15/LDL'],
      explanation:
        '2025-08-15 총콜레스테롤은 190 mg/dL, HDL은 60 mg/dL, LDL은 115 mg/dL로 모두 검진표의 정상(A)입니다. 현재 상태를 유지하시면 됩니다.',
    },
  },
  {
    question: '혈색소 수치는 정상인가요?',
    answer: {
      sources: ['2025-09-03/혈색소'],
      explanation:
        '2025-09-03 혈색소는 13.2 g/dL입니다. 기록에 성별이 없어 제공된 참고표로 정상 여부를 판단할 수 없습니다.',
    },
  },
];

export function userPrompt(input: GenerationInput): string {
  const dates = [...new Set(input.evidence.map((e) => e.date))].sort().reverse();
  const visits = dates.map((date) => {
    const rows = input.evidence
      .filter((row) => row.date === date)
      .map(
        (row) =>
          [sourceId(row), row.value, row.unit].filter(Boolean).join(' ') +
          ' / ' +
          (row.band
            ? row.band + (row.reference ? ' (참고 기준 ' + row.reference + ')' : '')
            : row.reason === 'sex-required'
              ? '분류 보류 (성별 정보 없음)'
              : '분류 보류 (적용할 참고 기준 없음)'),
      );
    return [date + (date === dates[0] ? ' (최신)' : ' (이전)'), ...rows].join('\n');
  });
  return [
    '독립된 문답 예시 (실제 답변은 아래 환자 기록 기준)',
    ...examples.map(({ question, answer }) => 'Q: ' + question + '\nA: ' + JSON.stringify(answer)),
    '환자 기록 (최신순):',
    ...visits,
    '질문: ' + input.question,
  ].join('\n\n');
}
class OllamaFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** 예외 원문에 입력이 섞일 수 있어 평가 기록에는 원문 대신 실패 분류 코드를 전달한다. */
export function modelFailureCode(error: unknown): string {
  if (error instanceof OllamaFailure) return error.code;
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    return 'timeout';
  return 'connection-or-runtime';
}
export class OllamaModel implements Model {
  constructor(
    readonly tag: string,
    readonly origin = localOllamaUrl(),
    readonly timeoutMs = 90000,
    readonly onMetrics?: (metrics: GenerationMetrics) => void,
  ) {}
  async generate(input: GenerationInput): Promise<string> {
    const res = await fetch(this.origin + '/api/generate', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.tag,
        stream: false,
        format: {
          ...outputSchema,
          properties: {
            ...outputSchema.properties,
            sources: {
              type: 'array',
              items: {
                type: 'string',
                enum: [...new Set(input.evidence.map(sourceId))],
              },
            },
          },
        },
        system: systemPrompt,
        prompt: userPrompt(input),
        options: generationOptions,
      }),
    });
    if (!res.ok) throw new OllamaFailure('http-' + res.status);
    const data = (await res.json()) as {
      response?: string;
      done?: boolean;
      total_duration?: number;
      load_duration?: number;
      prompt_eval_count?: number;
      prompt_eval_duration?: number;
      eval_count?: number;
      eval_duration?: number;
    };
    if (!data.done || typeof data.response !== 'string')
      throw new OllamaFailure('incomplete-response');
    this.onMetrics?.({
      totalDurationNs: data.total_duration,
      loadDurationNs: data.load_duration,
      promptEvalCount: data.prompt_eval_count,
      promptEvalDurationNs: data.prompt_eval_duration,
      evalCount: data.eval_count,
      evalDurationNs: data.eval_duration,
    });
    return data.response;
  }
}
