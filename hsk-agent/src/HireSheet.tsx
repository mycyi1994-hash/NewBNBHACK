// The one place where money settings change. Hiring from the market, from Moa's card, from a plan in the
// conversation, or changing the amount later: all of them open this sheet and nothing changes until the
// user presses the button. Amounts are the user's to choose: any number can be typed. If the user has set a
// per-trade limit on their own vault, the sheet says so when an amount goes above it.
import { useEffect, useMemo, useState } from 'react';
import type { Agent } from './agents.ts';
import { describe, scheduleOf, type Plan } from './intent.ts';
import { useT } from './i18n.ts';
import { limitsText, type VaultInfo } from './parts.tsx';
import { Modal } from './ui.tsx';
import { agentName } from './AgentCard.tsx';
import { book, type Amounts, type HiredAgent } from './runner.ts';
import { hiredName, money } from './hiredText.ts';

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

export default function HireSheet({ target, vault, onClose, onConfirm }: {
  target: HireTarget; vault: VaultInfo | null; onClose: () => void; onConfirm: (v: Amounts) => void;
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
  const valid = per > 0 && budget >= per;

  const name = target.kind === 'agent' ? agentName(t, target.agent) : target.kind === 'custom'
    ? t.customName((target.plan.steps.find((s) => 'asset' in s) as { asset?: string } | undefined)?.asset ?? 'HSK') : hiredName(t, target.hired);
  const rule = target.kind === 'agent' ? target.agent.rule : target.kind === 'edit' && target.hired.source.type === 'market' ? target.hired.source.rule : undefined;
  const doubles = rule === 'smart' || rule === 'rsiDca';
  const plan = target.kind === 'custom' ? target.plan : target.kind === 'edit' && target.hired.source.type === 'custom' ? target.hired.source.plan : undefined;
  const noBuy = plan && !plan.steps.some((s) => s.kind === 'accumulate');
  const editing = target.kind === 'edit';
  const changed = per !== start.perBuyUsd || budget !== start.budgetUsd;
  const diff = (a: number, b: number) => (editing && a !== b ? `$${money(a)} → ` : '');

  return (
    <Modal title={editing ? t.hsEditTitle(name) : t.hsTitle(name)} onClose={onClose} actions={<>
      <button className="btn-text" onClick={onClose}>{t.cancel}</button>
      <button className={editing ? 'btn-primary' : 'btn-primary hire'} disabled={!valid || (editing && !changed)} onClick={() => onConfirm({ perBuyUsd: per, budgetUsd: budget })}>{editing ? t.hsSave : t.hsHire}</button>
    </>}>
      <div className="hire">
        <label className="field" htmlFor="hire-per">
          <span>{t.hsPer}{diff(start.perBuyUsd, per) && <small>{diff(start.perBuyUsd, per)}${money(per)}</small>}</span>
          <Stepper id="hire-per" label={t.hsPer} value={per} options={PER} onChange={setPerKeep} />
        </label>
        {per > maxTrade && <p className="hire-sub warn">{t.hsOverLimit(money(maxTrade))}</p>}
        {doubles && <p className="hire-sub">{t.hsDouble(money(Math.min(per * 2, maxTrade)))}</p>}
        <label className="field" htmlFor="hire-budget">
          <span>{t.hsBudget}{diff(start.budgetUsd, budget) && <small>{diff(start.budgetUsd, budget)}${money(budget)}</small>}</span>
          <Stepper id="hire-budget" label={t.hsBudget} value={budget} options={BUDGET} onChange={setBudget} />
        </label>
        {editing && <p className="hire-sub">{t.hsSpent(money(book(target.hired).spent))}</p>}
        <div className="field"><span>{t.hsMode}</span><div className="field-ro">{t.hsModeAsk}</div></div>
        <div className="field"><span>{t.hsVault}</span><div className="field-ro">{vault?.configured ? limitsText(t, vault) : vault?.service ? t.hsVaultLogin : t.hsVaultOff}</div></div>
        {plan && (
          <div className="field">
            <span>{t.hsPlan}</span>
            <ol className="hire-plan">{plan.steps.map((s, i) => <li key={i}>{describe(s, lang)}</li>)}</ol>
            {noBuy && <p className="hire-sub">{t.hsNoBuy}</p>}
          </div>
        )}
        <p className="hire-note">{t.hsNote} {t.hsWithdraw}</p>
        {!vault?.configured && <p className="hire-note demo">{vault?.service ? t.hsLogin : t.hsDemo}</p>}
      </div>
    </Modal>
  );
}
