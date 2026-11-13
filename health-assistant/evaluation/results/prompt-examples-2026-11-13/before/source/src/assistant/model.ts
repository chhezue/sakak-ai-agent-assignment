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
// 모델 비교에서도 동일한 옵션을 사용한다. 고정 시드는 모든 환경에서 비트 단위 재현을 보장하지 않는다.
export const generationOptions = { temperature: 0, seed: 42, num_ctx: 4096, num_predict: 700 };
export interface GenerationInput {
  question: string;
  evidence: Evidence[];
}
export interface Model {
  generate(input: GenerationInput): Promise<string>;
}
/** Ollama가 제공한 수치 메타데이터만 평가 실행기에 전달한다. 원문이나 운영 로그는 포함하지 않는다. */
export interface GenerationMetrics {
  totalDurationNs?: number;
  loadDurationNs?: number;
  promptEvalCount?: number;
  promptEvalDurationNs?: number;
  evalCount?: number;
  evalDurationNs?: number;
}
/** 외부 모델 주소 설정 실수로 검진 근거가 장치 밖으로 전송되는 것을 실행 시 차단한다. */
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
    '말투 예시 (실제 답변은 아래 환자 기록 기준)',
    'Q: 최근 건강검진 결과는 어때요?\nA: 8월 15일 건강검진 결과입니다. BMI 23.5로 정상, 혈당 95mg/dL로 정상 범위에 있습니다. 다만 혈압이 125/82로 약간 높은 편이니 염분 섭취를 줄이시길 권합니다.',
    '"sources": ["2025-08-15/BMI", "2025-08-15/공복혈당", "2025-08-15/혈압"]',
    'Q: 콜레스테롤 수치가 어때요?\nA: 총 콜레스테롤 190mg/dL로 정상 범위(200 미만)입니다. HDL 60mg/dL도 우수한 수준이네요. 현재 상태를 유지하시면 됩니다.',
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
/** 로그에 남기는 것은 분류 코드뿐이다. 네트워크 예외나 모델의 원문은 사용자 입력을 포함할 수 있다. */
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
