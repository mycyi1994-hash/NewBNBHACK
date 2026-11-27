// The vault, shown the same way wherever it appears: what it is (connected or demo), the limits the contract
// enforces, and how much of today's limit is used. Three sizes: the sidebar line, the line under Moa's input,
// and the full card on "My agents". Without a vault nothing is sent, and the card says so calmly, once.
import { limitsText, vaultWhy, type VaultInfo, type VaultWhy } from './parts.tsx';
import { useT } from './i18n.ts';
import { Icon } from './Icons.tsx';
import { CopyAddress } from './ui.tsx';

const num = (s?: string) => { const v = Number(s); return Number.isFinite(v) ? v : 0; };
const usd = (v: number) => (Math.round(v * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });

/** Today's limit: how much is used and how much is left. `none` when the owner set no daily limit. */
export function vaultUse(v: VaultInfo) {
  const none = v.maxDailyUsdt === undefined;
  const max = num(v.maxDailyUsdt), left = Math.min(max, num(v.remainingTodayUsdt)), used = Math.max(0, max - left);
  return { none, max, left, used, frac: max > 0 ? Math.min(1, used / max) : 0 };
}

function Gauge({ frac, label }: { frac: number; label: string }) {
  return <span className={`gauge${frac >= 0.9 ? ' full' : ''}`} role="img" aria-label={label}><i style={{ width: `${Math.round(frac * 100)}%` }} /></span>;
}

/** The badge next to "Vault": connected, or what is missing. "Demo mode" is only for a server that cannot trade. */
function stateText(t: ReturnType<typeof useT>['t'], why: VaultWhy): string {
  return why === 'on' ? t.vcLive : why === 'login' ? t.vcAskLogin : why === 'making' ? t.vcMakingTag : why === 'wait' ? t.vcWait : t.vcDemo;
}
/** The sentence that goes with it when there is no vault yet. */
function stateLine(t: ReturnType<typeof useT>['t'], why: VaultWhy): string {
  return why === 'login' ? t.vcLoginLine : why === 'making' ? t.acMaking : why === 'wait' ? t.vcWait : t.vcDemoLine;
}

/** Sidebar: one row. Connected shows what is left today with a thin gauge; demo says so in two words. */
export function VaultMini({ vault }: { vault: VaultInfo | null }) {
  const { t } = useT();
  const on = !!vault?.configured;
  const u = on ? vaultUse(vault!) : null;
  const why = vaultWhy(vault);
  return (
    <div className={`vault-mini${on ? ' on' : ''}`} data-tip={on ? (u!.none ? limitsText(t, vault!) : t.vcSide(usd(u!.left))) : stateLine(t, why)}>
      <span className="nav-icon"><Icon name="shield" size={18} /></span>
      <span className="nav-text">
        <span className="vm-top"><b>{t.mineVault}</b><span className={`vm-state${on ? ' on' : ''}`}><i />{stateText(t, why)}</span></span>
        {u && (u.none ? <small>{limitsText(t, vault!)}</small> : <><Gauge frac={u.frac} label={t.vcUsed(usd(u.used), usd(u.max))} /><small>{t.vcSide(usd(u.left))}</small></>)}
      </span>
    </div>
  );
}

/** Under Moa's input: the limits in one line. */
export function VaultLine({ vault }: { vault: VaultInfo | null }) {
  const { t } = useT();
  const why = vaultWhy(vault);
  if (!vault?.configured) return <><Icon name="shield" size={14} /><span>{stateText(t, why)}</span>{why !== 'wait' && why !== 'making' && <><span className="vl-sep">·</span><span>{why === 'login' ? t.vcLoginShort : t.vcDemoShort}</span></>}</>;
  const u = vaultUse(vault);
  const empty = num(vault.usdtBalance) === 0 && !vault.holdings?.length;
  return (
    <>
      <Icon name="shield" size={14} />
      {empty ? <span className="vl-warn">{t.vcEmptyShort}</span> : u.none ? <span>{limitsText(t, vault)}</span> : <>{vault.maxTradeUsdt !== undefined && <><span>{t.limTrade(vault.maxTradeUsdt)}</span><span className="vl-sep">·</span></>}<Gauge frac={u.frac} label={t.vcUsed(usd(u.used), usd(u.max))} /><span>{t.vcSide(usd(u.left))}</span></>}
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
        <span className="vc-title"><b>{t.vcCardTitle}</b><small>{t.vcCardSub}</small></span>
        <span className={`vm-state${on ? ' on' : ''}`}><i />{stateText(t, vaultWhy(vault))}</span>
        {on && vault?.localFork && <span className="fork-badge">{t.localFork}</span>}
        {on && vault!.vault && <span className="vc-addr"><CopyAddress value={vault!.vault} label={t.copyAddress} done={t.addressCopied} />{vault!.explorerUrl && <a href={vault!.explorerUrl} target="_blank" rel="noreferrer">{t.vcExplorer} ↗</a>}</span>}
      </header>
      {u ? (
        <dl className="vc-nums">
          <div><dt>{t.balance}</dt><dd>${usd(num(vault!.usdtBalance))}</dd></div>
          <div><dt>{t.lmDay}</dt>{u.none ? <dd>{t.lmNoLimit}</dd> : <>
            <dd>{t.vcUsed(usd(u.used), usd(u.max))}</dd>
            <Gauge frac={u.frac} label={t.vcUsed(usd(u.used), usd(u.max))} />
            <small>{t.vcSide(usd(u.left))}</small>
          </>}</div>
          <div><dt>{t.lmTrade}</dt><dd>{vault!.maxTradeUsdt !== undefined ? `$${vault!.maxTradeUsdt}` : t.lmNoLimit}</dd></div>
        </dl>
      ) : <p className="vc-demo">{stateLine(t, vaultWhy(vault))}</p>}
      <ul className="vc-safe">{t.vcSafe.map((s) => <li key={s}><Icon name="check" size={14} />{s}</li>)}</ul>
    </section>
  );
}
