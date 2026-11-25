// The one place where money settings change. Hiring from the market, from Moa's card, from a plan in the
// conversation, or changing the amount later: all of them open this sheet and nothing changes until the
// user presses the button. The vault contract enforces its own per-trade and daily limits on top.
import { useMemo, useState } from 'react';
import type { Agent } from './agents.ts';
import { describe, scheduleOf, type Plan } from './intent.ts';
import { useT } from './i18n.ts';
import type { VaultInfo } from './parts.tsx';
import { Modal } from './ui.tsx';
import { agentName } from './AgentCard.tsx';
import { book, type Amounts, type HiredAgent } from './runner.ts';
import { hiredName, money } from './hiredText.ts';

export type HireTarget =
  | { kind: 'agent'; agent: Agent }
  | { kind: 'custom'; goal: string; plan: Plan }
  | { kind: 'edit'; hired: HiredAgent };

const PER = [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100];
const BUDGET = [10, 20, 30, 50, 100, 150, 200, 300, 500, 1000];
const withValue = (xs: number[], v: number) => (xs.includes(v) ? xs : [...xs, v].sort((a, b) => a - b));

function Stepper({ id, value, options, onChange, label }: { id: string; value: number; options: number[]; onChange: (v: number) => void; label: string }) {
  const i = options.indexOf(value);
  return (
    <span className="stepper" id={id} role="group" aria-label={label}>
      <button type="button" disabled={i <= 0} onClick={() => onChange(options[i - 1])} aria-label={`${label} −`}>−</button>
      <b aria-live="polite">${money(value)}</b>
      <button type="button" disabled={i >= options.length - 1} onClick={() => onChange(options[i + 1])} aria-label={`${label} +`}>+</button>
    </span>
  );
}

export default function HireSheet({ target, vault, onClose, onConfirm }: {
  target: HireTarget; vault: VaultInfo | null; onClose: () => void; onConfirm: (v: Amounts) => void;
}) {
  const { t, lang } = useT();
  const maxTrade = vault?.configured && vault.maxTradeUsdt ? Number(vault.maxTradeUsdt) : 25;
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

  const perOptions = withValue(PER.filter((v) => v <= maxTrade), start.perBuyUsd);
  const budgetOptions = withValue(BUDGET.filter((v) => v >= per), Math.max(per, start.budgetUsd));
  const setPerKeep = (v: number) => { setPer(v); if (budget < v) setBudget(budgetOptions.find((b) => b >= v) ?? v); };

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
      <button className="btn" disabled={editing && !changed} onClick={() => onConfirm({ perBuyUsd: per, budgetUsd: budget })}>{editing ? t.hsSave : t.hsHire}</button>
    </>}>
      <div className="hire">
        <label className="field" htmlFor="hire-per">
          <span>{t.hsPer}{diff(start.perBuyUsd, per) && <small>{diff(start.perBuyUsd, per)}${money(per)}</small>}</span>
          <Stepper id="hire-per" label={t.hsPer} value={per} options={perOptions} onChange={setPerKeep} />
        </label>
        {doubles && <p className="hire-sub">{t.hsDouble(money(Math.min(per * 2, maxTrade)))}</p>}
        <label className="field" htmlFor="hire-budget">
          <span>{t.hsBudget}{diff(start.budgetUsd, budget) && <small>{diff(start.budgetUsd, budget)}${money(budget)}</small>}</span>
          <Stepper id="hire-budget" label={t.hsBudget} value={budget} options={budgetOptions} onChange={setBudget} />
        </label>
        {editing && <p className="hire-sub">{t.hsSpent(money(book(target.hired).spent))}</p>}
        <div className="field"><span>{t.hsMode}</span><div className="field-ro">{t.hsModeAsk}</div></div>
        <div className="field"><span>{t.hsVault}</span><div className="field-ro">{vault?.configured ? t.hsVaultOn(vault.maxTradeUsdt ?? '?', vault.maxDailyUsdt ?? '?') : t.hsVaultOff}</div></div>
        {plan && (
          <div className="field">
            <span>{t.hsPlan}</span>
            <ol className="hire-plan">{plan.steps.map((s, i) => <li key={i}>{describe(s, lang)}</li>)}</ol>
            {noBuy && <p className="hire-sub">{t.hsNoBuy}</p>}
          </div>
        )}
        <p className="hire-note">{t.hsNote} {t.hsWithdraw}</p>
        {!vault?.configured && <p className="hire-note demo">{t.hsDemo}</p>}
      </div>
    </Modal>
  );
}
