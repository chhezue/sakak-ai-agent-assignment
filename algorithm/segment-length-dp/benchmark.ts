import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Expansion, validateN } from './solution.js';

// 앞선 사례의 최대 RSS가 섞이지 않도록 새 Node.js 프로세스마다 한 입력만 측정한다.
const n = Number(process.argv[2] ?? 99);
validateN(n);
const engine = new Expansion();
const started = performance.now();
const answer = engine.middle('1', n - 1);
const seconds = (performance.now() - started) / 1000;
const peakRssKiB = process.resourceUsage().maxRSS;
console.log(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      method: 'segment-length-dp',
      n,
      answer,
      seconds: Number(seconds.toFixed(6)),
      peakRssKiB,
      sourceSha256: createHash('sha256')
        .update(readFileSync(new URL('../../segment-length-dp/solution.ts', import.meta.url)))
        .digest('hex'),
      termLength: engine.length('1', n - 1).toString(),
      ...engine.statistics(),
    },
    null,
    2,
  ),
);
