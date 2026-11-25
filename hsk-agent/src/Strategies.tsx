// "Agents for this market", under the chart. No backtests of its own: it shows the agents from agents.ts,
// so a tile, the agent market and Moa's card carry the same numbers.
//  - CEX view: the five position agents for the HashKey market on screen.
//  - DEX view: the four collect agents for the HSKSwap coin on screen.
// Tapping a tile hands the agent to Moa on the right. The tile Moa would recommend wears the "Pick" badge.
import { useEffect, useState } from 'react';
import type { Asset } from './intent.ts';
import { ASSETS } from './intent.ts';
import { useT } from './i18n.ts';
import { SlidePill } from './motion.tsx';
import * as cex from './cex.ts';
import { collectAgents, isRunnable, positionAgents, type Agent } from './agents.ts';
import { readLevel, recommend } from './recommend.ts';
import { AgentCard } from './AgentCard.tsx';

export default function MarketAgents({ venue, market = cex.DEFAULT_MARKET, asset = 'BTC', setAsset = () => {}, onPick }: {
  venue: 'cex' | 'dex'; market?: cex.Market; asset?: Asset; setAsset?: (a: Asset) => void; onPick: (a: Agent) => void;
}) {
  const { t } = useT();
  const [list, setList] = useState<Agent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const coin = venue === 'cex' ? market.base : asset;

  useEffect(() => {
    let alive = true;
    setList(null); setFailed(false); setPicked(null);
    (venue === 'cex' ? positionAgents(market) : collectAgents(asset)).then((xs) => alive && setList(xs), () => alive && setFailed(true));
    return () => { alive = false; };
  }, [venue, market.symbol, asset]); // eslint-disable-line react-hooks/exhaustive-deps

  const best = list ? recommend(list, { coin, level: readLevel() })?.pick.id : undefined;
  const hint = venue === 'dex' ? t.mkHintDex : isRunnable(coin) ? t.mkHintCex(coin) : t.mkHintSignal(coin);

  return (
    <section className="strats" aria-label={t.mkTitle}>
      <div className="strats-head">
        <div>
          <h3>{t.mkTitle}</h3>
          <p className="muted">{hint}</p>
        </div>
        {venue === 'dex' && (
          <div className="coin-switch has-pill" role="tablist" aria-label={t.stratAsset}>
            <SlidePill dep={asset} />
            {ASSETS.map((a) => <button key={a} role="tab" aria-selected={a === asset} className={a === asset ? 'on' : ''} onClick={() => setAsset(a)}>{a}</button>)}
          </div>
        )}
      </div>
      {failed && <p className="muted">{t.agFailed}</p>}
      <div className="strat-tiles stagger" key={`${venue}-${coin}-${market.kind}`}>
        {!list && !failed && [0, 1, 2, 3].map((i) => <div key={i} className="tile skel-block" aria-hidden />)}
        {list?.map((a) => (
          <AgentCard key={a.id} agent={a} size="tile" picked={picked === a.id} best={a.id === best}
            onPick={() => { setPicked(a.id); onPick(a); }} />
        ))}
      </div>
      <p className="strats-foot muted">{t.mkFoot}</p>
    </section>
  );
}
