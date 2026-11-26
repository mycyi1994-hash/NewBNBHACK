// The account, at the top right of every screen. Logged out it is one button. Logged in it shows the nickname and
// wallet address; opening it shows the wallet's own vault (what it holds, its limits) with Deposit and Withdraw.
// Deposits and withdrawals are transactions from the user's own wallet: the server cannot move funds in or out.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { VaultInfo } from './parts.tsx';
import { deposit, logIn, logOut, nickOf, saveNick, shortAddress, useSession, wallets, withdraw, type SendResult, type WalletChoice } from './account.ts';
import { vaultUse } from './VaultCard.tsx';
import { useT } from './i18n.ts';
import { Icon } from './Icons.tsx';
import { CopyAddress, CopyButton, Modal, useToast } from './ui.tsx';

const money = (s?: string | number) => { const v = Number(s); return (Number.isFinite(v) ? v : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const qty = (s: string) => { const v = Number(s); return v >= 1 ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : v.toPrecision(4).replace(/\.?0+$/, ''); };
const AMOUNT = /^\d+(\.\d{1,6})?$/;

/** A round mark coloured from the address, so the same wallet always looks the same. */
function Avatar({ address, size = 24 }: { address: string; size?: number }) {
  const n = parseInt(address.slice(2, 8), 16) || 0;
  const a = n % 360, b = (a + 70 + (n >> 9) % 80) % 360;
  return <span className="acct-av" aria-hidden style={{ width: size, height: size, background: `linear-gradient(135deg, hsl(${a} 78% 58%), hsl(${b} 80% 46%))` }} />;
}

export default function AccountButton({ vault, onReload, onRetryVault }: { vault: VaultInfo | null; onReload: () => void; onRetryVault: () => void }) {
  const { t, lang } = useT();
  const toast = useToast();
  const s = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [noWallet, setNoWallet] = useState(false);
  const [choices, setChoices] = useState<WalletChoice[] | null>(null);
  const [dialog, setDialog] = useState<'deposit' | 'withdraw' | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open && !noWallet && !choices) return;
    const shut = () => { setOpen(false); setNoWallet(false); setChoices(null); setNaming(null); };
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) shut(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') shut(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, noWallet, choices]);

  /** Log in. With several wallets in the browser and none picked yet, show the list instead. */
  const enter = async (walletId?: string) => {
    if (!walletId && choices) { setChoices(null); return; }
    setChoices(null); setNoWallet(false);
    setBusy(true);
    const r = await logIn(walletId);
    setBusy(false);
    if (r.ok) { setOpen(true); return; }
    if (r.why === 'choose') setChoices(wallets());
    else if (r.why === 'nowallet') setNoWallet(true);
    else toast(r.why === 'rejected' ? t.acRejected : t.acFailed(r.detail ?? ''));
  };

  if (!s) {
    return (
      <div className="acct" ref={root}>
        <button className="btn-primary acct-login" onClick={() => void enter()} disabled={busy}>{busy ? t.acLoggingIn : t.acLogin}</button>
        {choices && (
          <div className="acct-pop pick" role="dialog" aria-label={t.acPick}>
            <b>{t.acPick}</b>
            <ul>
              {choices.map((w) => (
                <li key={w.id}>
                  <button onClick={() => void enter(w.id)}>
                    {w.icon ? <img src={w.icon} alt="" width={28} height={28} /> : <span className="acct-wicon" aria-hidden><Icon name="shield" size={16} /></span>}
                    <span>{w.name}</span>
                    <Icon name="chevron" size={14} />
                  </button>
                </li>
              ))}
            </ul>
            <small>{t.acPickNote}</small>
          </div>
        )}
        {noWallet && (
          <div className="acct-pop note" role="dialog" aria-label={t.acLogin}>
            <b>{t.acNoWalletTitle}</b>
            <p>{t.acNoWallet}</p>
            <a className="btn" href="https://metamask.io/download/" target="_blank" rel="noreferrer">{t.acGetWallet} ↗</a>
          </div>
        )}
      </div>
    );
  }

  const nick = nickOf(s.address, lang);
  const on = !!vault?.configured;
  const u = on ? vaultUse(vault!) : null;
  const saveName = () => { if (naming !== null) { saveNick(s.address, naming); setNaming(null); } };
  const state: ReactNode = on
    ? null
    : vault?.makeError ? <p className="acct-msg warn">{t.acMakeFailed(vault.makeError)} <button className="link" onClick={onRetryVault}>{t.retry}</button></p>
    : vault && vault.service === false ? <p className="acct-msg">{t.acNoService}</p>
    : <p className="acct-msg"><span className="spin" aria-hidden />{t.acMaking}</p>;

  return (
    <div className="acct" ref={root}>
      <button className={`acct-btn${open ? ' on' : ''}`} onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open}>
        <Avatar address={s.address} />
        <span className="acct-name">{nick}</span>
        <code>{shortAddress(s.address)}</code>
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div className="acct-pop" role="dialog" aria-label={t.acAccount}>
          <div className="acct-head">
            <Avatar address={s.address} size={40} />
            <div className="acct-who">
              {naming !== null ? (
                <form className="acct-rename" onSubmit={(e) => { e.preventDefault(); saveName(); }}>
                  <input autoFocus value={naming} maxLength={20} onChange={(e) => setNaming(e.target.value)} onBlur={saveName} aria-label={t.acNick} placeholder={t.acNick} />
                </form>
              ) : (
                <div className="acct-nick"><b>{nick}</b><button className="icon-btn sm" onClick={() => setNaming(nick)} aria-label={t.acRename} data-tip={t.acRename}><Icon name="edit" size={14} /></button></div>
              )}
              <CopyAddress value={s.address} label={t.copyAddress} done={t.addressCopied} />
            </div>
          </div>

          <section className="acct-vault">
            <div className="acct-label">
              <span><Icon name="shield" size={14} />{t.acVault}</span>
              {on && <span className={`vm-state on${vault!.paused ? ' paused' : ''}`}><i />{vault!.paused ? t.acPaused : t.vcLive}</span>}
              {vault?.localFork && <span className="fork-badge">{t.localFork}</span>}
            </div>
            {on ? (
              <>
                <div className="acct-bal"><b>${money(vault!.usdtBalance)}</b><span>USDT</span></div>
                {vault!.holdings && vault!.holdings.length > 0 && (
                  <ul className="acct-held">{vault!.holdings.map((h) => <li key={h.symbol}><span>{h.symbol}</span><b>{qty(h.amount)}</b></li>)}</ul>
                )}
                {Number(vault!.usdtBalance) === 0 && !vault!.holdings?.length && <p className="acct-msg">{t.acEmpty}</p>}
                <div className="acct-lim">
                  <span>{t.hsVaultOn(vault!.maxTradeUsdt ?? '?', vault!.maxDailyUsdt ?? '?')}</span>
                  <span className={`gauge${u!.frac >= 0.9 ? ' full' : ''}`} role="img" aria-label={t.vcUsed(money(u!.used), money(u!.max))}><i style={{ width: `${Math.round(u!.frac * 100)}%` }} /></span>
                  <small>{t.vcSide(money(u!.left))}</small>
                </div>
                <div className="acct-addr">
                  <CopyAddress value={vault!.vault!} label={t.copyAddress} done={t.addressCopied} />
                  {vault!.explorerUrl && <a href={vault!.explorerUrl} target="_blank" rel="noreferrer">{t.vcExplorer} ↗</a>}
                </div>
              </>
            ) : state}
          </section>

          <div className="acct-actions">
            <button className="btn-primary" disabled={!on} onClick={() => { setOpen(false); setDialog('deposit'); }}>{t.acDeposit}</button>
            <button className="btn" disabled={!on} onClick={() => { setOpen(false); setDialog('withdraw'); }}>{t.acWithdraw}</button>
          </div>
          <button className="acct-out" onClick={() => { setOpen(false); logOut(); }}>{t.acLogout}</button>
        </div>
      )}
      {dialog === 'deposit' && on && <Deposit vault={vault!} onClose={() => setDialog(null)} onDone={onReload} />}
      {dialog === 'withdraw' && on && <Withdraw vault={vault!} owner={s.address} onClose={() => setDialog(null)} onDone={onReload} />}
    </div>
  );
}

/** What the wallet said, in words. */
function useSendNote() {
  const { t } = useT();
  return (r: SendResult): string => (r.ok ? '' : r.why === 'rejected' ? t.txRejected : r.why === 'reverted' ? t.txReverted : r.why === 'slow' ? t.txSlow : r.why === 'nowallet' ? t.acNoWallet : t.txFailed(r.detail ?? ''));
}

function Deposit({ vault, onClose, onDone }: { vault: VaultInfo; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const note = useSendNote();
  const [amount, setAmount] = useState('20');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inWallet = Number(vault.walletUsdt ?? 0);
  const v = Number(amount);
  const valid = AMOUNT.test(amount) && v > 0;
  const tooMuch = valid && v > inWallet;
  const go = async () => {
    if (!vault.net || !vault.vault) return;
    setBusy(true); setError('');
    const r = await deposit(vault.net, vault.vault, amount);
    setBusy(false);
    if (r.ok) { toast(t.dpDone(money(amount))); onDone(); onClose(); } else setError(note(r));
  };
  return (
    <Modal title={t.dpTitle} onClose={onClose} actions={<>
      <button className="btn-text" onClick={onClose}>{t.close}</button>
      <button className="btn-primary" disabled={!valid || tooMuch || busy} onClick={() => void go()}>{busy ? t.txWaiting : t.dpSend(valid ? money(amount) : '')}</button>
    </>}>
      <div className="fund">
        <p className="fund-lead">{t.dpLead}</p>
        <div className="field">
          <span>{t.dpAddress}</span>
          <div className="fund-addr"><code>{vault.vault}</code><CopyButton text={vault.vault ?? ''} label={t.copyAddress} done={t.addressCopied} /></div>
        </div>
        <p className="fund-warn"><Icon name="shield" size={14} />{t.dpNet}</p>
        <div className="fund-or"><span>{t.dpOr}</span></div>
        <label className="field" htmlFor="fund-amount">
          <span>{t.dpAmount}<small>{t.dpInWallet(money(inWallet))}</small></span>
          <div className="fund-input">
            <input id="fund-amount" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value.trim()); setError(''); }} aria-invalid={!valid || tooMuch} />
            <span>USDT</span>
            {[10, 20, 50].map((n) => <button key={n} type="button" className={amount === String(n) ? 'on' : ''} onClick={() => { setAmount(String(n)); setError(''); }}>{n}</button>)}
          </div>
        </label>
        {tooMuch && <p className="fund-note warn">{t.dpTooMuch(money(inWallet))}</p>}
        {error && <p className="fund-note warn">{error}</p>}
        <p className="fund-note">{t.dpGas}</p>
      </div>
    </Modal>
  );
}

function Withdraw({ vault, owner, onClose, onDone }: { vault: VaultInfo; owner: string; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const note = useSendNote();
  const tokens = [
    { symbol: 'USDT', address: vault.net?.usdt ?? '', decimals: 6, amount: vault.usdtBalance ?? '0' },
    ...(vault.holdings ?? []),
  ].filter((x) => Number(x.amount) > 0);
  const [symbol, setSymbol] = useState(tokens[0]?.symbol ?? 'USDT');
  const token = tokens.find((x) => x.symbol === symbol) ?? tokens[0];
  const [amount, setAmount] = useState(token?.amount ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const v = Number(amount);
  const valid = !!token && AMOUNT.test(amount) && v > 0 && v <= Number(token.amount);
  const pick = (x: (typeof tokens)[number]) => { setSymbol(x.symbol); setAmount(x.amount); setError(''); };
  const go = async () => {
    if (!vault.net || !vault.vault || !token) return;
    setBusy(true); setError('');
    const r = await withdraw(vault.net, vault.vault, token, amount);
    setBusy(false);
    if (r.ok) { toast(t.wdDone(`${qty(amount)} ${token.symbol}`)); onDone(); onClose(); } else setError(note(r));
  };
  return (
    <Modal title={t.wdTitle} onClose={onClose} actions={<>
      <button className="btn-text" onClick={onClose}>{t.close}</button>
      <button className="btn-primary" disabled={!valid || busy} onClick={() => void go()}>{busy ? t.txWaiting : t.wdSend}</button>
    </>}>
      <div className="fund">
        {!token ? <p className="fund-lead">{t.wdNothing}</p> : (
          <>
            <p className="fund-lead">{t.wdLead(shortAddress(owner))}</p>
            <div className="field">
              <span>{t.wdWhat}</span>
              <div className="fund-tokens">{tokens.map((x) => <button key={x.symbol} type="button" className={x.symbol === token.symbol ? 'on' : ''} onClick={() => pick(x)}><b>{x.symbol}</b><small>{qty(x.amount)}</small></button>)}</div>
            </div>
            <label className="field" htmlFor="wd-amount">
              <span>{t.dpAmount}<small>{t.wdInVault(`${qty(token.amount)} ${token.symbol}`)}</small></span>
              <div className="fund-input">
                <input id="wd-amount" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value.trim()); setError(''); }} aria-invalid={!valid} />
                <span>{token.symbol}</span>
                <button type="button" className={amount === token.amount ? 'on' : ''} onClick={() => { setAmount(token.amount); setError(''); }}>{t.wdAll}</button>
              </div>
            </label>
            {error && <p className="fund-note warn">{error}</p>}
            <p className="fund-note">{t.dpGas}</p>
          </>
        )}
      </div>
    </Modal>
  );
}
