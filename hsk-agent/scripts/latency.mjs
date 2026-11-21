// Measure Moa's response time at a given effort: node --experimental-strip-types scripts/latency.mjs <effort>
// Uses the real Claude API (costs a few cents). Execution is off: no vault is configured here.
import { readFileSync } from 'node:fs';
const effort = process.argv[2] ?? 'high';
process.env.MOA_EFFORT = effort;
const key = readFileSync(new URL('../.env.local', import.meta.url), 'utf8').match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1];
const { runMoa } = await import('../server/moaAgent.ts');
const cfg = { rpcUrl: 'https://mainnet.hsk.xyz', chainId: 177, explorer: 'https://hsk.blockscout.com', minOutBufferBps: 100 };
const prompts = [
  'HSK를 2주 동안 매일 10달러씩 모아줘. 15% 빠지면 절반 팔고.',
  'Accumulate 5,000 HSK by Dec 31 under 0.08, budget $400',
];
for (const p of prompts) {
  const steps = [];
  const t0 = Date.now();
  const r = await runMoa(key, cfg, [{ role: 'user', content: p }], (e) => steps.push(`${e.step}@${((Date.now() - t0) / 1000).toFixed(1)}s`));
  console.log(JSON.stringify({ effort, prompt: p.slice(0, 40), seconds: +((Date.now() - t0) / 1000).toFixed(1), steps, planSteps: r.plan?.steps.length ?? 0, missing: r.plan?.missing ?? [], replyChars: r.reply.length }));
}
