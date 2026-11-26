// The vault, shown the same way wherever it appears: what it is (connected or demo), the limits the contract
// enforces, and how much of today's limit is used. Three sizes: the sidebar line, the line under Moa's input,
// and the full card on "My agents". Without a vault nothing is sent, and the card says so calmly, once.
import type { VaultInfo } from './parts.tsx';
import { useT } from './i18n.ts';
import { Icon } from './Icons.tsx';
import { CopyAddress } from './ui.tsx';

const num = (s?: string) => { const v = Number(s); return Number.isFinite(v) ? v : 0; };
const usd = (v: number) => (Math.round(v * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });

/** Today's limit: how much is used and how much is left. */
export function vaultUse(v: VaultInfo) {
  const max = num(v.maxDailyUsdt), left = Math.min(max, num(v.remainingTodayUsdt)), used = Math.max(0, max - left);
  return { max, left, used, frac: max > 0 ? Math.min(1, used / max) : 0 };
}

function Gauge({ frac, label }: { frac: number; label: string }) {
  return <span className={`gauge${frac >= 0.9 ? ' full' : ''}`} role="img" aria-label={label}><i style={{ width: `${Math.round(frac * 100)}%` }} /></span>;
}

/** Sidebar: one row. Connected shows what is left today with a thin gauge; demo says so in two words. */
export function VaultMini({ vault }: { vault: VaultInfo | null }) {
  const { t } = useT();
  const on = !!vault?.configured;
  const u = on ? vaultUse(vault!) : null;
  return (
    <div className={`vault-mini${on ? ' on' : ''}`} data-tip={on ? t.vcSide(usd(u!.left)) : t.vcDemoLine}>
      <span className="nav-icon"><Icon name="shield" size={18} /></span>
      <span className="nav-text">
        <span className="vm-top"><b>{t.mineVault}</b><span className={`vm-state${on ? ' on' : ''}`}><i />{on ? t.vcLive : t.vcDemo}</span></span>
        {u && <><Gauge frac={u.frac} label={t.vcUsed(usd(u.used), usd(u.max))} /><small>{t.vcSide(usd(u.left))}</small></>}
      </span>
    </div>
  );
}

/** Under Moa's input: the limits in one line. */
export function VaultLine({ vault }: { vault: VaultInfo | null }) {
  const { t } = useT();
  if (!vault?.configured) return <><Icon name="shield" size={14} /><span>{t.vcDemo}</span><span className="vl-sep">·</span><span>{t.vcDemoShort}</span></>;
  const u = vaultUse(vault);
  return (
    <>
      <Icon name="shield" size={14} />
      <span>{t.perTrade} ${vault.maxTradeUsdt}</span><span className="vl-sep">·</span>
      <Gauge frac={u.frac} label={t.vcUsed(usd(u.used), usd(u.max))} /><span>{t.vcSide(usd(u.left))}</span>
      {vault.vault && <CopyAddress value={vault.vault} label={t.copyAddress} done={t.addressCopied} />}
      {vault.localFork && <span className="fork-badge">{t.localFork}</span>}
    </>
  );
}

/** "My agents": the whole picture. */
export function VaultCard({ vault }: { vault: VaultInfo | null }) {
  const { t } = useT();
  const on = !!vault?.configured;
  const u = on ? vaultUse(vault!) : null;
  return (
    <section className={`vault-card${on ? ' on' : ''}`}>
      <header className="vc-head">
        <span className="vc-ic" aria-hidden><Icon name="shield" size={18} /></span>
        <b>{t.mineVault}</b>
        <span className={`vm-state${on ? ' on' : ''}`}><i />{on ? t.vcLive : t.vcDemo}</span>
        {vault?.localFork && <span className="fork-badge">{t.localFork}</span>}
        {on && vault!.vault && <span className="vc-addr"><CopyAddress value={vault!.vault} label={t.copyAddress} done={t.addressCopied} />{vault!.explorerUrl && <a href={vault!.explorerUrl} target="_blank" rel="noreferrer">{t.vcExplorer} ↗</a>}</span>}
      </header>
      {u ? (
        <div className="vc-body">
          <div className="vc-day">
            <div className="vc-day-top"><span>{t.perDay}</span><b>{t.vcUsed(usd(u.used), usd(u.max))}</b></div>
            <Gauge frac={u.frac} label={t.vcUsed(usd(u.used), usd(u.max))} />
            <small>{t.vcSide(usd(u.left))}</small>
          </div>
          <dl className="vc-nums">
            <div><dt>{t.perTrade}</dt><dd>${vault!.maxTradeUsdt}</dd></div>
            <div><dt>{t.balance}</dt><dd>{usd(num(vault!.usdtBalance))}</dd></div>
          </dl>
        </div>
      ) : <p className="vc-demo">{t.vcDemoLine}</p>}
      <ul className="vc-safe">{t.vcSafe.map((s) => <li key={s}><Icon name="check" size={14} />{s}</li>)}</ul>
    </section>
  );
}
