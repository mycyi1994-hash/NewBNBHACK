// Moving to a new vault, shown wherever the vault is shown (the vault card on My agents, the account menu).
// One calm card: why, and three steps with the one that is waiting marked. Moa makes the new vault (no signature);
// taking the money out of the old vault and putting it into the new one are the owner's own wallet confirmations.
// Which step is waiting comes from the chain every time (src/move.ts), so the card is the same after a closed tab.
// After the move, while the old vault still holds anything, it is one small line with "take it out".
import { useEffect, useRef, useState } from 'react';
import { deposit, withdraw } from './account.ts';
import { coinsToLeave, makeNewVault, moveStage, startTerms, stepOf, takeOutList } from './move.ts';
import { limitsText, sendNote, type VaultInfo } from './parts.tsx';
import { useT } from './i18n.ts';
import { Icon } from './Icons.tsx';
import { useToast } from './ui.tsx';

const money = (s?: string | number) => { const v = Number(s); return (Number.isFinite(v) ? v : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const AMOUNT = /^\d+(\.\d{1,6})?$/;
/** WBTC → BTC: the name people use, and the one Moa's chat reads. */
const coin = (symbol: string) => symbol.replace(/^W/, '');

/**
 * "Not now" on step 3, and step 3 done: kept in this browser per new vault, only to stop offering the deposit again
 * (the chain cannot tell a wallet that has not put its money in yet from one that took it out again later). It never
 * decides which step is waiting; without it the card simply shows what the chain says.
 */
const laterKey = (vault?: string) => `moa.move.later.v1.${(vault ?? '').toLowerCase()}`;
const isLater = (vault?: string) => { try { return localStorage.getItem(laterKey(vault)) === '1'; } catch { return false; } };
const setLater = (vault?: string) => { try { localStorage.setItem(laterKey(vault), '1'); } catch { /* this visit only */ } };

/** What is going on right now: Moa making the vault, the wallet asked to confirm (i of n), or waiting for the chain's new state. */
type Busy = 'make' | 'wait' | { i: number; n: number } | null;

export default function MoveVault({ vault, onReload, compact }: { vault: VaultInfo | null; onReload: () => void; compact?: boolean }) {
  const { t } = useT();
  const toast = useToast();
  const stage = moveStage(vault);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');
  const [typed, setTyped] = useState<string | null>(null);
  /** The USDT step 2 took out in this sitting: what step 3 offers to put in. After a closed tab it is the wallet's balance. */
  const took = useRef<string | null>(null);
  const [, setHidden] = useState(0);
  // The server's next answer ends the wait; so does ten seconds without one.
  useEffect(() => { setBusy((b) => (b === 'wait' ? null : b)); }, [vault]);
  useEffect(() => { if (busy !== 'wait') return; const x = setTimeout(() => setBusy(null), 10_000); return () => clearTimeout(x); }, [busy]);
  if (!vault || !stage) return null;
  if (stage === 'putIn' && busy === null && isLater(vault.vault)) return null;

  const net = vault.net;
  const signText = busy && typeof busy === 'object' ? t.mvSign(busy.i, busy.n) : '';
  /** Step 2, and the small line after the move: one withdrawal per token the old vault holds, each confirmed in the wallet. */
  const takeOut = async () => {
    if (!net || !vault.old || busy) return;
    const list = takeOutList(vault.old, net.usdt);
    setError('');
    for (const [i, x] of list.entries()) {
      setBusy({ i: i + 1, n: list.length });
      const r = await withdraw(net, vault.old.vault, x, x.amount);
      if (!r.ok) { setBusy(null); setError(sendNote(t, r)); onReload(); return; }
      if (x.symbol === 'USDT') took.current = x.amount;
    }
    setBusy('wait'); onReload();
  };

  const coins = coinsToLeave(vault, stage).map(coin);
  if (stage === 'left') {
    return (
      <div className="move-left">
        <p><Icon name="info" size={14} /><span>{t.mvLeft(money(vault.old?.totalUsdt))}</span><button className="link" disabled={!!busy} onClick={() => void takeOut()}>{signText || t.mvTake}</button></p>
        {coins.length > 0 && <small>{t.mvCoinsWallet(coins.join(', '))}</small>}
        {error && <small className="warn" role="alert">{error}</small>}
      </div>
    );
  }

  const step = stepOf(stage)!;
  const make = async () => {
    if (busy) return;
    setBusy('make'); setError('');
    const r = await makeNewVault();
    if (!r.ok) { setBusy(null); setError(t.mvFailed(r.reason)); return; }
    if (r.paused > 0) toast(t.mvPaused);
    setBusy('wait'); onReload();
  };
  // What the new vault starts with, read from the vault itself once it exists.
  const start = startTerms(vault);
  const startLine = stage === 'make' ? '' : t.mvStart([limitsText(t, vault), ...(start.stopPct ? [t.lmStopShort(String(start.stopPct))] : []), ...(start.days ? [t.mvPermit(start.days)] : [])].join(' · '));
  const inWallet = Number(vault.walletUsdt ?? 0);
  const offer = typed ?? (took.current && Number(took.current) <= inWallet ? took.current : vault.walletUsdt ?? '');
  const valid = AMOUNT.test(offer) && Number(offer) > 0 && Number(offer) <= inWallet;
  const putIn = async () => {
    if (!net || !vault.vault || busy || !valid) return;
    setBusy({ i: 1, n: 1 }); setError('');
    const r = await deposit(net, vault.vault, offer);
    if (!r.ok) { setBusy(null); setError(sendNote(t, r)); return; }
    toast(`${t.mvDone} ${startLine}`);
    setLater(vault.vault);
    setBusy('wait'); onReload();
  };
  // How many times the wallet asks in step 2: once per token in the vault the money leaves.
  const outOf = stage === 'make' ? Number(Number(vault.usdtBalance ?? 0) > 0) + coins.length : vault.old ? takeOutList(vault.old, net?.usdt ?? '').length : 0;
  const notes = [t.mvNoteMake, outOf > 0 ? t.mvNoteSign(outOf) : '', t.mvNoteSign(1)];
  const working = !!busy;
  return (
    <section className={`move${compact ? ' compact' : ''}`} aria-label={t.mvTitle}>
      <header className="move-head">
        <span className="vc-ic" aria-hidden><Icon name="shield" size={18} /></span>
        <div className="move-title"><b>{t.mvTitle}</b><small>{t.mvWhy}</small></div>
      </header>
      <ol className="pf-steps">
        {t.mvSteps.map((s, i) => {
          const n = i + 1;
          return (
            <li key={s} className={n < step ? 'done' : n === step ? 'on' : ''} aria-current={n === step ? 'step' : undefined}>
              <span aria-hidden>{n < step ? <Icon name="check" size={14} /> : n}</span>
              <div className="move-step"><b>{s}</b>{notes[i] && <small>{notes[i]}</small>}</div>
            </li>
          );
        })}
      </ol>
      {coins.length > 0 && <p className="move-note">{stage === 'make' ? t.mvCoinsSell(coins.join(', '), coins[0]) : t.mvCoinsWallet(coins.join(', '))}</p>}
      {stage === 'putIn' && (
        <label className="field" htmlFor={compact ? 'move-amount-menu' : 'move-amount'}>
          <span>{t.dpAmount}<small>{t.dpInWallet(money(inWallet))}</small></span>
          <div className="fund-input sm">
            <input id={compact ? 'move-amount-menu' : 'move-amount'} inputMode="decimal" value={offer} onChange={(e) => { setTyped(e.target.value.trim()); setError(''); }} aria-invalid={!valid} />
            <span>USDT</span>
          </div>
        </label>
      )}
      <div className="move-act">
        <button className="btn-primary move-go" disabled={working || (stage === 'putIn' && !valid)} onClick={() => void (stage === 'make' ? make() : stage === 'takeOut' ? takeOut() : putIn())}>
          {working && <span className="spin" aria-hidden />}
          {busy === 'make' ? t.mvMaking : busy === 'wait' ? t.mvChecking : signText || (stage === 'make' ? t.mvGoMake : stage === 'takeOut' ? t.mvGoOut(money(vault.old?.totalUsdt)) : t.mvGoIn(valid ? money(offer) : ''))}
        </button>
        {stage === 'putIn' && !working && <button className="btn-text" onClick={() => { setLater(vault.vault); setHidden((n) => n + 1); }}>{t.mvLater}</button>}
      </div>
      {error && <p className="fund-note warn" role="alert">{error}</p>}
      {startLine && <p className="fund-note">{startLine}</p>}
    </section>
  );
}
