// Research only: how would different ways of picking an agent have done on the NEXT three months?
// For each cut date T (monthly, from 12 months of history on), each rule picks using only data before T;
// the score is the pick's return over the following 90 days minus just holding the coin over the same days.
// Costs are already inside each agent's equity curve (pool fee, gap, impact at a $100 budget).
import { loadAgents, DEMOTED, isRetired, type Agent } from '../src/agents.ts';
import { writeFileSync } from 'node:fs';

// Run from hsk-agent: node --experimental-strip-types research/rank-sim.ts   (reads live candles; writes research/rank-sim.md)
const OUT = new URL('.', import.meta.url).pathname;
const all = (await loadAgents()).filter((a) => a.runnable && a.kind === 'position' && !a.interval && !isRetired(a));
const pc = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`;
const DAY = 86400;

interface Series { a: Agent; t: number[]; eq: number[]; hold: number[] }
const series = (a: Agent): Series => ({ a, t: a.equity.map((p) => p.time), eq: a.equity.map((p) => p.value), hold: a.bench.map((p) => p.value) });
const at = (s: Series, time: number) => { let i = s.t.length - 1; while (i > 0 && s.t[i] > time) i--; return i; };
const ret = (xs: number[], i: number, j: number) => xs[j] / xs[i] - 1;
/** Stats of one agent between two times: its return, holding's return, the worst drop, the share of days it moved. */
function stat(s: Series, from: number, to: number) {
  const i = at(s, from), j = at(s, to);
  let peak = s.eq[i], dd = 0, moved = 0;
  for (let k = i + 1; k <= j; k++) { peak = Math.max(peak, s.eq[k]); dd = Math.max(dd, 1 - s.eq[k] / peak); if (s.eq[k] !== s.eq[k - 1]) moved++; }
  return { total: ret(s.eq, i, j), hold: ret(s.hold, i, j), dd, exposure: moved / Math.max(1, j - i), days: j - i };
}

type Rule = { name: string; pick: (xs: Series[], T: number, start: number) => Series[] };
const edge = (s: Series, a: number, b: number) => { const x = stat(s, a, b); return x.total - x.hold; };
const best = (xs: Series[], f: (s: Series) => number) => (xs.length ? [[...xs].sort((p, q) => f(q) - f(p))[0]] : []);
const rules: Rule[] = [
  { name: 'now: beat hold over last year (≥25% in coin), then smallest drop', pick: (xs, T, s0) => { const ok = xs.filter((s) => { const y = stat(s, T - 365 * DAY, T); return y.total > y.hold && y.exposure >= 0.25; }); return best(ok.length ? ok : xs, (s) => -stat(s, s0, T).dd); } },
  { name: 'A: best vs hold over all history so far', pick: (xs, T, s0) => best(xs, (s) => edge(s, s0, T)) },
  { name: 'B: best vs hold over last year', pick: (xs, T) => best(xs, (s) => edge(s, T - 365 * DAY, T)) },
  { name: 'C: beat hold over all history AND last year, then best all-history', pick: (xs, T, s0) => { const ok = xs.filter((s) => edge(s, s0, T) > 0 && edge(s, T - 365 * DAY, T) > 0); return best(ok.length ? ok : xs, (s) => edge(s, s0, T)); } },
  { name: 'D: beat hold over all history, then smallest drop', pick: (xs, T, s0) => { const ok = xs.filter((s) => edge(s, s0, T) > 0 && stat(s, s0, T).exposure > 0.05); return best(ok.length ? ok : xs, (s) => -stat(s, s0, T).dd); } },
  { name: 'E: best absolute return over all history', pick: (xs, T, s0) => best(xs, (s) => stat(s, s0, T).total) },
  { name: 'F: best return ÷ worst drop over all history', pick: (xs, T, s0) => best(xs, (s) => { const x = stat(s, s0, T); return x.total / Math.max(0.05, x.dd); }) },
  { name: 'G: basket of every agent, equal parts', pick: (xs) => xs },
  { name: 'H: basket of agents that beat hold over all history', pick: (xs, T, s0) => { const ok = xs.filter((s) => edge(s, s0, T) > 0 && stat(s, s0, T).exposure > 0.05); return ok.length ? ok : xs; } },
  { name: 'I: basket of the 3 best vs hold over all history', pick: (xs, T, s0) => [...xs].sort((p, q) => edge(q, s0, T) - edge(p, s0, T)).slice(0, 3) },
  { name: 'fixed: 12-month momentum (tsmom)', pick: (xs) => xs.filter((s) => s.a.rule === 'tsmom') },
  { name: 'fixed: dual momentum', pick: (xs) => xs.filter((s) => s.a.rule === 'dualMom') },
  { name: 'fixed: 1/3/12-month trend blend (multiTrend)', pick: (xs) => xs.filter((s) => s.a.rule === 'multiTrend') },
  { name: 'fixed: volatility-targeted holding', pick: (xs) => xs.filter((s) => s.a.rule === 'volTarget') },
];

let md = '# Ranking-rule experiment (walk-forward, research only)\n\nEach rule picks with data before a cut date; the score is the next 90 days. Monthly cut dates. "vs hold" = pick return minus holding the coin. Costs are in the curves.\n';
const table: Record<string, Record<string, { edge: number; abs: number; win: number; n: number; worst: number }>> = {};
for (const coin of ['BTC', 'ETH', 'HSK']) {
  const xs = all.filter((a) => a.base === coin).map(series);
  if (!xs.length) continue;
  const s0 = Math.max(...xs.map((s) => s.t[0])), end = Math.min(...xs.map((s) => s.t[s.t.length - 1]));
  const cuts: number[] = [];
  for (let T = s0 + 365 * DAY; T + 90 * DAY <= end; T += 30 * DAY) cuts.push(T);
  md += `\n## ${coin}\n\n${xs.length} daily agents, history ${new Date(s0 * 1000).toISOString().slice(0, 10)} → ${new Date(end * 1000).toISOString().slice(0, 10)}, ${cuts.length} cut dates.\n\n| Rule | next-90d vs hold (avg, pts) | next-90d return (avg) | beat hold in | worst 90d vs hold | picks (most frequent) |\n|---|---|---|---|---|---|\n`;
  for (const r of rules) {
    const edges: number[] = [], abss: number[] = [], names: Record<string, number> = {};
    for (const T of cuts) {
      const picks = r.pick(xs, T, s0);
      if (!picks.length) continue;
      const rs = picks.map((s) => stat(s, T, T + 90 * DAY));
      const tot = rs.reduce((a, x) => a + x.total, 0) / rs.length, hold = rs[0].hold;
      edges.push(tot - hold); abss.push(tot);
      if (picks.length === 1) names[picks[0].a.rule] = (names[picks[0].a.rule] ?? 0) + 1;
    }
    if (!edges.length) continue;
    const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    const top = Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}×${v}`).join(', ');
    (table[r.name] ??= {})[coin] = { edge: avg(edges), abs: avg(abss), win: edges.filter((e) => e > 0).length, n: edges.length, worst: Math.min(...edges) };
    md += `| ${r.name} | ${pc(avg(edges))} | ${pc(avg(abss))}% | ${edges.filter((e) => e > 0).length}/${edges.length} | ${pc(Math.min(...edges))} | ${top || `basket of ${r.pick(xs, cuts[cuts.length - 1], s0).length}`} |\n`;
  }
  // The full table of agents, for reference.
  md += `\n### ${coin}: every agent (full window, costs included)\n\n| Agent | group | total | vs hold | worst drop | entries | in coin | ranking year vs hold | last 3 months vs hold | working now |\n|---|---|---|---|---|---|---|---|---|---|\n`;
  const now = Date.now() / 1000;
  for (const s of [...xs].sort((p, q) => (q.a.total - q.a.hold) - (p.a.total - p.a.hold))) {
    const a = s.a, last = a.marks.length ? Math.max(...a.marks.map((m) => m.time)) : 0;
    md += `| ${a.rule} | ${DEMOTED.has(a.rule) ? 'classic (folded)' : 'main'} | ${pc(a.total)}% | ${pc(a.total - a.hold)} | −${(a.maxDd * 100).toFixed(1)}% | ${a.trades} | ${(a.inMarket * 100).toFixed(0)}% | ${a.split ? pc(a.split.pick.total - a.split.pick.hold) : '–'} | ${a.split ? pc(a.split.holdout.total - a.split.holdout.hold) : '–'} | ${a.live ? 'holding' : last ? `${Math.round((now - last) / DAY)}d ago` : 'never'} |\n`;
  }
}
md += '\n## Across the three coins (average of the per-coin averages)\n\n| Rule | next-90d vs hold | beat hold in |\n|---|---|---|\n';
for (const [name, byCoin] of Object.entries(table)) {
  const cs = Object.values(byCoin);
  md += `| ${name} | ${pc(cs.reduce((a, c) => a + c.edge, 0) / cs.length)} | ${cs.reduce((a, c) => a + c.win, 0)}/${cs.reduce((a, c) => a + c.n, 0)} |\n`;
}
writeFileSync(OUT + 'rank-sim.md', md);
console.log(md.split('### ')[0]);
console.log(md.slice(md.indexOf('## Across')));
