const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { startApp } = require('../dist/app.js');
const {
  OllamaModel,
  localOllamaUrl,
  generationOptions,
  systemPrompt,
  outputSchema,
  userPrompt,
} = require('../dist/assistant/model.js');
const { rawScore, firstAttemptDimensions, deliveredScore, summarize } = require('./score.cjs');
const cases = [...require('./golden.json'), ...require('./fresh.json')];
const args = process.argv.slice(2);
const option = (k, fallback) => (args.includes(k) ? args[args.indexOf(k) + 1] : fallback);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const request = async (origin, api, body) => {
  const res = await fetch(
    origin + api,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000),
        }
      : {},
  );
  if (!res.ok) throw new Error(api + ' HTTP ' + res.status);
  return res.json();
};
async function main() {
  const origin = localOllamaUrl();
  const repeats = Number(option('--repeats', 2));
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('repeats must be positive');
  const models = option('--models', 'qwen2.5:7b,llama3.1:8b').split(',');
  const split = option('--split', 'all');
  const selected = cases.filter((c) => split === 'all' || c.split === split);
  if (!selected.length) throw new Error('No matching Golden Set cases');
  const out = path.resolve(
    option(
      '--out',
      path.join(__dirname, 'local-runs', new Date().toISOString().replace(/[:.]/g, '-')),
    ),
  );
  fs.mkdirSync(out, { recursive: true });
  if (fs.existsSync(path.join(out, 'manifest.json')))
    throw new Error('Output directory already contains a run');
  const { models: installed } = await request(origin, '/api/tags');
  const metadata = models.map((tag) => {
    const model = installed.find((m) => m.name === tag);
    if (!model) throw new Error('먼저 ollama pull ' + tag);
    return {
      tag,
      digest: model.digest,
      quantization: model.details.quantization_level,
      size: model.details.parameter_size,
    };
  });
  const manifest = {
    started: new Date().toISOString(),
    node: process.version,
    ollama: (await request(origin, '/api/version')).version,
    hardware: {
      cpu: os.cpus()[0].model,
      arch: os.arch(),
      memoryGiB: Math.round(os.totalmem() / 2 ** 30),
      system: os.type(),
      release: os.release(),
    },
    options: generationOptions,
    repeats,
    split,
    models: metadata,
    goldenHash: hash(fs.readFileSync(path.join(__dirname, 'golden.json'))),
    freshHash: hash(fs.readFileSync(path.join(__dirname, 'fresh.json'))),
    fixtureHash: hash(fs.readFileSync(path.join(__dirname, '../src/health/sample.json'))),
    promptHash: hash(systemPrompt + JSON.stringify(outputSchema) + userPrompt.toString()),
    sourceHashes: Object.fromEntries(
      [
        'src/health/records.ts',
        'src/health/evidence.ts',
        'src/assistant/model.ts',
        'src/assistant/graph.ts',
        'src/app.ts',
        'evaluation/score.cjs',
        'evaluation/run.cjs',
        'package-lock.json',
      ].map((file) => [file, hash(fs.readFileSync(path.join(__dirname, '..', file)))]),
    ),
    order: 'Sequential models. One excluded warm-up per model. Same case order in every round.',
  };
  const save = (file, data) =>
    fs.writeFileSync(path.join(out, file), JSON.stringify(data, null, 2) + '\n');
  save('manifest.json', manifest);
  save('prompt-protocol.json', { systemPrompt, outputSchema, generationOptions });
  const summary = {};
  for (const tag of models) {
    console.log('Warm-up ' + tag);
    await request(origin, '/api/generate', {
      model: tag,
      prompt: 'OK',
      stream: false,
      options: { ...generationOptions, num_predict: 1 },
    });
    const attempts = new Map(),
      traces = new Map(),
      generationMetrics = [];
    const append = (map, e) => map.set(e.requestId, [...(map.get(e.requestId) || []), e]);
    const app = await startApp({
      port: 0,
      tag,
      model: new OllamaModel(tag, origin, 90000, (metrics) => generationMetrics.push(metrics)),
      capture: (e) => append(attempts, e),
      log: (e) => append(traces, e),
    });
    const rows = [],
      slug = tag.replace(/[^a-z0-9.-]/gi, '_');
    try {
      for (let round = 1; round <= repeats; round++)
        for (const c of selected) {
          const metricsStart = generationMetrics.length;
          const t = performance.now();
          const res = await fetch((await app.getUrl()) + '/api/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patientId: c.patient, question: c.question }),
          });
          const body = await res.json(),
            elapsedMs = Math.round(performance.now() - t);
          const history = attempts.get(body.requestId) || [];
          const row = {
            id: c.id,
            split: c.split,
            round,
            route: c.route,
            question: c.question,
            expected: c.expected,
            httpStatus: res.status,
            elapsedMs,
            dimensions:
              c.route === 'model'
                ? firstAttemptDimensions(history[0]?.raw || '', c.expected)
                : null,
            firstPassCorrect:
              c.route === 'model'
                ? Boolean(
                    history[0] && !history[0].issues.length && rawScore(history[0].raw, c.expected),
                  )
                : null,
            deliveredCorrect: deliveredScore(body, c, res.status),
            response: body,
            attempts: history,
            ollama: generationMetrics.slice(metricsStart),
            trace: traces.get(body.requestId) || [],
          };
          rows.push(row);
          fs.appendFileSync(path.join(out, slug + '.jsonl'), JSON.stringify(row) + '\n');
          console.log(
            tag +
              ' ' +
              round +
              '/' +
              repeats +
              ' ' +
              c.id +
              ' ' +
              body.status +
              ' ' +
              elapsedMs +
              'ms',
          );
        }
    } finally {
      await app.close();
    }
    summary[tag] = summarize(rows);
    save('summary.json', summary);
    await request(origin, '/api/generate', { model: tag, keep_alive: 0, stream: false });
  }
  manifest.finished = new Date().toISOString();
  save('manifest.json', manifest);
  console.log(JSON.stringify(summary, null, 2));
}
main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
