// Moa: one conversation, docked on the right of every screen. Moa explains, recommends and reports;
// it never trades on its own and never changes amounts. Its jobs:
//  - open the conversation (level question, coin weather) and keep it moving with next-step choices
//  - recommend an agent by a fixed rule (recommend.ts) and hand it to the hire sheet
//  - show a hired agent's status, ask before each of its trades, and report what happened
// Requests that are clearly about agents (pick one, stop, how is it doing) are answered here without the AI;
// everything else goes to the server brain, which may also call the recommend tool.
// Numbers come from live data or from the hired agent record; Moa keeps no copy of either.
import { useEffect, useRef, useState } from 'react';
import type { Quote } from './market.ts';
import { useT } from './i18n.ts';
import { SlidePill } from './motion.tsx';
import type { VaultInfo } from './parts.tsx';
import { CopyAddress, CopyButton, Modal, RichText } from './ui.tsx';
import { askMoa, EXECUTE_WORDS, toStep, type Exec, type StepKey } from './moaClient.ts';
import { describe, parseIntent, type Plan } from './intent.ts';
import { reply as offlineReply } from './moa.ts';
import type { Execution } from './store.ts';
import { CoinMark } from './CoinMark.tsx';
import { loadWeather, skyOf, type Weather } from './weather.ts';
import type { Agent } from './agents.ts';
import { othersFor, rankedFor, recommend, type Level } from './recommend.ts';
import { AgentCard, agentName, drop, explainAgent } from './AgentCard.tsx';
import type { HireTarget } from './HireSheet.tsx';
import { book, lastEvent, statusOf, type Amounts, type HiredAgent } from './runner.ts';
import { eventLine, hiredName, money, moneyLine, qtyText, skipText, statusText, whyText } from './hiredText.ts';

export interface MoaContext { venue?: 'cex' | 'dex'; label: string; asset?: string; perp?: boolean }
/** A job another part of the screen hands to Moa. */
export type MoaAsk =
  | { kind: 'agent'; agent: Agent }
  | { kind: 'recommend'; coin?: string }
  | { kind: 'status'; hiredId: string }
  | { kind: 'hired'; hiredId: string; changed?: { from: Amounts; to: Amounts } };
export type MoaInject = MoaAsk & { n: number };
export type { Level };
interface Choice { label: string; act: () => void }
interface Note {
  id: number; at: number; role: 'moa' | 'you'; text: string; plan?: Plan; goal?: string; execs?: Exec[]; offline?: boolean;
  follow: string[]; choices?: Choice[]; chosen?: string; sky?: { level: Level; list: Weather[] };
  agent?: { a: Agent; rec?: { pool: number } }; list?: { agents: Agent[]; coin?: string }; status?: string; order?: { hiredId: string; orderId: string };
}
type Line = Omit<Note, 'id' | 'at' | 'role'>;
type Topic = 'why' | 'how' | 'when' | 'split' | 'alert' | 'other' | 'strats' | 'chart' | 'rule' | 'doit' | 'self';
const PRO_WORDS = /(rsi|macd|ema|롱|숏|레버리지|펀딩|볼린저|지표|long|short|leverage|funding|bollinger)/i;
const RECOMMEND_WORDS = /(추천|맡길|맡겨|골라|recommend|suggest|which agent|pick (?:one|an agent))/i;
const STOP_WORDS = /(멈춰|멈추|중지|정지|그만해|pause|stop (?:the |my |all )?(?:agents?|bots?))/i;
const STATUS_WORDS = /(얼마 벌|수익|손익|현황|잘 하고|어떻게 하고|how (?:are|is) my|status|p&l|pnl|profit)/i;
const readLevel = (): Level | null => { try { const v = localStorage.getItem('moa.level'); return v === 'new' || v === 'some' || v === 'pro' ? v : null; } catch { return null; } };
const saveLevel = (l: Level) => { try { localStorage.setItem('moa.level', l); } catch { /* storage unavailable */ } };
/** Typing time grows with the length of the line, like a person writing it. */
const beat = (text: string) => Math.min(1400, 420 + text.length * 16);
const time = (t: number, lang: string) => new Date(t).toLocaleTimeString(lang === 'ko' ? 'ko-KR' : 'en-US', { hour: '2-digit', minute: '2-digit' });
const MOVE = 0.005;         // a 0.5 percentage-point change in the gap triggers a new note
const QUIET_MS = 120_000;   // at most one unprompted market note every 2 minutes

/** The coin a message is about, if it names one. */
function coinIn(q: string): string | undefined {
  if (/(btc|bitcoin|비트)/i.test(q)) return 'BTC';
  if (/(eth|ether|이더)/i.test(q)) return 'ETH';
  if (/hsk/i.test(q)) return 'HSK';
  if (/(\bsol\b|solana|솔라나)/i.test(q)) return 'SOL';
  if (/(xrp|리플)/i.test(q)) return 'XRP';
  if (/\bbnb\b/i.test(q)) return 'BNB';
  if (/(doge|도지)/i.test(q)) return 'DOGE';
  return undefined;
}

const Icon = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden><path d={d} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

export default function MoaFeed({ quotes, vault, inject, context, agents, agentsFailed, hired, sending, now, onHire, onEdit, onPause, onResume, onApprove, onDecline, onExecuted, onGoto, onAttention, onClose }: {
  quotes: Quote[]; vault: VaultInfo | null; inject?: MoaInject | null; context: MoaContext;
  agents: Agent[] | null; agentsFailed: boolean; hired: HiredAgent[]; sending: Set<string>; now: number;
  onHire: (target: HireTarget) => void; onEdit: (id: string) => void; onPause: (id: string) => void; onResume: (id: string) => void;
  onApprove: (id: string, orderId: string) => void; onDecline: (id: string, orderId: string) => void;
  onExecuted: (x: Execution[]) => void; onGoto: (v: 'trade' | 'agents' | 'mine') => void; onAttention: () => void; onClose?: () => void;
}) {
  const { t, lang } = useT();
  const [notes, setNotes] = useState<Note[]>([]);
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState<StepKey[] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const feed = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);
  const notesRef = useRef<Note[]>([]); notesRef.current = notes;
  const lastGap = useRef<Partial<Record<Quote['asset'], number>>>({});
  const lastNoteAt = useRef(0);
  const nextId = useRef(1);
  const [level, setLevelState] = useState<Level | null>(readLevel);
  const levelRef = useRef<Level | null>(level); levelRef.current = level;
  const sky = useRef<Weather[] | null>(null);
  const scriptRun = useRef(0);
  const greeted = useRef(false);
  const lastCtx = useRef(context.label);
  const quotesRef = useRef(quotes); quotesRef.current = quotes;
  const agentsRef = useRef(agents); agentsRef.current = agents;
  const hiredRef = useRef(hired); hiredRef.current = hired;
  const ctxRef = useRef(context); ctxRef.current = context;
  const pendingRec = useRef<{ coin?: string } | null>(null);
  const announced = useRef<Set<string>>(new Set());
  const mountedAt = useRef(Date.now());

  const push = (n: Omit<Note, 'id' | 'at'>) => setNotes((cur) => [...cur, { ...n, id: nextId.current++, at: Date.now() }]);
  /** Moa's own short notes: a brief "typing" beat, then the note. */
  const say = (n: Line, delay = 600) => {
    setTyping(true);
    setTimeout(() => { setTyping(false); push({ ...n, role: 'moa' }); lastNoteAt.current = Date.now(); }, delay);
  };
  /** Several lines in a row, each after its own typing beat. Anything the user does cancels the rest. Returns when the last lands (ms). */
  const script = (lines: Line[]) => {
    const run = ++scriptRun.current;
    let at = 0;
    lines.forEach((l, i) => {
      at += i === 0 ? 350 : beat(l.text);
      setTimeout(() => { if (scriptRun.current === run) setTyping(true); }, at - Math.min(700, beat(l.text) - 150));
      setTimeout(() => {
        if (scriptRun.current !== run) return;
        setTyping(i < lines.length - 1);
        push({ ...l, role: 'moa' });
        lastNoteAt.current = Date.now();
      }, at);
    });
    return { run, at };
  };
  const interrupt = () => { scriptRun.current++; setTyping(false); };
  const choose = (id: number, c: Choice) => {
    setNotes((cur) => cur.map((n) => (n.id === id ? { ...n, chosen: c.label } : n)));
    push({ role: 'you', text: c.label, follow: [] });
    c.act();
  };
  const setLevel = (l: Level) => { setLevelState(l); saveLevel(l); };

  const name = (b: 'BTC' | 'ETH') => (b === 'BTC' ? t.coinBtc : t.coinEth);
  const p1 = (v: number) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
  const gapLine = (w: Weather) => (w.gap === undefined ? '' : w.gap >= 0.003 ? t.gapPricey((w.gap * 100).toFixed(1)) : w.gap <= -0.003 ? t.gapCheap((-w.gap * 100).toFixed(1)) : t.gapSame);
  /** Today's weather with the latest HSKSwap vs Gate gap folded in (pool prices can arrive after the candles). */
  const skies = (): Weather[] => (sky.current ?? []).map((w) => {
    const gap = quotesRef.current.find((q) => q.asset === w.base)?.gap ?? w.gap;
    const next = { ...w, gap };
    return { ...next, sky: skyOf(next) };
  });
  const mainCoin = () => skies()[0]?.base ?? (ctxRef.current.asset && ['BTC', 'ETH', 'HSK'].includes(ctxRef.current.asset) ? ctxRef.current.asset : 'BTC');

  /* ---------- agents in the conversation ---------- */

  const agentChoices = (a: Agent, rec?: { pool: number }): Choice[] => {
    const others = { label: t.chOthers, act: () => othersNote(a) };
    if (rec) return [others, { label: t.chWhyThis, act: () => say({ text: t.recWhy(rec.pool, drop(a.maxDd), levelRef.current === 'new'), follow: [], choices: [others] }) }];
    if (!a.runnable) return [{ label: t.chWhyNot, act: () => say({ text: t.whyNot(a.base), follow: [], choices: [{ label: t.chPickOne, act: () => recommendNote(undefined) }] }) }, others];
    return [{ label: t.chRisk, act: () => say({ text: t.riskLine(drop(a.maxDd), t.agRisk[a.rule]), follow: [], choices: [others] }) }, others];
  };
  const agentNote = (a: Agent, text: string, rec?: { pool: number }) => say({ text, agent: { a, rec }, follow: [], choices: agentChoices(a, rec) }, 500);
  /** The rule picks; Moa says why in one line. Waits for the scores if they are still loading. */
  const recommendNote = (coin: string | undefined) => {
    const list = agentsRef.current;
    if (!list) {
      if (agentsFailed) { say({ text: t.agentsFailed, follow: [] }); return; }
      pendingRec.current = { coin };
      say({ text: t.agentsLoading, follow: [] }, 300);
      return;
    }
    const r = recommend(list, { coin, level: levelRef.current });
    if (!r) { say({ text: t.agentsFailed, follow: [] }); return; }
    const text = coin && r.scope === 'all' ? t.recNoCoin(coin) : r.scope === 'coin' ? t.recCoin(r.pick.base) : t.recAll;
    agentNote(r.pick, text, { pool: r.pool });
  };
  const othersNote = (a: Agent) => {
    const list = agentsRef.current;
    if (!list) { say({ text: t.agentsLoading, follow: [] }); return; }
    const coin = a.runnable ? a.base : undefined;
    let others = othersFor(a, rankedFor(list, coin));
    if (!others.length && coin) others = othersFor(a, rankedFor(list));
    if (!others.length) { say({ text: t.recNone, follow: [] }); return; }
    say({ text: coin && others.every((x) => x.base === coin) ? t.recOthers(coin) : t.recOthersAll, list: { agents: others, coin }, follow: [] });
  };
  const listNote = (coin: string) => {
    const list = agentsRef.current;
    if (!list) { pendingRec.current = { coin }; say({ text: t.agentsLoading, follow: [] }); return; }
    const ranked = rankedFor(list, coin);
    const rows = ranked.filter((a, i) => ranked.findIndex((b) => b.rule === a.rule) === i).slice(0, 4);
    if (!rows.length) { recommendNote(coin); return; }
    say({ text: t.recOthers(coin), list: { agents: rows, coin }, follow: [] });
  };
  const statusNote = (id: string, text = '') => {
    const h = hiredRef.current.find((x) => x.id === id);
    if (!h) return;
    say({ text, status: id, follow: [] }, 400);
  };

  /* ---------- conversation topics: every answer ends with the next things worth asking ---------- */
  const visited = useRef<Set<Topic>>(new Set());
  const label = (id: Topic): string => {
    const [main, other] = skies();
    switch (id) {
      case 'why': return t.chWhy(main ? t.sky[main.sky][1] : '');
      case 'other': return other ? t.chOther(name(other.base)) : t.chOther(t.coinEth);
      default: return t.topic[id];
    }
  };
  const answer = (id: Topic): { lines: Line[]; next: Topic[] } => {
    const [main, other] = skies();
    const l = levelRef.current ?? 'some';
    const go = (sel: string) => { onGoto('trade'); setTimeout(() => document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 350); };
    switch (id) {
      case 'why': return main ? { lines: [{ text: t.whyNew(name(main.base), main.m1 * 100, main.vsMa, gapLine(main)), follow: [] }], next: ['when', 'how', 'alert'] } : { lines: [{ text: t.wxNoData, follow: [] }], next: ['self'] };
      case 'how': return { lines: [{ text: l === 'pro' ? t.howSkyPro : t.howSky, follow: [] }], next: l === 'pro' ? ['rule', 'chart', 'strats'] : ['why', 'when', 'alert'] };
      case 'when': return { lines: [{ text: main && (main.sky === 'rain' || main.sky === 'storm') ? t.whenWait : t.whenNow, follow: [] }], next: ['split', 'alert', 'doit'] };
      case 'split': return { lines: [{ text: t.splitExplain, follow: [] }], next: ['when', 'alert', 'doit'] };
      case 'alert': return { lines: [{ text: t.alertOn, follow: [] }, { text: t.alertMore, follow: [] }], next: ['doit', 'other', 'self'] };
      case 'other': return other ? { lines: [{ text: l === 'new' ? `${t.wxIs(name(other.base), t.sky[other.sky][1])} ${t.skyMean[other.sky]}` : `${t.someLine(name(other.base), p1(other.m1), gapLine(other))} ${t.verdict[other.sky]}`, follow: [] }], next: ['when', 'alert', 'doit'] } : { lines: [{ text: t.wxNoData, follow: [] }], next: ['self'] };
      case 'chart': go('.chart-card'); return { lines: [{ text: t.chartHere, follow: [] }], next: ['strats', 'rule', 'other'] };
      case 'rule': return { lines: [{ text: t.ruleNow, follow: [] }], next: ['chart', 'strats', 'self'] };
      case 'doit': return { lines: [{ text: vault?.configured ? t.doItVault : t.doItNoVault, follow: [] }], next: [] };
      default: setTimeout(() => input.current?.focus(), 400); return { lines: [{ text: t.selfAsk, follow: [] }], next: [] };
    }
  };
  /** Next choices: what the topic suggests, minus what was already covered, never a dead end. */
  const choicesFor = (ids: Topic[]): Choice[] => {
    const fresh = ids.filter((x) => !visited.current.has(x));
    const pool = fresh.length >= 2 ? fresh : [...fresh, ...((levelRef.current === 'pro' ? ['other', 'strats', 'chart', 'self'] : ['other', 'doit', 'when', 'self']) as Topic[]).filter((x) => !visited.current.has(x) && !fresh.includes(x))];
    const list = (pool.length ? pool : ['self' as Topic]).slice(0, 3);
    return list.map((id) => ({ label: label(id), act: () => runTopic(id) }));
  };
  const runTopic = (id: Topic) => {
    if (id !== 'self') visited.current.add(id);
    if (id === 'strats') { listNote(mainCoin()); return; }
    const { lines, next } = answer(id);
    if (id === 'doit') {
      // ④: the step forward is an agent, picked by the rule, right after the answer.
      const { run, at } = script(lines);
      setTimeout(() => { if (scriptRun.current === run) recommendNote(mainCoin()); }, at + 200);
      return;
    }
    if (!next.length) { script(lines); return; }
    const last = lines.length - 1;
    script(lines.map((x, i) => (i === last ? { ...x, choices: choicesFor(next) } : x)));
  };

  /* ---------- the briefing: same weather, three depths ---------- */
  const briefing = (l: Level): Line[] => {
    const ws = skies();
    if (!ws.length) return [{ text: t.wxNoData, follow: [] }];
    const [main, other] = ws;
    visited.current = new Set();
    const first: Topic[] = l === 'new' ? ['why', 'how', 'alert'] : l === 'some' ? ['alert', 'doit', 'strats'] : ['chart', 'strats', 'rule'];
    const pro = (w: Weather) => t.proLine(w.base, p1(w.vsMa), w.rsi.toFixed(0), p1(w.m1), w.basis === undefined ? '—' : `${w.basis > 0 ? '+' : ''}${(w.basis * 100).toFixed(3)}%`, w.gap === undefined ? '—' : `${w.gap > 0 ? '+' : ''}${(w.gap * 100).toFixed(2)}%`, w.volRatio.toFixed(2));
    const body: Line[] = l === 'new'
      ? [
        { text: t.wxIntroNew, follow: [], sky: { level: l, list: ws } },
        { text: `${t.wxIs(name(main.base), t.sky[main.sky][1])} ${t.skyMean[main.sky]}`, follow: [] },
        ...(other ? [{ text: t.wxIs(name(other.base), t.sky[other.sky][1]), follow: [] }] : []),
        { text: t.wxNextNew, follow: [] },
      ]
      : l === 'some'
        ? [
          { text: t.wxIntro, follow: [], sky: { level: l, list: ws } },
          { text: `${t.someLine(name(main.base), p1(main.m1), gapLine(main))} ${t.verdict[main.sky]}`, follow: [] },
          ...(other ? [{ text: `${t.someLine(name(other.base), p1(other.m1), gapLine(other))} ${t.verdict[other.sky]}`, follow: [] }] : []),
          { text: t.wxNextSome, follow: [] },
        ]
        : [
          { text: t.wxIntroPro, follow: [], sky: { level: l, list: ws } },
          { text: pro(main), follow: [] },
          ...(other ? [{ text: pro(other), follow: [] }] : []),
          { text: t.proState(main.base, main.vsMa > 0, main.rsi < 30), follow: [] },
        ];
    if (other) visited.current.add('other');
    body[body.length - 1] = { ...body[body.length - 1], choices: choicesFor(first) };
    return body;
  };
  const pickLevel = (l: Level) => { setLevel(l); script(briefing(l)); };

  // Opening: Moa speaks first. New visitors get one question to find their level; returning ones go straight on.
  useEffect(() => {
    if (greeted.current) return;
    greeted.current = true;
    const ready = loadWeather(quotes).then((w) => { sky.current = w; }).catch(() => { sky.current = []; });
    const l = levelRef.current;
    if (l) { void ready.then(() => script([{ text: t.helloAgain, follow: [] }, ...briefing(l)])); return; }
    script([
      { text: t.hello1, follow: [] },
      { text: t.hello2, follow: [] },
      { text: t.askLevel, follow: [], choices: [
        { label: t.lvNew, act: () => void ready.then(() => pickLevel('new')) },
        { label: t.lvSome, act: () => void ready.then(() => pickLevel('some')) },
        { label: t.lvPro, act: () => void ready.then(() => pickLevel('pro')) },
      ] },
    ]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Switching screen or market: one short line, in the user's depth.
  useEffect(() => {
    if (lastCtx.current === context.label) return;
    const first = !lastCtx.current;
    lastCtx.current = context.label;
    if (first) return; // the trade screen reporting its market on load is not a switch
    // Only a market change on the trade screen earns a line; the chip above the input already names the screen.
    if (!context.venue || !greeted.current || busy || Date.now() - lastNoteAt.current < 4000) return;
    say({ text: levelRef.current === 'pro' && context.venue ? t.ctxSwitchPro(context.label) : t.ctxSwitch(context.label), follow: [] }, 500);
  }, [context.label]); // eslint-disable-line react-hooks/exhaustive-deps

  // A recommendation asked for while the scores were loading.
  useEffect(() => {
    if (!agents || !pendingRec.current) return;
    const { coin } = pendingRec.current;
    pendingRec.current = null;
    recommendNote(coin);
  }, [agents]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hired agents speak through Moa: every order waits for an answer here; a skipped day gets one line.
  useEffect(() => {
    for (const h of hired) {
      const o = h.pending;
      if (o && !announced.current.has(o.id)) {
        announced.current.add(o.id);
        // After any line Moa is about to say (e.g. "Hired …"), so the question reads in order.
        const id = { hiredId: h.id, orderId: o.id };
        setTimeout(() => { push({ role: 'moa', text: '', order: id, follow: [] }); lastNoteAt.current = Date.now(); }, 900);
      }
      const s = lastEvent(h, 'skipped');
      const key = s ? `${h.id}:skip:${s.at}` : '';
      if (s && s.at > mountedAt.current && !announced.current.has(key)) {
        announced.current.add(key);
        say({ text: t.skipSay(hiredName(t, h), skipText(t, s.why)), follow: [] }, 300);
      }
    }
  }, [hired]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Agent requests Moa answers itself, without the AI. Returns true when handled. */
  const local = (q: string): boolean => {
    const list = hiredRef.current;
    if (STOP_WORDS.test(q) && !/(loss|손절)/i.test(q)) {
      const running = list.filter((h) => !h.paused && statusOf(h, Date.now()) !== 'done');
      if (!running.length) { say({ text: t.nothingToStop, follow: [] }, 400); return true; }
      running.forEach((h) => onPause(h.id));
      say({ text: t.pausedSay(running.map((h) => hiredName(t, h)).join(', ')), follow: [] }, 400);
      return true;
    }
    if (STATUS_WORDS.test(q) && list.length) {
      list.slice(0, 3).forEach((h, i) => setTimeout(() => statusNote(h.id), i * 250));
      return true;
    }
    if (RECOMMEND_WORDS.test(q)) { recommendNote(coinIn(q) ?? ctxRef.current.asset); return true; }
    if (STATUS_WORDS.test(q) && !list.length) { say({ text: t.noHired, follow: [], choices: [{ label: t.chPickOne, act: () => recommendNote(ctxRef.current.asset) }] }, 400); return true; }
    return false;
  };

  /** Ask Moa right here: the question, live progress steps, then the answer (or the on-device fallback). */
  const ask = async (text: string, confirmed = false) => {
    const q = text.trim();
    if (!q || busy) return;
    if (!confirmed && EXECUTE_WORDS.test(q) && vault?.configured) { setConfirm(q); return; }
    interrupt();
    setDraft('');
    if (PRO_WORDS.test(q) && levelRef.current !== 'pro') setLevel('pro');
    const history = [
      // What the user is looking at goes in as context, so "this" and "here" mean something.
      { role: 'moa' as const, text: `${t.ctxNow}: ${context.label}` },
      ...notesRef.current.filter((n) => n.text || n.agent || n.list).map((n) => ({ role: n.role, text: n.agent ? `${n.text} [${agentName(t, n.agent.a)}]` : n.list ? `${n.text} ${n.list.agents.map((a) => agentName(t, a)).join(', ')}` : n.text })),
      { role: 'you' as const, text: q },
    ];
    push({ role: 'you', text: q, follow: [] });
    if (!EXECUTE_WORDS.test(q) && local(q)) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(['thinking']);
    try {
      const res = await askMoa(history, (s) => setBusy((b) => (b && b[b.length - 1] !== s ? [...b, s] : b)), ctrl.signal, { level: levelRef.current, asset: ctxRef.current.asset });
      const plan = res.plan?.steps.length ? { steps: res.plan.steps.map(toStep), missing: res.plan.missing } : undefined;
      if (res.executions?.length) onExecuted(res.executions.map((x) => ({ at: Date.now(), ok: x.ok, asset: x.request.asset, side: x.request.side, amount: x.request.amount, reason: x.reason, txHash: x.txHash, explorerUrl: x.explorerUrl, amountIn: x.amountIn, amountOut: x.amountOut, tokenIn: x.tokenIn, tokenOut: x.tokenOut })));
      push({ role: 'moa', text: res.reply, plan, goal: q, execs: res.executions?.length ? res.executions : undefined, follow: [] });
      if (res.recommend) {
        // The server ran the same rule; show its pick from this screen's data, or pick again if it is missing here.
        const a = agentsRef.current?.find((x) => x.id === res.recommend!.agentId);
        if (a) { const r = recommend(agentsRef.current!, { coin: a.base, level: levelRef.current }); agentNote(a, '', { pool: r?.pool ?? 1 }); }
        else recommendNote(res.recommend.coin === 'any' ? undefined : res.recommend.coin);
      }
    } catch {
      if (ctrl.signal.aborted) { setBusy(null); return; }
      // No server or the AI is unreachable: answer with the on-device parser, clearly marked.
      const p = parseIntent(q);
      push({ role: 'moa', text: offlineReply(p, quotes, lang), plan: p.steps.length ? p : undefined, goal: q, offline: true, follow: [] });
    }
    setBusy(null);
    lastNoteAt.current = Date.now();
  };
  const stop = () => { abort.current?.abort(); setBusy(null); };

  // Watching: when a pool moves noticeably against Gate, Moa speaks up on its own.
  useEffect(() => {
    for (const q of quotes) {
      if (q.gap === undefined) continue;
      const prev = lastGap.current[q.asset];
      lastGap.current[q.asset] = q.gap;
      if (busy || prev === undefined || Math.abs(q.gap - prev) < MOVE || Date.now() - lastNoteAt.current < QUIET_MS) continue;
      say({ text: t.feedMoved(q.asset, (prev * 100).toFixed(1), (q.gap * 100).toFixed(1)), follow: [t.fuPlan(q.asset)] });
      break;
    }
  }, [quotes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Something on another part of the screen handed Moa a job.
  useEffect(() => {
    if (!inject) return;
    interrupt();
    if (inject.kind === 'agent') agentNote(inject.agent, explainAgent(t, inject.agent));
    else if (inject.kind === 'recommend') recommendNote(inject.coin);
    else if (inject.kind === 'status') statusNote(inject.hiredId);
    else {
      const h = hiredRef.current.find((x) => x.id === inject.hiredId);
      if (h) {
        const c = inject.changed;
        statusNote(h.id, c ? t.changedSay(hiredName(t, h), `$${money(c.from.perBuyUsd)} · $${money(c.from.budgetUsd)}`, `$${money(c.to.perBuyUsd)} · $${money(c.to.budgetUsd)}`) : t.hiredSay(hiredName(t, h)));
      }
    }
    onAttention();
  }, [inject]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const el = feed.current; if (el && (notes.length || busy)) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }, [notes, typing, busy]);
  useEffect(() => { const el = input.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 140)}px`; }, [draft]);
  useEffect(() => {
    if (!busy) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') stop(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const byId = (id: string) => hired.find((h) => h.id === id);
  const priceOf = (h: HiredAgent) => quotes.find((q) => q.asset === h.asset)?.pool;

  return (
    <aside className="dock feed-dock" aria-label="Moa">
      <header className="feed-head">
        <span className="orb sm breathe" aria-hidden />
        <b>Moa</b>
        <span className="feed-status"><span className="live-dot" /> {level ? t.live : t.feedWatching}</span>
        {level && (
          <div className="depth-switch has-pill" role="tablist" aria-label={t.depthLabel}>
            <SlidePill dep={level} />
            {(['new', 'some', 'pro'] as Level[]).map((l) => <button key={l} role="tab" aria-selected={level === l} className={level === l ? 'on' : ''} onClick={() => { if (l !== level && !busy) { interrupt(); setLevel(l); script([{ text: t.depthNow[l], follow: [] }, ...briefing(l)]); } }}>{t.depth[l]}</button>)}
          </div>
        )}
        {notes.length > 0 && !busy && <button className="feed-clear" onClick={() => setNotes([])} data-tip={t.feedClearTip} aria-label={t.feedClearTip}><Icon d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" /></button>}
        {onClose && <button className="feed-close" onClick={onClose} aria-label={t.closeMoa}><Icon d="M5 5l10 10M15 5L5 15" /></button>}
      </header>

      <div className="feed" ref={feed} aria-live="polite">
        {notes.map((n, k) => n.role === 'you' ? (
          <div key={n.id} className="you-row fade-up"><p className="you-bubble">{n.text}</p></div>
        ) : (
          <article key={n.id} className="note fade-up">
            {/* Messenger grouping: name and time only on the first of consecutive Moa lines. */}
            {(k === 0 || notes[k - 1].role !== 'moa' || n.at - notes[k - 1].at > 60_000) && <div className="note-meta"><span className="orb xs" aria-hidden /> Moa <time>{time(n.at, lang)}</time></div>}
            {n.text && <div className="note-text"><RichText text={n.text} /></div>}
            {n.offline && <p className="note-offline">{t.offline}</p>}
            {n.sky && <SkyCard level={n.sky.level} list={n.sky.list} />}
            {n.agent && (
              <AgentCard agent={n.agent.a} size="chat" actions={n.agent.a.runnable && (
                <div className="acard-cta"><button className="btn-primary" onClick={() => onHire({ kind: 'agent', agent: n.agent!.a })}>{t.acHire}</button></div>
              )} />
            )}
            {n.list && (
              <div className="rowlist">
                {n.list.agents.map((a) => (
                  <button key={a.id} className="rowlist-row" onClick={() => { push({ role: 'you', text: agentName(t, a), follow: [] }); agentNote(a, explainAgent(t, a)); }}>
                    <span className="rowlist-name"><b>{agentName(t, a)}</b><small>{t.agLine[a.rule]}</small></span>
                    <span className="rowlist-v">{drop(a.maxDd)}</span>
                  </button>
                ))}
                <button className="rowlist-row link" onClick={() => onGoto('agents')}>{t.recMarket}</button>
              </div>
            )}
            {n.list && <p className="rowlist-foot">{t.recOthersFoot}</p>}
            {n.status && byId(n.status) && (
              <StatusCard h={byId(n.status)!} price={priceOf(byId(n.status)!)} now={now} onEdit={() => onEdit(n.status!)}
                onPause={() => onPause(n.status!)} onResume={() => onResume(n.status!)} onLog={() => onGoto('mine')} />
            )}
            {n.order && byId(n.order.hiredId) && (
              <OrderCard h={byId(n.order.hiredId)!} orderId={n.order.orderId} sending={sending.has(n.order.orderId)} vault={vault}
                onApprove={() => onApprove(n.order!.hiredId, n.order!.orderId)} onDecline={() => onDecline(n.order!.hiredId, n.order!.orderId)} />
            )}
            {n.choices && (
              <div className={`choices${n.chosen ? ' done' : ''}`}>
                {n.choices.map((c) => (
                  <button key={c.label} className={`choice${n.chosen === c.label ? ' picked' : ''}`} disabled={!!n.chosen || !!busy} onClick={() => choose(n.id, c)}>{c.label}</button>
                ))}
              </div>
            )}
            {n.execs?.map((x, k) => <Receipt key={k} x={x} />)}
            {n.plan && n.plan.steps.length > 0 && (
              <div className="plan-mini">
                <b>{t.planMini}</b>
                <ol>{n.plan.steps.map((s, k) => <li key={k}>{describe(s, lang)}</li>)}</ol>
                {n.plan.missing.length === 0
                  ? <button className="btn-primary" onClick={() => onHire({ kind: 'custom', goal: n.goal ?? '', plan: n.plan! })}>{t.makeBot}</button>
                  : <p className="muted small">{t.planNeeds(n.plan.missing.join(', '))}</p>}
              </div>
            )}
            {n.goal && <div className="note-actions"><CopyButton text={n.text} label={t.copy} done={t.copied} /></div>}
            {n.follow.length > 0 && (
              <div className="followups">
                {n.follow.map((f) => <button key={f} className="fu" disabled={!!busy} onClick={() => void ask(f)}><span aria-hidden>↳</span>{f}</button>)}
              </div>
            )}
          </article>
        ))}
        {(typing || busy) && (
          <div className="note typing-note" role="status">
            <div className="note-meta"><span className="orb xs" aria-hidden /> Moa</div>
            {busy
              ? <div className="moa-steps">{busy.map((s, k) => <span key={s} className={k === busy.length - 1 ? 'now' : 'done'}>{k === busy.length - 1 ? <span className="dots"><i /><i /><i /></span> : '✓'} {t.steps[s]}</span>)}</div>
              : <span className="dots" aria-label={t.feedTyping}><i /><i /><i /></span>}
          </div>
        )}
      </div>

      <form className="feed-composer" onSubmit={(e) => { e.preventDefault(); void ask(draft); }}>
        <span className="ctx-chip" data-tip={t.ctxTip}>{context.asset ? <CoinMark base={context.asset} /> : <span className="orb xs" aria-hidden />}{context.label}</span>
        <div className="composer-row">
          <textarea ref={input} rows={1} value={draft} onChange={(e) => { if (!draft) interrupt(); setDraft(e.target.value); }} placeholder={t.feedPlaceholder} aria-label={t.askMoa}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(draft); } }} />
          {busy
            ? <button className="send-btn stop" type="button" onClick={stop} aria-label={t.stop} data-tip={`${t.stop} (Esc)`}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" /></svg></button>
            : <button className="send-btn" type="submit" disabled={!draft.trim()} aria-label={t.ask} data-tip={`${t.ask} (Enter)`}>
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>}
        </div>
      </form>
      <div className="feed-foot">
        <span aria-hidden>🔒</span>
        {vault?.configured
          ? <>{t.feedLimits(vault.maxTradeUsdt ?? '?', vault.maxDailyUsdt ?? '?')} {vault.vault && <CopyAddress value={vault.vault} label={t.copyAddress} done={t.addressCopied} />}{vault.localFork && <span className="fork-badge">{t.localFork}</span>}</>
          : t.trust3none}
      </div>

      {confirm && (
        <Modal title={t.confirmTitle} onClose={() => setConfirm(null)} actions={<>
          <button className="btn-ghost" onClick={() => setConfirm(null)}>{t.cancel}</button>
          <button className="btn-primary" onClick={() => { const q = confirm; setConfirm(null); void ask(q, true); }}>{t.executeBtn}</button>
        </>}>
          <p className="modal-quote">“{confirm}”</p>
          <p>{t.confirmBody(vault?.maxTradeUsdt ?? '?', vault?.remainingTodayUsdt ?? '0')}</p>
        </Modal>
      )}
    </aside>
  );
}

/** A hired agent right now, read from its record (never from Moa's memory). */
function StatusCard({ h, price, now, onEdit, onPause, onResume, onLog }: {
  h: HiredAgent; price?: number; now: number; onEdit: () => void; onPause: () => void; onResume: () => void; onLog: () => void;
}) {
  const { t } = useT();
  const st = statusOf(h, now);
  const b = book(h);
  const m = moneyLine(t, h, price);
  const last = h.log[h.log.length - 1];
  const lastLine = last ? eventLine(t, h, last) : undefined;
  return (
    <div className={`status-card st-${st}`}>
      <div className="status-head"><span className={`chip-dot ${st}`} aria-hidden /><b>{hiredName(t, h)}</b><span className="muted">{statusText(t, h, now)}</span></div>
      <dl className="acard-nums">
        <div><dt>{t.scPer}</dt><dd>${money(h.perBuyUsd)}</dd></div>
        <div><dt>{t.scSpent}</dt><dd>${money(b.spent)} / ${money(h.budgetUsd)}</dd></div>
        <div><dt>{t.scPnl}</dt><dd className={m.cls}>{h.fills.length ? m.text : t.scNone}</dd></div>
      </dl>
      {b.qty > 0 && <p className="status-line">{t.scHeld}: {qtyText(b.qty)} {h.asset}{price !== undefined ? ` · ${t.scValue} $${money(b.qty * price)}` : ''}</p>}
      {lastLine && <p className="status-line muted">{t.scLast}: {lastLine.label}{lastLine.detail ? ` · ${lastLine.detail}` : ''}</p>}
      <div className="status-actions">
        <button className="btn-ghost sm" onClick={onEdit}>{t.scEdit}</button>
        {h.paused ? <button className="btn-ghost sm" onClick={onResume}>{t.stResume}</button> : st !== 'done' && <button className="btn-ghost sm" onClick={onPause}>{t.stPause}</button>}
        <button className="btn-ghost sm" onClick={onLog}>{t.scLog}</button>
      </div>
    </div>
  );
}

/** One order a hired agent wants: the question while it is open, then what happened. */
function OrderCard({ h, orderId, sending, vault, onApprove, onDecline }: {
  h: HiredAgent; orderId: string; sending: boolean; vault: VaultInfo | null; onApprove: () => void; onDecline: () => void;
}) {
  const { t } = useT();
  const asked = h.log.find((e) => e.k === 'asked' && e.order.id === orderId);
  if (!asked || asked.k !== 'asked') return null;
  const o = asked.order;
  const outcome = h.log.find((e) => (e.k === 'filled' || e.k === 'declined' || e.k === 'failed' || e.k === 'expired') && e.orderId === orderId);
  const open = h.pending?.id === orderId && !outcome;
  const name = hiredName(t, h);
  return (
    <div className={`order-card${open ? ' open' : ''}`}>
      <p className="order-q">{o.side === 'buy' ? t.orderBuy(name, money(o.usd ?? 0), h.asset) : t.orderSell(name, qtyText(o.qty ?? 0), h.asset)}</p>
      <p className="order-why">{whyText(t, o.why)}</p>
      {open && !vault?.configured && <p className="order-demo">{t.obDemo}</p>}
      {open && (
        <div className="order-cta">
          <button className="btn-primary" onClick={onApprove} disabled={sending}>{sending ? t.obSending : o.side === 'buy' ? t.obBuy(money(o.usd ?? 0)) : t.obSell}</button>
          <button className="btn-ghost" onClick={onDecline} disabled={sending}>{t.obSkip}</button>
        </div>
      )}
      {outcome?.k === 'filled' && (
        <div className="receipt-mini ok">
          <b>{t.receiptOk}</b>
          <span>{outcome.fill.side === 'buy' ? t.filledBuy(money(outcome.fill.usd), qtyText(outcome.fill.qty), h.asset) : t.filledSell(qtyText(outcome.fill.qty), h.asset, money(outcome.fill.usd))}</span>
          {outcome.fill.explorerUrl && <a href={outcome.fill.explorerUrl} target="_blank" rel="noreferrer">{t.viewTx} ↗</a>}
        </div>
      )}
      {outcome?.k === 'failed' && (outcome.demo ? <p className="order-demo">{t.obDemoDone}</p> : <div className="receipt-mini fail"><b>{t.receiptFail}</b><span>{t.obFailed(outcome.reason)}</span></div>)}
      {outcome?.k === 'declined' && <p className="muted small-text">{t.obDeclined}</p>}
      {outcome?.k === 'expired' && <p className="muted small-text">{t.obExpired}</p>}
    </div>
  );
}

/** A trade Moa sent to the vault: what happened, with the explorer link. */
function Receipt({ x }: { x: Exec }) {
  const { t } = useT();
  return (
    <div className={`receipt-mini ${x.ok ? 'ok' : 'fail'}`}>
      <b>{x.ok ? t.receiptOk : t.receiptFail}</b>
      <span>{x.request.side === 'buy' ? t.buy : t.sell} {x.request.asset} · ${x.request.amount}{x.reason ? ` · ${x.reason}` : ''}</span>
      {x.explorerUrl && <a href={x.explorerUrl} target="_blank" rel="noreferrer">{t.viewTx} ↗</a>}
    </div>
  );
}

/** The weather card in Moa's briefing: one row per coin, worded for the user's depth. */
function SkyCard({ level, list }: { level: Level; list: Weather[] }) {
  const { t } = useT();
  return (
    <div className={`sky-card sky-${level}`}>
      {level === 'pro' && <div className="sky-title">{t.skyProTitle}</div>}
      {list.map((w) => (
        <div key={w.base} className="sky-row">
          <CoinMark base={w.base} />
          <span className="sky-name">{level === 'pro' ? w.base : w.base === 'BTC' ? t.coinBtc : t.coinEth}</span>
          <span className={`sky-icon sky-${w.sky}`} aria-hidden>{t.sky[w.sky][0]}</span>
          <span className="sky-word">{level === 'pro' ? t.skyPro[w.sky] : t.sky[w.sky][2]}</span>
          {level !== 'new' && <span className={`sky-m1 ${w.m1 >= 0 ? 'pos' : 'neg'}`}>{w.m1 > 0 ? '+' : ''}{(w.m1 * 100).toFixed(1)}%</span>}
        </div>
      ))}
    </div>
  );
}
