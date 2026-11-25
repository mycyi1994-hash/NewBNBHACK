/** Coin mark: the three HSK Chain coins have brand colours; any other coin gets its first letter. */
export function CoinMark({ base, big }: { base: string; big?: boolean }) {
  const known = ['BTC', 'ETH', 'HSK'].includes(base);
  return known
    ? <span className={`coin coin-${base.toLowerCase()}${big ? ' big' : ''}`} />
    : <span className={`coin-letter coin-l-${(base.charCodeAt(0) + base.length) % 5}${big ? ' big' : ''}`} aria-hidden>{base.slice(0, 1)}</span>;
}
