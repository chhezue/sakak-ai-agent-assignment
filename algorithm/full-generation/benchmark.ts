import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { middle, validateN } from './solution.js';

// 앞선 사례의 최대 RSS가 섞이지 않도록 새 Node.js 프로세스마다 한 입력만 측정한다.
const n = Number(process.argv[2] ?? 35);
validateN(n);
const started = performance.now();
const answer = middle(n);
const seconds = (performance.now() - started) / 1000;
const peakRssKiB = process.resourceUsage().maxRSS;
console.log(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      method: 'full-generation',
      n,
      answer,
      seconds: Number(seconds.toFixed(6)),
      peakRssKiB,
      sourceSha256: createHash('sha256')
        .update(readFileSync(new URL('../../full-generation/solution.ts', import.meta.url)))
        .digest('hex'),
    },
    null,
    2,
  ),
);
