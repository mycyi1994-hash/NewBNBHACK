# DX findings

One reproducible finding per file (docs/DX_PROTOCOL.md §3.3), each from a dated entry in [`../LOG.md`](../LOG.md). Facts only; the DX report itself is written by people (M4-01).

`pnpm dx:repro` runs each finding against the platform as it is now and prints REPRODUCED or NOT REPRODUCED with the time. It signs and sends nothing. Without a Binance Web3 API key, the findings that need one are skipped; `--baw <path>` runs the `baw` one.

| Finding | Platform | Logged (UTC) | Last run |
| --- | --- | --- | --- |
| [docs-waf-challenge](docs-waf-challenge.md) | Web3 API docs host | 09-23 17:44 | 10-01 16:52 REPRODUCED |
| [defi-unlimited-approve](defi-unlimited-approve.md) | DeFi API | 09-23 18:00, 09-24 00:49 | needs a key |
| [ondo-minimum-order](ondo-minimum-order.md) | Trading API | 09-24 00:46 | needs a key |
| [defi-40484-two-causes](defi-40484-two-causes.md) | DeFi API | 09-24 00:49 | needs a key |
| [reference-price-derived](reference-price-derived.md) | RWA Data | 09-24 00:55 | needs a key |
| [rate-limit-sliding-window](rate-limit-sliding-window.md) | Web3 API gateway | 09-24 01:52 | needs a key |
| [bsc-public-rpc-log-range](bsc-public-rpc-log-range.md) | BSC public RPC | 09-30 02:10 | 10-01 16:52 REPRODUCED |
| [rwa-list-tickers-per-chain](rwa-list-tickers-per-chain.md) | Public RWA list (Skills Hub) | 10-01 06:04 | 10-01 16:52 REPRODUCED |
| [baw-status-signed-out](baw-status-signed-out.md) | Agentic Wallet CLI 1.10.0 | 10-01 06:19 | 10-01 16:52 REPRODUCED |

`quote-id-expiry` in `dx:repro` is a measurement, not a finding: a quoteId still works right away and is gone 35 s later (40401), as the documented 30 s says (LOG 09-24 00:52).
