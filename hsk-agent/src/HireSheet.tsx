// The one place where money settings change. Hiring from the market, from Moa's card, from a plan in the
// conversation, or changing the amount later: all of them open this sheet and nothing changes until the
// user presses the button. Amounts are the user's to choose: any number can be typed. If the user has set a
// per-trade limit on their own vault, the sheet says so when an amount goes above it.
// An agent someone else made shows who made it and their fee. On a vault that can pay creator fees (version 3)
// the owner approves that fee here, one confirmation in the wallet; an older vault pays nothing and says so.
import { useEffect, useMemo, useState } from 'react';
import { isWeightRule, rescoreAt, type Agent } from './agents.ts';
import { pct } from './AgentCard.tsx';
import { describe, scheduleOf, type Plan } from './intent.ts';
import { useT } from './i18n.ts';
import { limitsText, vaultWhy, type VaultInfo } from './parts.tsx';
import { Modal } from './ui.tsx';
import { agentName, Face, ruleLines } from './AgentCard.tsx';
import { feeOn, feeText } from './share.ts';
import { approvedFee, setChainBudget, setCreatorFee } from './shareClient.ts';
import { newId } from './runner.ts';
import { whoText } from './Shared.tsx';
import { Icon } from './Icons.tsx';
import { book, type Amounts, type HireChoice, type HiredAgent, type Mode } from './runner.ts';
import { hiredName, money } from './hiredText.ts';
import { setLimits, setSession, setStopLoss, type SendResult } from './account.ts';

const AMOUNT = /^\d+(\.\d{1,6})?$/;

export type HireTarget =
  | { kind: 'agent'; agent: Agent }
  | { kind: 'custom'; goal: string; plan: Plan }
  | { kind: 'edit'; hired: HiredAgent };

// Steps for the − and + buttons. They are only a convenience: the field takes any amount.
const PER = [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 2000, 5000];
const BUDGET = [10, 20, 30, 50, 100, 150, 200, 300, 500, 1000, 2000, 5000, 10000, 50000];

/** A dollar amount: type any number, or step through the usual ones. */
function Stepper({ id, value, options, onChange, label }: { id: string; value: number; options: number[]; onChange: (v: number) => void; label: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText((cur) => (Number(cur) === value ? cur : String(value))); }, [value]);
  const lower = [...options].reverse().find((o) => o < value), higher = options.find((o) => o > value);
  const typed = (raw: string) => {
    const v = raw.replace(/[^\d.]/g, '');
    setText(v);
    const n = Number(v);
    if (v && Number.isFinite(n) && n > 0) onChange(Math.round(n * 100) / 100);
  };
  return (
    <span className="stepper" role="group" aria-label={label}>
      <button type="button" disabled={lower === undefined} onClick={() => onChange(lower!)} aria-label={`${label} −`}>−</button>
      <span className="stepper-in"><i aria-hidden>$</i><input id={id} inputMode="decimal" autoComplete="off" value={text} onChange={(e) => typed(e.target.value)} onBlur={() => setText(String(value))} aria-label={label} /></span>
      <button type="button" disabled={higher === undefined} onClick={() => onChange(higher!)} aria-label={`${label} +`}>+</button>
    </span>
  );
}

/** Collect agents that may double a day's buy need room for twice the amount in the session's per-buy cap. */
const doublesFor = (target: HireTarget) => {
  const rule = target.kind === 'agent' ? target.agent.rule : target.kind === 'edit' && target.hired.source.type === 'market' ? target.hired.source.rule : undefined;
  return rule === 'smart' || rule === 'rsiDca';
};

export default function HireSheet({ target, vault, onClose, onConfirm, onReloadVault }: {
  target: HireTarget; vault: VaultInfo | null; onClose: () => void; onConfirm: (v: HireChoice) => void; onReloadVault: () => void;
}) {
  const { t, lang } = useT();
  // The user's own per-trade limit on their vault, if they set one. Nothing caps the amount otherwise.
  const maxTrade = vault?.configured && vault.maxTradeUsdt !== undefined ? Number(vault.maxTradeUsdt) : Infinity;
  const start = useMemo<Amounts>(() => {
    if (target.kind === 'edit') return { perBuyUsd: target.hired.perBuyUsd, budgetUsd: target.hired.budgetUsd };
    if (target.kind === 'custom') {
      const acc = target.plan.steps.find((s) => s.kind === 'accumulate');
      const per = Math.min(maxTrade, acc?.kind === 'accumulate' ? acc.perBuyUsd ?? 10 : 10);
      const budget = acc?.kind === 'accumulate' ? scheduleOf(acc).totalUsd ?? acc.budgetUsd ?? per * 10 : per * 10;
      return { perBuyUsd: per, budgetUsd: Math.max(per, budget) };
    }
    return { perBuyUsd: Math.min(10, maxTrade), budgetUsd: 100 };
  }, [target, maxTrade]);
  const [per, setPer] = useState(start.perBuyUsd);
  const [budget, setBudget] = useState(start.budgetUsd);

  const setPerKeep = (v: number) => { setPer(v); if (budget < v) setBudget(BUDGET.find((b) => b >= v) ?? v); };
  const startMode: Mode = target.kind === 'edit' ? target.hired.mode : 'ask';
  const [mode, setMode] = useState<Mode>(startMode);
  const real = !!vault?.configured;

  // The safety settings live on the vault, not on the agent: a daily limit on what agents may spend, and a
  // stop-loss. For an agent that works on its own both are recommended and filled in, and the owner decides.
  // What is already set on the vault is shown as it is.
  const [dayOn, setDayOn] = useState(true);
  const [dayText, setDayText] = useState<string | null>(vault?.maxDailyUsdt ?? null);   // null: follow the suggestion
  const day = dayText ?? String(Math.max(per * 3, per));
  const [stopOn, setStopOn] = useState(true);
  const [stop, setStop] = useState(String((vault?.stopLossBps || 1000) / 100));
  const dayOk = !dayOn || (AMOUNT.test(day) && Number(day) > 0);
  const stopBps = stopOn ? Math.round(Number(stop) * 100) : 0;
  const stopOk = !stopOn || (/^\d+(\.\d{1,2})?$/.test(stop) && stopBps >= 100 && stopBps <= 9000);
  const auto = mode === 'auto';
  const wantDay = dayOn ? day : undefined;
  const saveLimits = auto && real && wantDay !== vault?.maxDailyUsdt;
  const saveStop = auto && real && stopBps !== (vault?.stopLossBps ?? 0);
  // The hired agent's id, known before hiring: on a version-3 vault its budget and its creator are set for this id.
  const [hiredId] = useState(() => (target.kind === 'edit' ? target.hired.id : newId()));
  // A shared agent's creator fee: what the owner already approved for this agent on this vault, read from the chain.
  const sh = target.kind === 'agent' ? target.agent.shared : target.kind === 'edit' ? target.hired.shared : undefined;
  const fee = sh?.feeBps ?? 0;
  const feeVault = real && (vault?.version ?? 0) >= 3 && fee > 0 && !!vault?.vault;
  const [approved, setApproved] = useState<number | null | 'fail'>(null);
  useEffect(() => {
    if (!feeVault || !sh) return;
    let alive = true;
    // A new hire has never been approved; only an agent already hired can have an approval to read.
    if (target.kind !== 'edit') { setApproved(0); return; }
    approvedFee(vault!.vault!, hiredId, sh.creator).then((v) => alive && setApproved(v), () => alive && setApproved('fail'));
    return () => { alive = false; };
  }, [feeVault, vault?.vault, sh?.creator]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveFee = feeVault && (approved === 'fail' || (typeof approved === 'number' && approved < fee));
  const feeLoading = feeVault && approved === null;
  // Per-agent budgets on the vault (version 3, when the owner turned them on): this agent may spend what is left of its budget.
  const spent = target.kind === 'edit' ? book(target.hired).spent : 0;
  const saveBudget = real && (vault?.version ?? 0) >= 3 && !!vault?.budgetsOn && (target.kind !== 'edit' || budget !== start.budgetUsd);
  // Version 3: Moa's agent key trades only inside the owner's session (until when, which coins, most per buy). When
  // the session is missing, ending within a week, on another key, without this coin or below this buy, hiring renews
  // it for 90 days: one more confirmation in the wallet.
  const coin = target.kind === 'agent' ? target.agent.base : target.kind === 'edit' ? target.hired.asset : ((target.plan.steps.find((x) => 'asset' in x) as { asset?: string } | undefined)?.asset ?? 'HSK');
  const ses = vault?.session;
  const sesPer = doublesFor(target) ? per * 2 : per;
  const sesMax = Math.max(sesPer, Number(ses?.maxTradeUsdt ?? 0), vault?.maxTradeUsdt !== undefined ? Number(vault.maxTradeUsdt) : 0);
  const saveSession = real && (vault?.version ?? 0) >= 3 && !!vault?.net?.agent && (!ses || !ses.ours || ses.until * 1000 < Date.now() + 7 * 86_400_000 || !ses.assets.includes(coin) || (ses.maxTradeUsdt !== undefined && Number(ses.maxTradeUsdt) < sesPer));
  const [sesUntil] = useState(() => Math.floor(Date.now() / 1000) + 90 * 86_400);
  const pfee = vault?.platformFeeBps ?? 0;
  const steps = Number(saveSession) + Number(saveLimits) + Number(saveStop) + Number(saveFee) + Number(saveBudget);
  const valid = per > 0 && budget >= per && (!auto || (real && dayOk && stopOk)) && !feeLoading;

  const name = target.kind === 'agent' ? agentName(t, target.agent) : target.kind === 'custom'
    ? t.customName((target.plan.steps.find((s) => 'asset' in s) as { asset?: string } | undefined)?.asset ?? 'HSK') : hiredName(t, target.hired);
  const rule = target.kind === 'agent' ? target.agent.rule : target.kind === 'edit' && target.hired.source.type === 'market' ? target.hired.source.rule : undefined;
  // A weight agent holds a share of its budget and rebalances: there is no per-buy amount, only the budget.
  const weighted = !!rule && isWeightRule(rule);
  // The agent's past results rescored at the budget chosen (price impact grows with size on a thin pool).
  const [atSize, setAtSize] = useState<{ usd: number; edge: number } | null>(null);
  useEffect(() => {
    if (target.kind !== 'agent' || target.agent.kind !== 'position') return;
    let alive = true;
    const usd = budget;
    const id = setTimeout(() => { void rescoreAt(target.agent, usd).then((x) => alive && x && setAtSize({ usd, edge: x.total - x.hold }), () => undefined); }, 300);
    return () => { alive = false; clearTimeout(id); };
  }, [budget, target]); // eslint-disable-line react-hooks/exhaustive-deps
  const base = target.kind === 'agent' ? target.agent.base : target.kind === 'edit' && target.hired.source.type === 'market' ? target.hired.source.base : undefined;
  const doubles = rule === 'smart' || rule === 'rsiDca';
  // How many buys the budget covers at this size: the plain version of "per buy" and "budget".
  const times = per > 0 ? Math.floor(budget / per + 1e-9) : 0;
  // The demo notice only once the vault has answered: while it loads nothing is known yet.
  const why = vaultWhy(vault);
  const plan = target.kind === 'custom' ? target.plan : target.kind === 'edit' && target.hired.source.type === 'custom' ? target.hired.source.plan : undefined;
  const noBuy = plan && !plan.steps.some((s) => s.kind === 'accumulate');
  const editing = target.kind === 'edit';
  const changed = per !== start.perBuyUsd || budget !== start.budgetUsd || mode !== startMode || steps > 0;

  const [busy, setBusy] = useState(0);   // which wallet confirmation is open (1, 2), 0 when none
  const [error, setError] = useState('');
  const words = (r: SendResult) => (r.ok ? '' : r.why === 'rejected' ? t.txRejected : r.why === 'reverted' ? t.txReverted : r.why === 'slow' ? t.txSlow : r.why === 'nowallet' ? t.acNoWallet : t.txFailed(r.detail ?? ''));
  /** Save what changed on the vault (each change is one confirmation in the wallet), then hand the agent over. */
  const go = async () => {
    setError('');
    if (steps && vault?.net && vault.vault) {
      let n = 0;
      if (saveSession && vault.net.agent) {
        setBusy(++n);
        const r = await setSession(vault.net, vault.vault, vault.net.agent, sesUntil, sesMax, vault.net.tokens.map((x) => x.address));
        if (!r.ok) { setBusy(0); setError(words(r)); onReloadVault(); return; }
      }
      if (saveLimits) {
        setBusy(++n);
        // A per-trade limit above the new daily one cannot stand; without one, a trade may use the whole day.
        const perTrade = vault.maxTradeUsdt !== undefined && (wantDay === undefined || Number(vault.maxTradeUsdt) <= Number(wantDay)) ? vault.maxTradeUsdt : null;
        const r = await setLimits(vault.net, vault.vault, perTrade, wantDay ?? null, vault.maxSlippageBps ?? 150);
        if (!r.ok) { setBusy(0); setError(words(r)); onReloadVault(); return; }
      }
      if (saveStop) {
        setBusy(++n);
        const r = await setStopLoss(vault.net, vault.vault, stopBps);
        if (!r.ok) { setBusy(0); setError(words(r)); onReloadVault(); return; }
      }
      if (saveFee && sh) {
        setBusy(++n);
        const r = await setCreatorFee(vault.net, vault.vault, hiredId, sh.creator, fee);
        if (!r.ok) { setBusy(0); setError(words(r)); onReloadVault(); return; }
      }
      if (saveBudget) {
        setBusy(++n);
        const r = await setChainBudget(vault.net, vault.vault, hiredId, budget - spent);
        if (!r.ok) { setBusy(0); setError(words(r)); onReloadVault(); return; }
      }
      setBusy(0);
      onReloadVault();
    }
    onConfirm({ perBuyUsd: weighted ? budget : per, budgetUsd: budget, mode, id: hiredId });
  };

  return (
    <Modal title={editing ? t.hsEditTitle(name) : t.hsTitle(name)} onClose={onClose} actions={<>
      <button className="btn-text" onClick={onClose} disabled={busy > 0}>{t.cancel}</button>
      <button className={editing ? 'btn-primary' : 'btn-primary hire'} disabled={!valid || busy > 0 || (editing && !changed)} onClick={() => void go()}>
        {busy ? t.hsStep(busy, steps) : editing ? t.hsSave : steps ? t.hsHireSave : t.hsHire}
      </button>
    </>}>
      <div className="hire">
        {rule && (
          <div className="hire-who">
            <Face rule={rule} base={base} size="lg" />
            <p>{target.kind === 'agent' && target.agent.made ? ruleLines(t, target.agent)[0] : t.agPlain[rule]}</p>
          </div>
        )}
        {sh && (
          <section className="hire-maker" aria-label={t.shWho}>
            <div className="hire-maker-top">
              <span className="hire-maker-ic" aria-hidden><Icon name="user" size={18} /></span>
              <span className="hire-maker-who"><small>{t.shWho}</small><b>{whoText(lang, sh)}</b></span>
            </div>
            <span className="sh-label"><Icon name="info" size={14} />{t.shLabel}</span>
            <p className="hire-maker-fee">
              <b>{fee ? t.shFee(feeText(fee)) : t.shFeeNone}</b>
              {fee > 0 && <span>{t.shFeeLine(feeText(fee))} · {t.shFeeExample(money(per), money(feeOn(per, fee)))}</span>}
            </p>
            {fee > 0 && (
              <p className={`hire-maker-st${real && !feeVault ? ' warn' : ''}`}>
                {!real ? t.shFeeDemo : !feeVault ? t.shFeeOld : feeLoading ? t.shFeeChecking : saveFee ? t.shFeeAsk(feeText(fee)) : t.shFeeHave(feeText(typeof approved === 'number' ? approved : fee))}
                {feeVault && <small>{t.shFeeLimit}</small>}
              </p>
            )}
          </section>
        )}
        <div className={weighted ? 'hire-one' : 'hire-two'}>
          {!weighted && <label className="field" htmlFor="hire-per">
            <span>{t.hsPer}</span>
            <Stepper id="hire-per" label={t.hsPer} value={per} options={PER} onChange={setPerKeep} />
          </label>}
          <label className="field" htmlFor="hire-budget">
            <span>{t.hsBudget}</span>
            <Stepper id="hire-budget" label={t.hsBudget} value={budget} options={BUDGET} onChange={setBudget} />
          </label>
        </div>
        {atSize && atSize.usd === budget && <p className="hire-sub">{t.hsAtSize(`$${money(budget)}`, t.vsHold(pct(atSize.edge)))}</p>}
        {weighted ? <p className="hire-times">{t.hsWeight}</p> : budget < per ? <p className="hire-sub warn">{t.hsBudgetLow}</p> : <p className="hire-times">{t.hsTimes(times)}</p>}
        {!weighted && !auto && per > maxTrade && <p className="hire-sub warn">{t.hsOverLimit(money(maxTrade))}</p>}
        {doubles && <p className="hire-sub">{t.hsDouble(money(Math.min(per * 2, maxTrade)))}</p>}
        {editing && <p className="hire-sub">{t.hsSpent(money(book(target.hired).spent))}</p>}

        <div className="field">
          <span>{t.hsMode}</span>
          <div className="hire-modes" role="radiogroup" aria-label={t.hsMode}>
            {(['ask', 'auto'] as Mode[]).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                <b>{m === 'ask' ? t.hsModeAsk : t.hsModeAuto}</b><small>{m === 'ask' ? t.hsModeAskSub : t.hsModeAutoSub}</small>
              </button>
            ))}
          </div>
          {auto && !real && why !== 'wait' && <p className="hire-sub warn">{t.hsAutoLogin}</p>}
        </div>

        {auto && real && (
          <section className="hire-safe">
            <header><b>{t.hsSafety}</b><small>{t.hsSafetySub}</small></header>
            <div className="hire-safe-row">
              <button type="button" role="switch" aria-checked={dayOn} className={`switch${dayOn ? ' on' : ''}`} onClick={() => setDayOn((v) => !v)} aria-label={t.hsDayLimit}><i /></button>
              <div className="hire-safe-text"><b>{t.hsDayLimit}</b><small>{t.hsDayHint}</small></div>
              {dayOn && <div className="fund-input sm"><input inputMode="decimal" value={day} onChange={(e) => setDayText(e.target.value.trim())} aria-label={t.hsDayLimit} aria-invalid={!dayOk} /><span>USDT</span></div>}
            </div>
            {dayOn && dayOk && Number(day) < per && <p className="hire-sub warn">{t.hsDayLow}</p>}
            <div className="hire-safe-row">
              <button type="button" role="switch" aria-checked={stopOn} className={`switch${stopOn ? ' on' : ''}`} onClick={() => setStopOn((v) => !v)} aria-label={t.hsStop}><i /></button>
              <div className="hire-safe-text"><b>{t.hsStop}</b><small>{t.hsStopHint}</small></div>
              {stopOn && <div className="fund-input sm"><input inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value.trim())} aria-label={t.hsStop} aria-invalid={!stopOk} /><span>%</span></div>}
            </div>
            {!dayOn && !stopOn && <p className="hire-sub warn">{t.hsNoSafety}</p>}
            {steps > 0 && <p className="hire-sub">{t.hsWallet(steps)}</p>}
          </section>
        )}
        {!auto && real && <p className="hire-sub">{t.hsVault}: {limitsText(t, vault!)}{vault!.stopLossBps ? ` · ${t.lmStopShort(String(vault!.stopLossBps / 100))}` : ''}</p>}

        {plan && (
          <div className="field">
            <span>{t.hsPlan}</span>
            <ol className="hire-plan">{plan.steps.map((s, i) => <li key={i}>{describe(s, lang)}</li>)}</ol>
            {noBuy && <p className="hire-sub">{t.hsNoBuy}</p>}
          </div>
        )}
        {error && <p className="hire-sub warn">{error}</p>}
        {real && (vault?.version ?? 0) >= 3 && (
          <p className="hire-sub">{saveSession ? t.hsSessionNew(new Date(sesUntil * 1000).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'en-US'), money(sesMax)) : ses ? t.hsSessionOk(new Date(ses.until * 1000).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'en-US')) : ''}</p>
        )}
        {pfee > 0 && <p className="hire-sub">{t.hsPlatformFee(feeText(pfee), money(feeOn(per, pfee)))}</p>}
        <ul className="hire-checks">{t.hsChecks.map((c) => <li key={c}><Icon name="check" size={16} />{c}</li>)}</ul>
        <p className="hire-trust"><a href="?trust" target="_blank" rel="noreferrer">{t.navTrust} ↗</a></p>
        {(why === 'login' || why === 'off') && <p className="hire-note demo">{why === 'login' ? t.hsLogin : t.hsDemo}</p>}
      </div>
    </Modal>
  );
}
