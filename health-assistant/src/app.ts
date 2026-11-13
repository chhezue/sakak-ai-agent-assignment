import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Module,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { z } from 'zod';
import { readHealthDocument, type HealthDocument } from './health/records';
import { buildAssistant, type Answer, type Attempt, type Trace } from './assistant/graph';
import { OllamaModel, type Model } from './assistant/model';

const askInput = z
  .object({
    patientId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    question: z.string().trim().min(1).max(350),
  })
  .strict();
const GRAPH = Symbol('compiled-assistant');
const MODEL_TAG = Symbol('model-tag');
type Graph = ReturnType<typeof buildAssistant>;
@Controller('api')
class HealthController {
  constructor(
    @Inject(GRAPH) private readonly graph: Graph,
    @Inject(MODEL_TAG) private readonly modelTag: string,
  ) {}
  @Get('health/:patientId')
  health(@Param('patientId') id: string) {
    const result = readHealthDocument(id);
    if (!result) throw new NotFoundException('해당 환자를 찾을 수 없습니다.');
    return result;
  }
  @Post('ask')
  @HttpCode(200)
  async ask(@Body() input: unknown): Promise<Answer> {
    const parsed = askInput.safeParse(input);
    if (!parsed.success) throw new BadRequestException('환자 ID와 1~350자의 질문을 입력하세요.');
    const requestId = randomUUID();
    const result = await this.graph.invoke({
      ...parsed.data,
      requestId,
      started: performance.now(),
      attempt: 0,
      evidence: [],
    });
    const response: Answer = {
      requestId,
      ...(result.attempt && this.modelTag ? { model: this.modelTag } : {}),
      status: result.status,
      answer: result.answer,
    };
    if (result.status === 'not-found') throw new HttpException(response, 404);
    if (result.status === 'lookup-unavailable') throw new HttpException(response, 503);
    return response;
  }
}
@Module({})
class AppModule {}
interface AppOptions {
  port?: number;
  model?: Model;
  log?: (event: Trace) => void;
  capture?: (attempt: Attempt) => void;
  tag?: string;
}
/** 앱과 평가가 같은 HTTP 경로를 사용한다. port 0은 테스트 서버끼리 포트가 겹치지 않게 한다. */
export async function startApp(options: AppOptions = {}) {
  // 셸의 추적 설정으로 입력이 원격 전송되지 않도록 이 프로세스는 자체 Trace만 사용한다.
  for (const flag of [
    'LANGSMITH_TRACING',
    'LANGSMITH_TRACING_V2',
    'LANGCHAIN_TRACING',
    'LANGCHAIN_TRACING_V2',
    'LANGCHAIN_VERBOSE',
  ]) {
    delete process.env[flag];
  }
  let origin = '';
  // 공개 API의 직렬화·오류 응답까지 통합 검증하려고 같은 프로세스에서도 HTTP로 조회한다.
  const lookup = async (id: string) => {
    const res = await fetch(origin + '/api/health/' + encodeURIComponent(id), {
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error('검진 조회 실패');
    return (await res.json()) as HealthDocument;
  };
  const model =
    options.model || new OllamaModel(options.tag || process.env.OLLAMA_MODEL || 'qwen2.5:7b');
  const log = options.log || ((event: Trace) => console.log(JSON.stringify(event)));
  const app = await NestFactory.create<NestExpressApplication>(
    {
      module: AppModule,
      controllers: [HealthController],
      providers: [
        { provide: GRAPH, useValue: buildAssistant(lookup, model, log, options.capture) },
        { provide: MODEL_TAG, useValue: model instanceof OllamaModel ? model.tag : '' },
      ],
    },
    { logger: false },
  );
  app.useStaticAssets(resolve(__dirname, '../public'));
  await app.listen(options.port ?? 3000, '127.0.0.1');
  origin = await app.getUrl();
  return app;
}
