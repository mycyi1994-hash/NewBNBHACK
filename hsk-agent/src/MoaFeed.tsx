// Moa: one conversation, docked on the right of every screen. Moa explains, recommends and reports;
// it never trades on its own and never changes amounts. Its jobs:
//  - open the conversation (level question, coin weather) and keep it moving with next-step choices
//  - recommend an agent by a fixed rule (recommend.ts) and hand it to the hire sheet
//  - show a hired agent's status, ask before each of its trades, and report what happened
// Requests that are clearly about agents (pick one, stop, how is it doing) are answered here without the AI;
// everything else goes to the server brain, which may also call the recommend tool.
// Numbers come from live data or from the hired agent record; Moa keeps no copy of either.
import { JournalBox } from './Journal.tsx';
import { useEffect, useRef, useState } from 'react';
import type { Quote } from './market.ts';
import { useT } from './i18n.ts';
import { SlidePill } from './motion.tsx';
import { Icon as SIcon, Spark } from './Icons.tsx';
import { limitsText, type VaultInfo } from './parts.tsx';
import { fmtPrice } from './market.ts';
import { CopyButton, RichText } from './ui.tsx';
import { VaultLine } from './VaultCard.tsx';
import { parse } from './spec.ts';
import { askMoa, confirmProposal, EXECUTE_WORDS, toStep, type Exec, type Proposal, type StepKey } from './moaClient.ts';
import { describe, parseIntent, type Plan } from './intent.ts';
import { reply as offlineReply } from './moa.ts';
import type { Execution } from './store.ts';
import { CoinMark } from './CoinMark.tsx';
import { loadWeather, skyOf, type Weather } from './weather.ts';
import type { LpPlan } from './lp.ts';
import { parseLp, reachOf, widthFor } from './lpTalk.ts';
import { POOLS } from './dex.ts';
import { spreadRead, spreadBrief } from './spread.ts';
import { ASSETS } from './intent.ts';
import { beatsHold, holdNumbers, isRunnable, type Agent } from './agents.ts';
import { othersFor, rankedFor, recommend, type Level } from './recommend.ts';
import { AgentCard, agentName, drop, explainAgent, Face, pct } from './AgentCard.tsx';
import type { HireTarget } from './HireSheet.tsx';
import { book, lastEvent, statusOf, type Amounts, type HiredAgent } from './runner.ts';
import { hiredName, money, qtyText, signedMoney, skipText, whyText } from './hiredText.ts';
import { HireCard, StatusCard } from './AgentLive.tsx';
import { agentColors, agentRows, OTHER_COLOR, totalPnl } from './portfolio.ts';

export interface MoaContext { venue?: 'cex' | 'dex'; label: string; asset?: string; perp?: boolean }
/** A job another part of the screen hands to Moa. */
export type MoaAsk =
  | { kind: 'agent'; agent: Agent }
  | { kind: 'recommend'; coin?: string }
  | { kind: 'status'; hiredId: string }
  | { kind: 'hired'; hiredId: string; changed?: { from: Amounts; to: Amounts } }
  | { kind: 'ask'; text: string }
  /** The liquidity studio opened: walk the user through the plan. */
  | { kind: 'lp' }
  /** Moa says this as it is (the liquidity studio explaining a choice). */
  | { kind: 'note'; text: string };
export type MoaInject = MoaAsk & { n: number };
export type { Level };
interface Choice { label: string; act: () => void; primary?: boolean }
interface Note {
  id: number; at: number; role: 'moa' | 'you'; text: string; plan?: Plan; goal?: string; execs?: Exec[]; proposals?: Proposal[]; offline?: boolean;
  follow: string[]; choices?: Choice[]; chosen?: string; sky?: { level: Level; list: Weather[] };
  agent?: { a: Agent; rec?: { pool: number } }; list?: { agents: Agent[]; coin?: string }; status?: string; hired?: string; order?: { hiredId: string; orderId: string };
}
type Line = Omit<Note, 'id' | 'at' | 'role'>;
type Topic = 'why' | 'how' | 'when' | 'split' | 'alert' | 'other' | 'strats' | 'chart' | 'rule' | 'doit' | 'self';
const PRO_WORDS = /(rsi|macd|ema|롱|숏|레버리지|펀딩|볼린저|지표|long|short|leverage|funding|bollinger)/i;
const BUILD_WORDS = /(에이전트|전략|봇|agent|strategy|bot).{0,24}(만들|짜|생성|create|make|build)|(만들|짜|create|make|build).{0,24}(에이전트|전략|봇|agent|strategy|bot)/i;
const RECOMMEND_WORDS = /(추천|맡길|맡겨|골라|recommend|suggest|which agent|pick (?:one|an agent))/i;
const STOP_WORDS = /(멈춰|멈추|중지|정지|그만해|pause|stop (?:the |my |all )?(?:agents?|bots?))/i;
/** What is in my vault right now, answered from the chain without the AI. */
const VAULT_WORDS = /(포지션|보유|잔고|잔액|볼트|금고|들고 있|what do i (?:hold|have|own)|position|holdings?|balance|my vault)/i;
/** The price gap between the exchange and HSKSwap, and whether it is worth anything. */
const SPREAD_WORDS = /(스프레드|차익|가격 ?차이|괴리|arbitrage|spread|price gap)/i;
const STATUS_WORDS = /(얼마 벌|수익|손익|현황|잘 하고|어떻게 하고|how (?:are|is) my|status|p&l|pnl|profit)/i;
/** A question about a coin or the market ("비트코인 어때?"): answered from the briefing's own data when the AI is away. */
const MARKET_WORDS = /(어때|어떄|어떻|어떤가|시장|시세|가격|요즘|살까|사도 돼|팔까|오를까|내릴까|전망|how(?:'s| is| about)|price|market|outlook|should i buy)/i;
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

export default function MoaFeed({ lp, onLp, quotes, vault, inject, context, agents, agentsFailed, hired, sending, now, onHire, onEdit, onPause, onResume, onApprove, onDecline, onExecuted, onGoto, onShow, onBuild, onAttention, onClose }: {
  /** The liquidity studio's plan while it is open; Moa fills it from the conversation. */
  lp?: LpPlan | null; onLp?: (p: LpPlan | null) => void;
  quotes: Quote[]; vault: VaultInfo | null; inject?: MoaInject | null; context: MoaContext;
  agents: Agent[] | null; agentsFailed: boolean; hired: HiredAgent[]; sending: Set<string>; now: number;
  onHire: (target: HireTarget) => void; onEdit: (id: string) => void; onPause: (id: string) => void; onResume: (id: string) => void;
  onApprove: (id: string, orderId: string) => void; onDecline: (id: string, orderId: string) => void;
  onExecuted: (x: Execution[]) => void; onGoto: (v: 'trade' | 'agents' | 'mine') => void; onShow: (a: Agent) => void; onBuild: (text: string) => void; onAttention: () => void; onClose?: () => void;
}) {
  const { t, lang } = useT();
  const [notes, setNotes] = useState<Note[]>([]);
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState<StepKey[] | null>(null);
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
  const lastLang = useRef(lang);
  const quotesRef = useRef(quotes); quotesRef.current = quotes;
  const agentsRef = useRef(agents); agentsRef.current = agents;
  const hiredRef = useRef(hired); hiredRef.current = hired;
  const ctxRef = useRef(context); ctxRef.current = context;
  const pendingRec = useRef<{ coin?: string } | null>(null);
  /** The coin the last briefing was about; choices under it act on this coin, whatever is on screen later. */
  const focus = useRef<string | null>(null);
  const [skyReady, setSkyReady] = useState(false);
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
  /** Today's weather with the latest HSKSwap vs Gate gap folded in; the coin Moa is talking about comes first. */
  const skies = (): Weather[] => {
    const list = (sky.current ?? []).map((w) => {
      const gap = quotesRef.current.find((q) => q.asset === w.base)?.gap ?? w.gap;
      const next = { ...w, gap };
      return { ...next, sky: skyOf(next) };
    });
    const at = list.findIndex((w) => w.base === (focus.current ?? ctxRef.current.asset));
    return at > 0 ? [list[at], ...list.filter((_, n) => n !== at)] : list;
  };
  /** The coin Moa talks about: the one it last briefed, so a choice never names one coin and acts on another. */
  const mainCoin = () => focus.current ?? skies()[0]?.base ?? 'BTC';

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
    const hiredIds = hiredRef.current.flatMap((h) => (h.source.type === 'market' ? [h.source.agentId] : []));
    const r = recommend(list, { coin, level: levelRef.current, exclude: hiredIds });
    if (!r) { say({ text: t.agentsFailed, follow: [] }); return; }
    // One definition everywhere (beatsHold), and the sentence names its period and the numbers its card shows.
    const beat = beatsHold(r.pick), h = holdNumbers(r.pick);
    const per = t.pickOver(t.oosSpan(h.days), t.oosSpan(h.ago)), full = t.fullOver(t.oosSpan(h.fullDays), pct(h.full));
    const text = coin && r.scope === 'all' ? t.recNoCoin(coin) : r.scope === 'coin' ? t.recCoin(r.pick.base, beat, per, pct(h.edge), full) : t.recAll(beat, per, pct(h.edge), full);
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
    say({ text: t.recList(coin), list: { agents: rows, coin }, follow: [] });
  };
  const statusNote = (id: string, text = '') => {
    const h = hiredRef.current.find((x) => x.id === id);
    if (!h) return;
    say({ text, status: id, follow: [] }, 400);
  };

  /* ---------- conversation topics: every answer ends with the next things worth asking ---------- */
  const visited = useRef<Set<Topic>>(new Set());
  const label = (id: Topic, coin: string): string => {
    const [main, other] = skies();
    switch (id) {
      case 'why': return t.chWhy(main ? t.sky[main.sky][1] : '');
      case 'other': return other ? t.chOther(name(other.base)) : t.chOther(t.coinEth);
      case 'strats': return t.chAgents(coin);
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
  const choicesFor = (ids: Topic[], lead = false): Choice[] => {
    const fresh = ids.filter((x) => !visited.current.has(x));
    const pool = fresh.length >= 2 ? fresh : [...fresh, ...((levelRef.current === 'pro' ? ['other', 'strats', 'chart', 'self'] : ['other', 'doit', 'when', 'self']) as Topic[]).filter((x) => !visited.current.has(x) && !fresh.includes(x))];
    const list = (pool.length ? pool : ['self' as Topic]).slice(0, 3);
    const coin = mainCoin();
    return list.map((id, n) => ({ label: label(id, coin), act: () => runTopic(id, coin), primary: lead && n === 0 }));
  };
  const runTopic = (id: Topic, coin: string) => {
    if (id !== 'self') visited.current.add(id);
    if (id === 'strats') { listNote(coin); return; }
    const { lines, next } = answer(id);
    if (id === 'doit') {
      // ④: the step forward is an agent, picked by the rule, right after the answer.
      const { run, at } = script(lines);
      setTimeout(() => { if (scriptRun.current === run) recommendNote(coin); }, at + 200);
      return;
    }
    if (!next.length) { script(lines); return; }
    const last = lines.length - 1;
    script(lines.map((x, i) => (i === last ? { ...x, choices: choicesFor(next) } : x)));
  };

  /* ---------- the briefing: the conclusion for the coin on screen, one table, one step forward ---------- */
  const briefing = (l: Level): Line[] => {
    const onScreen = ctxRef.current.asset;
    if (onScreen && (sky.current ?? []).some((w) => w.base === onScreen)) focus.current = onScreen;
    const ws = skies();
    if (!ws.length) return [{ text: t.wxNoData, follow: [] }];
    const [main, other] = ws;
    focus.current = main.base;
    visited.current = new Set();
    // The conclusion is the bold first sentence; the reason follows in plain weight.
    const head = l === 'new' ? `**${t.wxIs(name(main.base), t.sky[main.sky][1])}** ${t.skyMean[main.sky]}`
      : l === 'some' ? `**${name(main.base)}: ${t.verdict[main.sky]}** ${t.someWhy(p1(main.m1), gapLine(main))}`
        : `**${t.proHead(main.base, t.skyPro[main.sky])}** ${t.proWhy(main.vsMa > 0, main.rsi < 30)}`;
    // The first choice moves forward (an agent); the rest help understand.
    const first: Topic[] = l === 'new' ? ['doit', 'why', 'how'] : l === 'some' ? ['strats', 'doit', 'alert'] : ['strats', 'chart', 'rule'];
    if (other) visited.current.add('other');
    return [{ text: head, follow: [], sky: { level: l, list: ws }, choices: choicesFor(first, true) }];
  };
  const pickLevel = (l: Level) => { setLevel(l); script(briefing(l)); };

  // Opening: Moa speaks first. New visitors get one question to find their level; returning ones go straight on.
  useEffect(() => {
    if (greeted.current) return;
    greeted.current = true;
    const ready = loadWeather(quotes).then((w) => { sky.current = w; }).catch(() => { sky.current = []; }).then(() => setSkyReady(true));
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
    // The label is translated, so a language change renames it; that is not a move to another screen.
    if (lastLang.current !== lang) { lastLang.current = lang; return; }
    if (first) return; // the trade screen reporting its market on load is not a switch
    // Only a market change on the trade screen earns a line; the chip above the input already names the screen.
    if (!context.venue || !greeted.current || busy || Date.now() - lastNoteAt.current < 4000) return;
    const coin = context.asset;
    // A coin with weather that is not the one briefed gets its own briefing (the effect below), not a line.
    if (coin && coin !== focus.current && (sky.current ?? []).some((w) => w.base === coin)) return;
    const agentsOf = coin && isRunnable(coin) && coin !== focus.current ? [{ label: t.chAgents(coin), act: () => listNote(coin), primary: true }] : undefined;
    say({ text: levelRef.current === 'pro' && context.venue ? t.ctxSwitchPro(context.label) : t.ctxSwitch(context.label), follow: [], choices: agentsOf }, 500);
  }, [context.label]); // eslint-disable-line react-hooks/exhaustive-deps

  // The coin on screen changed to another one Moa has weather for: say the conclusion for that coin, once Moa is free.
  useEffect(() => {
    const coin = context.asset, l = levelRef.current;
    if (!coin || !l || !skyReady || !focus.current || focus.current === coin || busy || typing) return;
    if (!(sky.current ?? []).some((w) => w.base === coin)) return;
    const id = setTimeout(() => script(briefing(l)), 700);
    return () => clearTimeout(id);
  }, [context.asset, busy, typing, skyReady]); // eslint-disable-line react-hooks/exhaustive-deps

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

  /** All hired agents' profit or loss in one sentence, from their own fills at the pool price now. */
  const pnlLine = (): string => {
    const rows = agentRows(hiredRef.current, (a) => quotesRef.current.find((x) => x.asset === a)?.pool, Date.now());
    const tp = totalPnl(rows);
    const spent = rows.reduce((s, r) => s + book(r.h).spent, 0);
    if (!tp) return t.pnlNone(rows.length);
    return t.pnlSum(rows.length, signedMoney(tp.usd), tp.pct !== undefined ? `${tp.pct >= 0 ? '+' : '−'}${Math.abs(tp.pct * 100).toFixed(1)}%` : '', money(spent));
  };
  /**
   * Without the AI, a question about a coin gets the same conclusion the briefing gives (weather, 30-day move, pool
   * vs exchange), and a coin without weather gets its pool price. Returns false when there is nothing to say from data.
   */
  const marketOffline = (q: string): boolean => {
    const coin = coinIn(q) ?? (MARKET_WORDS.test(q) ? mainCoin() : undefined);
    if (!coin) return false;
    if ((sky.current ?? []).some((w) => w.base === coin)) {
      focus.current = coin;
      const lines = briefing(levelRef.current ?? 'some');
      script(lines.map((x, i) => (i === 0 ? { ...x, offline: true } : x)));
      return true;
    }
    const qt = quotesRef.current.find((x) => x.asset === coin);
    if (qt?.pool === undefined) return false;
    const g = qt.gap === undefined ? '' : qt.gap >= 0 ? t.gapPricey((qt.gap * 100).toFixed(1)) : t.gapCheap((-qt.gap * 100).toFixed(1));
    const gap = g ? ` ${g[0].toUpperCase()}${g.slice(1)}.` : '';
    say({ text: `${t.poolNow(coin, fmtPrice(qt.pool))}${gap}`, follow: [], offline: true }, 300);
    return true;
  };

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
    if (VAULT_WORDS.test(q) && vault?.configured) {
      const usd = (s?: string) => Number(s ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const held = (vault.holdings ?? []).map((h) => {
        const cost = Number(h.costUsdt ?? 0), value = Number(h.valueUsdt ?? 0);
        const gain = cost > 0 ? `${value >= cost ? '+' : '−'}${Math.abs((value / cost - 1) * 100).toFixed(1)}%` : '';
        return `- ${t.vaHold(h.symbol, Number(h.amount).toPrecision(4).replace(/\.?0+$/, ''), usd(h.valueUsdt), usd(h.costUsdt), gain)}${h.stopDue ? ` ${t.vaStopDue}` : ''}`;
      });
      const rules = `${limitsText(t, vault)}${vault.remainingTodayUsdt !== undefined ? ` (${t.vcSide(usd(vault.remainingTodayUsdt))})` : ''}${vault.stopLossBps ? ` · ${t.lmStopShort(String(vault.stopLossBps / 100))}` : ''}`;
      say({ text: [t.vaCash(usd(vault.usdtBalance)), ...(held.length ? held : [t.vaNoCoins]), t.vaRules(rules), vault.paused ? t.lmLocked : ''].filter(Boolean).join('\n'), follow: [] }, 400);
      if (STATUS_WORDS.test(q)) list.slice(0, 3).forEach((h, i) => setTimeout(() => statusNote(h.id), 400 + i * 250));
      return true;
    }
    const gapOnly = () => {
      const rows = quotes.filter((x) => x.pool !== undefined && x.exchange !== undefined && x.gap !== undefined);
      if (rows.length) {
        const lines = rows.map((x) => `- ${t.spRow(x.asset, fmtPrice(x.exchange!), fmtPrice(x.pool!), `${x.gap! >= 0 ? '+' : '−'}${Math.abs(x.gap! * 100).toFixed(2)}%`)}`);
        say({ text: [t.spHead, ...lines, t.spCost, t.spVerdict].join('\n'), follow: [] }, 400);
      } else say({ text: spreadBrief([], lang), follow: [] }, 200);
    };
    if (SPREAD_WORDS.test(q)) {
      // The spread model (src/spread.ts): the gap against HashKey Global, and what is left after fees and the pool's
      // price impact at $10/$100/$1,000. If the live read fails, the plain gap from the price strip below.
      void Promise.all(ASSETS.map((a) => spreadRead(a).catch(() => null))).then((xs) => {
        const got = xs.filter((x) => x !== null);
        if (got.length) say({ text: spreadBrief(got, lang), follow: [] }, 200);
        else gapOnly();
      });
      return true;
    }
    if (STATUS_WORDS.test(q) && list.length) {
      say({ text: pnlLine(), follow: [] }, 300);
      list.slice(0, 3).forEach((h, i) => setTimeout(() => statusNote(h.id), 500 + i * 250));
      return true;
    }
    if (BUILD_WORDS.test(q)) {
      // The rule is read by a fixed reader (spec.ts), not by the model; the builder shows what was understood.
      const got = parse(q).buy.length > 0;
      say({ text: got ? t.buildSay : t.buildSayEmpty, follow: [] }, 400);
      onBuild(got ? q : '');
      return true;
    }
    if (RECOMMEND_WORDS.test(q)) { recommendNote(coinIn(q) ?? ctxRef.current.asset); return true; }
    if (STATUS_WORDS.test(q) && !list.length) { say({ text: t.noHired, follow: [], choices: [{ label: t.chPickOne, act: () => recommendNote(ctxRef.current.asset) }] }, 400); return true; }
    return false;
  };

  /** Ask Moa right here: the question, live progress steps, then the answer (or the on-device fallback). */
  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    interrupt();
    setDraft('');
    if (PRO_WORDS.test(q) && levelRef.current !== 'pro') setLevel('pro');
    const history = [
      // What the user is looking at goes in as context, so "this" and "here" mean something.
      { role: 'moa' as const, text: `${t.ctxNow}: ${context.label}` },
      ...(lpRef.current ? [{ role: 'moa' as const, text: `[liquidity studio open — plan: ${JSON.stringify({ coin: lpRef.current.asset, usdt: lpRef.current.usdt, coinAmount: lpRef.current.coin, shape: lpRef.current.shape, reachPctUnderPrice: +reachOf(lpRef.current).toFixed(1) })}]` }] : []),
      ...notesRef.current.filter((n) => n.text || n.agent || n.list).map((n) => ({ role: n.role, text: n.agent ? `${n.text} [${agentName(t, n.agent.a)}]` : n.list ? `${n.text} ${n.list.agents.map((a) => agentName(t, a)).join(', ')}` : n.text })),
      { role: 'you' as const, text: q },
    ];
    push({ role: 'you', text: q, follow: [] });
    // In the liquidity studio, amounts, shapes and widths are read here; anything else goes to the AI with the plan.
    if (lpRef.current) { const ch = parseLp(q); if (ch) { const next = lpSet(lpFill(ch)); if (next) say({ text: t.lpChanged(lpSummary(next)), follow: [] }, 300); return; } }
    if (!EXECUTE_WORDS.test(q) && local(q)) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(['thinking']);
    try {
      const res = await askMoa(history, (s) => setBusy((b) => (b && b[b.length - 1] !== s ? [...b, s] : b)), ctrl.signal, { level: levelRef.current, asset: ctxRef.current.asset });
      const plan = res.plan?.steps.length ? { steps: res.plan.steps.map(toStep), missing: res.plan.missing } : undefined;
      if (res.lp && lpRef.current) lpSet(lpFill({ ...(res.lp.usdt !== undefined ? { usdt: res.lp.usdt } : {}), ...(res.lp.coin !== undefined ? { coin: res.lp.coin } : {}), ...(res.lp.shape ? { shape: res.lp.shape } : {}), ...(res.lp.reachPct ? { ...widthFor(res.lp.reachPct), reachPct: res.lp.reachPct } : {}) }));
      if (res.executions?.length) onExecuted(res.executions.map((x) => ({ at: Date.now(), ok: x.ok, asset: x.request.asset, side: x.request.side, amount: x.request.amount, reason: x.reason, txHash: x.txHash, explorerUrl: x.explorerUrl, amountIn: x.amountIn, amountOut: x.amountOut, tokenIn: x.tokenIn, tokenOut: x.tokenOut })));
      push({ role: 'moa', text: res.reply, plan, goal: q, execs: res.executions?.length ? res.executions : undefined, proposals: res.proposals?.length ? res.proposals : undefined, follow: [] });
      if (res.recommend) {
        // The server ran the same rule; show its pick from this screen's data, or pick again if it is missing here.
        const a = agentsRef.current?.find((x) => x.id === res.recommend!.agentId);
        if (a) { const r = recommend(agentsRef.current!, { coin: a.base, level: levelRef.current }); agentNote(a, '', { pool: r?.pool ?? 1 }); }
        else recommendNote(res.recommend.coin === 'any' ? undefined : res.recommend.coin);
      }
    } catch {
      if (ctrl.signal.aborted) { setBusy(null); return; }
      // No server or the AI is unreachable: answer with the on-device parser, clearly marked. A question about a
      // coin is answered from the market data the briefing uses rather than with a request for a goal.
      const p = parseIntent(q);
      if (!p.steps.length && marketOffline(q)) { setBusy(null); lastNoteAt.current = Date.now(); return; }
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

  // The liquidity studio: amount, then shape, then how wide, each a tap or a sentence. Every answer changes the plan
  // in the middle of the screen at once; the user presses Supply there.
  const lpRef = useRef(lp); lpRef.current = lp;
  const lpSet = (ch: Partial<LpPlan>): LpPlan | null => {
    const cur = lpRef.current;
    if (!cur || !onLp) return null;
    const next = { ...cur, ...ch, weights: ch.shape && ch.shape !== 'custom' ? undefined : cur.weights };
    lpRef.current = next;
    onLp(next);
    return next;
  };
  /** A change said in words also answers the studio's questions: an amount picks what to do if nothing was picked, a width is the third answer. */
  const lpFill = (ch: Partial<LpPlan>): Partial<LpPlan> => {
    const cur = lpRef.current, out = { ...ch };
    if (cur && !cur.goal && !out.goal) out.goal = (out.coin ?? 0) > 0 && !((out.usdt ?? 0) > 0) ? 'sell' : (out.coin ?? 0) > 0 ? 'both' : 'buy';
    if (out.step && out.perSide && out.reachPct === undefined) out.reachPct = reachOf({ step: out.step, perSide: out.perSide });
    return out;
  };
  const lpSummary = (p: LpPlan) => t.lpSum(String(p.usdt), t.lpShapes[p.shape], `${reachOf(p).toFixed(1)}%`, String(p.coin), POOLS[p.asset].symbol);
  // Opening it: a short hello. The studio asks its three questions itself and sends Moa a note on each choice.
  const lpStart = () => { if (lpRef.current) say({ text: t.lpsHello, follow: [] }, 300); };

  // Something on another part of the screen handed Moa a job.
  useEffect(() => {
    if (!inject) return;
    if (inject.kind === 'ask') { void ask(inject.text); onAttention(); return; }
    interrupt();
    if (inject.kind === 'lp') lpStart();
    else if (inject.kind === 'note') say({ text: inject.text, follow: [] }, 300);
    else if (inject.kind === 'agent') agentNote(inject.agent, explainAgent(t, inject.agent));
    else if (inject.kind === 'recommend') recommendNote(inject.coin);
    else if (inject.kind === 'status') statusNote(inject.hiredId);
    else {
      const h = hiredRef.current.find((x) => x.id === inject.hiredId);
      if (h) {
        const c = inject.changed;
        // A new hire is an event: its own card, no sentence before it. A change of amounts stays a sentence and the status card.
        if (c) statusNote(h.id, t.changedSay(hiredName(t, h), `$${money(c.from.perBuyUsd)} · $${money(c.from.budgetUsd)}`, `$${money(c.to.perBuyUsd)} · $${money(c.to.budgetUsd)}`));
        else say({ text: '', hired: h.id, follow: [] }, 300);
      }
    }
    // the liquidity screen shows its own result, so on a phone Moa's notes about it wait behind the Moa tab instead of covering it
    if (inject.kind !== 'lp' && inject.kind !== 'note') onAttention();
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
  const colors = agentColors(hired);
  const colorOf = (id: string) => colors.get(id) ?? OTHER_COLOR;
  const priceOf = (h: HiredAgent) => quotes.find((q) => q.asset === h.asset)?.pool;

  return (
    <aside className="dock feed-dock" aria-label="Moa">
      <header className="feed-head">
        <span className="feed-title"><span className={`moa-avatar${busy ? ' busy' : ''}`} aria-hidden><Spark size={13} /></span>Moa<span className="ai-badge" data-tip={level ? t.live : t.feedWatching}><span className="live-dot" /><span className="ai-long">{t.aiBadge}</span><span className="ai-short">{t.aiShort}</span></span></span>
        {level && (
          <div className="depth-switch has-pill" role="tablist" aria-label={t.depthLabel}>
            <SlidePill dep={level} />
            {(['new', 'some', 'pro'] as Level[]).map((l) => <button key={l} role="tab" aria-selected={level === l} className={level === l ? 'on' : ''} onClick={() => { if (l !== level && !busy) { interrupt(); setLevel(l); script([{ text: t.depthNow[l], follow: [] }, ...briefing(l)]); } }}>{t.depth[l]}</button>)}
          </div>
        )}
        {notes.length > 0 && !busy && <button className="feed-clear" onClick={() => setNotes([])} data-tip={t.feedClearTip} aria-label={t.feedClearTip}><SIcon name="trash" size={18} /></button>}
        {onClose && <button className="feed-close" onClick={onClose} aria-label={t.closeMoa}><SIcon name="close" size={18} /></button>}
      </header>

      <div className="feed" ref={feed} aria-live="polite">
        {notes.map((n, k) => n.role === 'you' ? (
          <div key={n.id} className="you-block fade-up">{n.text}</div>
        ) : (
          <article key={n.id} className={`note fade-up${n.sky ? ' brief' : ''}`}>
            {/* Messenger grouping: name and time only on the first of consecutive Moa lines. */}
            {(k === 0 || notes[k - 1].role !== 'moa' || n.at - notes[k - 1].at > 60_000) && <div className="note-meta"><span className="moa-avatar sm" aria-hidden><Spark size={9} /></span>Moa<time>{time(n.at, lang)}</time></div>}
            {n.text && <div className="note-text">{/\n/.test(n.text) ? <RichText text={n.text} /> : <Stream text={n.text} />}</div>}
            {n.offline && <p className="note-offline">{t.offline}</p>}
            {n.sky && <SkyCard level={n.sky.level} list={n.sky.list} />}
            {n.agent && (
              <AgentCard agent={n.agent.a} size="chat" actions={(
                // Evidence first: the main button opens the backtest on the trade screen. Hiring stays one tap away.
                <div className="acard-cta">
                  <button className="btn-primary" onClick={() => onShow(n.agent!.a)}>{t.acBacktest}</button>
                  {n.agent.a.runnable && <button className="btn" onClick={() => onHire({ kind: 'agent', agent: n.agent!.a })}>{t.acHire}</button>}
                </div>
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
              <StatusCard h={byId(n.status)!} color={colorOf(n.status)} price={priceOf(byId(n.status)!)} now={now} onEdit={() => onEdit(n.status!)}
                onPause={() => onPause(n.status!)} onResume={() => onResume(n.status!)} onLog={() => onGoto('mine')} />
            )}
            {n.hired && byId(n.hired) && (
              <HireCard h={byId(n.hired)!} color={colorOf(n.hired)} now={now} onView={() => onGoto('mine')}
                onPause={() => onPause(n.hired!)} onResume={() => onResume(n.hired!)} />
            )}
            {n.order && byId(n.order.hiredId) && (
              <OrderCard h={byId(n.order.hiredId)!} orderId={n.order.orderId} sending={sending.has(n.order.orderId)} vault={vault}
                onApprove={() => onApprove(n.order!.hiredId, n.order!.orderId)} onDecline={() => onDecline(n.order!.hiredId, n.order!.orderId)} />
            )}
            {n.choices && (
              <div className={`choices${n.chosen ? ' done' : ''}`}>
                {n.choices.map((c) => (
                  <button key={c.label} className={`choice${c.primary ? ' primary' : ''}${n.chosen === c.label ? ' picked' : ''}`} disabled={!!n.chosen || !!busy} onClick={() => choose(n.id, c)}>{c.primary && <Spark size={13} />}{c.label}</button>
                ))}
              </div>
            )}
            {n.execs?.map((x, k) => <Receipt key={k} x={x} />)}
            {n.proposals?.map((p) => <ProposalCard key={p.token} p={p} vault={vault} onDone={(x) => onExecuted([{ at: Date.now(), ok: x.ok, asset: x.request.asset, side: x.request.side, amount: x.request.amount, reason: x.reason, txHash: x.txHash, explorerUrl: x.explorerUrl, amountIn: x.amountIn, amountOut: x.amountOut, tokenIn: x.tokenIn, tokenOut: x.tokenOut }])} />)}
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
            <div className="note-meta"><span className="moa-avatar sm busy" aria-hidden><Spark size={9} /></span>Moa</div>
            {busy
              ? (
                <div className="thoughts">
                  <div className="thoughts-head"><span className="spark" aria-hidden /><span className="shimmer-text">{t.steps[busy[busy.length - 1]]}</span></div>
                  {busy.length > 1 && <ol className="thoughts-steps">{busy.slice(0, -1).map((s) => <li key={s}>✓ {t.steps[s]}</li>)}</ol>}
                </div>
              )
              : <span className="dots" aria-label={t.feedTyping}><i /><i /><i /></span>}
          </div>
        )}
      </div>

      <div className="moa-glow" aria-hidden />
      <form className={`feed-composer${busy ? ' running' : ''}`} onSubmit={(e) => { e.preventDefault(); void ask(draft); }}>
        <textarea ref={input} rows={1} value={draft} onChange={(e) => { if (!draft) interrupt(); setDraft(e.target.value); }} placeholder={t.feedPlaceholder} aria-label={t.askMoa}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(draft); } }} />
        <div className="composer-bar">
          <span className="ctx-chip" data-tip={t.ctxTip}>{context.asset ? <CoinMark base={context.asset} /> : <span className="orb xs" aria-hidden />}{context.label}</span>
          {busy
            ? <button className="sq-btn" type="button" onClick={stop} aria-label={t.stop} data-tip={`${t.stop} (Esc)`}><SIcon name="stop" size={16} /></button>
            : <button className="sq-btn" type="submit" disabled={!draft.trim()} aria-label={t.ask} data-tip={`${t.ask} (Enter)`}><SIcon name="arrowUp" size={16} /></button>}
        </div>
      </form>
      <div className="feed-foot"><VaultLine vault={vault} /></div>

    </aside>
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
  const usd = o.usd ?? 0;
  const on = !!vault?.configured;
  return (
    <div className={`order-card${open ? ' open' : ''}`}>
      <header className="oc-head">
        {h.source.type === 'market' ? <Face rule={h.source.rule} base={h.source.base} size="sm" /> : <span className="face sm" aria-hidden><SIcon name="bot" size={14} /></span>}
        <b>{name}</b>
        {open && <span className="oc-tag"><i />{t.ocAsk}</span>}
      </header>
      <p className="order-q">{o.side === 'buy' ? t.ocBuy(money(usd), h.asset) : t.ocSell(qtyText(o.qty ?? 0), h.asset)}</p>
      <p className="order-why"><span>{t.ocWhy}</span>{whyText(t, o.why)}</p>
      {o.journal && <JournalBox j={o.journal} link={outcome?.k === 'filled' ? outcome.fill.explorerUrl : undefined} />}
      {open && (on ? (
        // What the contract will check, shown before the user says yes.
        <ul className="oc-checks">
          {o.side === 'buy' && vault!.maxTradeUsdt !== undefined && <li><SIcon name="check" size={14} />{t.ocCap(money(usd), vault!.maxTradeUsdt)}</li>}
          {vault!.remainingTodayUsdt !== undefined && <li><SIcon name="check" size={14} />{t.ocLeft(vault!.remainingTodayUsdt)}</li>}
          {vault!.maxTradeUsdt === undefined && vault!.remainingTodayUsdt === undefined && <li><SIcon name="check" size={14} />{t.ocNoLimit}</li>}
        </ul>
      ) : <p className="order-demo">{t.obDemo}</p>)}
      {open && (
        <div className="order-cta">
          <button className="btn-primary" onClick={onApprove} disabled={sending}>{sending ? t.obSending : o.side === 'buy' ? t.obBuy(money(usd)) : t.obSell}</button>
          <button className="btn-ghost" onClick={onDecline} disabled={sending}>{t.obSkip}</button>
        </div>
      )}
      {outcome?.k === 'filled' && (
        <div className="receipt-mini ok">
          <span className="rc-ic" aria-hidden><SIcon name="check" size={14} /></span>
          <b>{t.receiptOk}</b>
          <span>{outcome.fill.side === 'buy' ? t.filledBuy(money(outcome.fill.usd), qtyText(outcome.fill.qty), h.asset) : t.filledSell(qtyText(outcome.fill.qty), h.asset, money(outcome.fill.usd))}</span>
          {outcome.fill.explorerUrl && <a href={outcome.fill.explorerUrl} target="_blank" rel="noreferrer">{t.viewTx} ↗</a>}
        </div>
      )}
      {outcome?.k === 'failed' && (outcome.demo ? <p className="order-demo">{t.obDemoDone}</p> : <div className="receipt-mini fail"><span className="rc-ic" aria-hidden><SIcon name="close" size={14} /></span><b>{t.receiptFail}</b><span>{t.obFailed(outcome.reason)}</span></div>)}
      {outcome?.k === 'declined' && <p className="muted small-text">{t.obDeclined}</p>}
      {outcome?.k === 'expired' && <p className="muted small-text">{t.obExpired}</p>}
    </div>
  );
}

/**
 * A trade Moa proposed: nothing is sent until the user presses Confirm here. The button sends the server's one-time
 * ticket for exactly this order and wallet; it works once and for five minutes.
 */
function ProposalCard({ p, vault, onDone }: { p: Proposal; vault: VaultInfo | null; onDone: (x: Exec) => void }) {
  const { t } = useT();
  const [state, setState] = useState<'open' | 'sending' | 'no' | Exec>('open');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (state !== 'open') return; const x = setInterval(() => setNow(Date.now()), 5_000); return () => clearInterval(x); }, [state]);
  if (typeof state === 'object') return <Receipt x={state} />;
  const expired = now > p.expiresAt;
  const what = p.side === 'buy' ? t.propBuy(money(p.amount), p.asset) : t.propSell(qtyText(p.amount), p.asset);
  const go = async () => { setState('sending'); const x = await confirmProposal(p); setState(x); onDone(x); };
  return (
    <div className={`proposal${state === 'no' || expired ? ' off' : ''}`} role="group" aria-label={t.confirmTitle}>
      <b>{t.confirmTitle}</b>
      <p className="proposal-what">{what}</p>
      {p.note && <p className="proposal-why">{p.note}</p>}
      <p className="muted small">{t.confirmBody(vault?.configured ? limitsText(t, vault) : t.limNone)}</p>
      {state === 'no' ? <p className="muted small">{t.propCancelled}</p> : expired ? <p className="muted small">{t.propExpired}</p> : (
        <div className="proposal-act">
          <button className="btn-text" disabled={state === 'sending'} onClick={() => setState('no')}>{t.cancel}</button>
          <button className="btn-primary" disabled={state === 'sending'} onClick={() => void go()}>{state === 'sending' ? <span className="spin" aria-hidden /> : null}{t.executeBtn}</button>
        </div>
      )}
    </div>
  );
}

/** A trade run from the chat: what happened, and the transaction on the HSK explorer. */
function Receipt({ x }: { x: Exec }) {
  const { t } = useT();
  return (
    <div className={`receipt-mini ${x.ok ? 'ok' : 'fail'}`}>
      <span className="rc-ic" aria-hidden><SIcon name={x.ok ? 'check' : 'close'} size={14} /></span>
      <b>{x.ok ? t.receiptOk : t.receiptFail}</b>
      <span>{x.request.side === 'buy' ? t.buy : t.sell} {x.request.asset} · ${x.request.amount}{x.reason ? ` · ${x.reason}` : ''}</span>
      {x.txHash && <code className="rc-tx">{x.txHash.slice(0, 8)}…{x.txHash.slice(-6)}</code>}
      {x.explorerUrl && <a href={x.explorerUrl} target="_blank" rel="noreferrer">{t.viewTx} ↗</a>}
    </div>
  );
}

/** The briefing table: one column per coin, one row per reading, as deep as the user's level. Rows without a value are left out. */
function SkyCard({ level, list }: { level: Level; list: Weather[] }) {
  const { t } = useT();
  const pct = (v: number | undefined, d = 1) => (v === undefined ? undefined : `${v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%`);
  const sign = (v: number | undefined) => (v === undefined ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  type Row = { k: string; cells: { text?: string; cls?: string; icon?: Weather['sky']; pill?: Weather['sky'] }[] };
  const rows: Row[] = [
    { k: level === 'pro' ? t.rowSignal : t.rowSky, cells: list.map((w) => ({ text: level === 'pro' ? t.skyPro[w.sky] : level === 'new' ? t.sky[w.sky][2] : t.sky[w.sky][1], icon: level === 'pro' ? undefined : w.sky, pill: w.sky })) },
    { k: t.rowM1, cells: list.map((w) => ({ text: pct(w.m1), cls: sign(w.m1) })) },
    ...(level !== 'new' ? [{ k: level === 'pro' ? t.rowGapPro : t.rowGap, cells: list.map((w) => ({ text: pct(w.gap, 2) })) }] : []),
    ...(level === 'pro' ? [
      { k: t.rowMa, cells: list.map((w) => ({ text: pct(w.vsMa), cls: sign(w.vsMa) })) },
      { k: t.rowRsi, cells: list.map((w) => ({ text: w.rsi.toFixed(0) })) },
      { k: t.rowVol, cells: list.map((w) => ({ text: `×${w.volRatio.toFixed(2)}` })) },
      { k: t.rowBasis, cells: list.map((w) => ({ text: pct(w.basis, 3) })) },
    ] : []),
  ].filter((r) => r.cells.some((c) => c.text !== undefined));
  return (
    <table className="sky-table">
      <thead>
        <tr><th />{list.map((w) => <th key={w.base}><span className="sky-coin"><CoinMark base={w.base} />{level === 'pro' ? w.base : w.base === 'BTC' ? t.coinBtc : t.coinEth}</span></th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.k}>
            <th scope="row">{r.k}</th>
            {r.cells.map((c, i) => (
              <td key={i} className={c.text === undefined ? 'none' : c.cls}>
                {c.pill ? <span className={`sig-pill sky-${c.pill}`}>{c.icon && <SIcon name={c.icon} size={15} />}{c.text}</span> : c.text ?? t.scNone}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Moa's words arrive a few at a time, like a reply being written. */
function Stream({ text }: { text: string }) {
  let k = 0;
  const words = (part: string, key: string) => part.split(/(\s+)/).map((w, i) => (/^\s+$/.test(w) || !w ? w
    : <span key={`${key}-${i}`} style={{ animationDelay: `${Math.min(1.2, (k++) * 0.022).toFixed(3)}s` }}>{w}</span>));
  return (
    <p className="stream">
      {text.split(/(\*\*[^*]+\*\*)/).map((part, i) => (part.startsWith('**') && part.endsWith('**') && part.length > 4
        ? <strong key={i}>{words(part.slice(2, -2), `b${i}`)}</strong> : words(part, `t${i}`)))}
    </p>
  );
}
