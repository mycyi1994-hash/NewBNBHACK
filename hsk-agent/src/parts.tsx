// The vault as the server reports it (/api/vault).

export interface VaultInfo { configured: boolean; vault?: string; explorerUrl?: string; localFork?: boolean; usdtBalance?: string; remainingTodayUsdt?: string; maxTradeUsdt?: string; maxDailyUsdt?: string }
