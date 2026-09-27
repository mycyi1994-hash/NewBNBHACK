# ENDPOINTS.md — Binance Web3 API, verified against the official docs

> 이 파일은 `docs/vendor/`에서 유일하게 커밋되는 파일이다. 모든 행은 `docs/vendor/llms-full.txt`의 섹션 제목을
> 출처로 달고 있다. 표(GENERATED 블록)는 `pnpm endpoints`가 llms-full.txt와 공식 커넥터에서 기계적으로 만든다.
> 손으로 쓴 부분은 아래 §1–§3뿐이며, 각 줄에 출처 섹션을 적었다.

- Doc source: `bash scripts/fetch-docs.sh` → `docs/vendor/llms-full.txt` (fetch time, line count and sha256 are printed
  in the generated block). Line numbers (`L…`) refer to that snapshot.
- Connector source: `@binance-web3/wallet@12.3.0` (devDependency of `@ijaro/binance`) and its dependency
  `@binance-web3/common@1.1.0` (signing, envelope, rate-limit headers):
  `packages/binance/node_modules/@binance-web3/wallet/dist/index.{mjs,d.mts}`.
- "Module" names follow the llms-full.txt **API Reference** groups: General Data (= general market data), Address
  Portfolio, RWA Data, Trading API, Transaction API, Wallet API, Defi Data, Defi Transaction, B402 Payments.
  Authentication is §1 below.

## 1. Authentication (all modules)

| Item | Value | Source (llms-full.txt) |
| --- | --- | --- |
| Base URL | `https://web3.binance.com/build` (connector constant `WEB3_WALLET_REST_API_PROD_URL` is the same) | § Authentication › Base URL & Required `/build` Prefix (L158) |
| Required headers | `X-OC-APIKEY`; `X-OC-TIMESTAMP` = UTC ISO 8601 with milliseconds, e.g. `2026-05-11T10:08:57.715Z`; `X-OC-SIGN` = Base64 signature | § Authentication › Step 2 — Understand Required Headers (L144) |
| Optional headers | `X-OC-RECV-WINDOW` (ms, default 5000, max 60000); `X-OC-NONCE` (anti-replay id, falls back to `X-OC-SIGN`) | § Authentication › Step 2 (L144) |
| Pre-hash string | `timestamp + METHOD + requestPath + body`, no separators. `requestPath` = `/build` + path + raw URL-encoded query **exactly as sent** (no decoding, no re-ordering). `body` = raw body string for POST/PUT/DELETE, `""` for GET/HEAD | § Authentication › Step 3 — Generate the Signature › 3.1 Build the Pre-Hash String (L193) |
| Signature | `Base64(HMAC-SHA256(preHash, secretKey))`, UTF-8. Connector: `Web3RequestSigner.signWeb3()` in `@binance-web3/common`, identical. The connector also supports Ed25519 keys (error pages mention "HMAC-SHA256 or Ed25519"; the Authentication page documents HMAC only) | § Authentication › 3.2 Sign with HMAC-SHA256 (Default) (L239) |
| Clock window | request time must be within `recv_window` of server time (default 5 s); a nonce (or signature) is single-use within `2 × recv_window`; violation → `40103` | § Authentication › Timestamp & Anti-Replay (L375) |
| Rate limits | per IP 1,200 / 60 s; per API key 1,200 / 60 s; per user 6,000 / 60 s; per endpoint 5 RPS (default). Exceeded → HTTP 429 + `Retry-After` (seconds). DeFi: "All DeFi API endpoints share a default rate limit of 5 QPS" | § Authentication › Rate Limits (L392); § DeFi Introduction › Rate Limits (L3688) |
| Rate-limit response headers | `X-OC-RateLimit-Limit`, `X-OC-RateLimit-Remaining`, `X-OC-Used-Weight`, `Retry-After` (connector `parseRateLimitHeaders` reads the same four). The doc table maps one header per dimension, which does not say which dimension a header reports — see dx/LOG.md | § Authentication › Rate Limits (L392) |
| Gateway error codes | HTTP 400 `40001` params · 401 `40101` key · 401 `40102` signature · 401 `40103` timestamp/replay · 403 `40104` permission · 429 `42900` rate · 500 `50000` · 503 `50001`. Error body `{code, msg, data: null, timestamp}` (no `success`) | § Authentication › Error Codes (L407) |
| API key scope | keys are bound to capability domains (Trading, Market, Wallet, Transaction, DeFi, B402) chosen when the key is created | § Change Log › 2026-08-27 (L3238) |
| Restricted regions | IP-checked on portal and API: US (+GU, MP, PR, VI, AS, UM), CA, NL, IR, CU, KP, UA-CR/DPR/LPR, GB; JP conditional | § Service-Restricted Countries & Regions › Prohibited List (L15) |

## 2. Response envelopes and error transport

| Module | Envelope | Errors arrive as | Source (llms-full.txt) |
| --- | --- | --- | --- |
| All (documented default) | `OCResult<T>` = `{code, msg, data, timestamp, success}`; `code = 0` success, `success` derived from `code == 0`; `timestamp` ms | — | § Overview › Unified Response Format (L94) |
| General/Portfolio/RWA (Market API) | `OCResult<T>` | **HTTP 200** with non-zero `code` ("All Market API responses — including errors — return HTTP 200") | § Error Codes (Market API) › Response Format (L3356) |
| Trading API | `OCResult<T>` | **HTTP 200** with non-zero `code` | § Error Codes (Trading API) › Response Format (L2952) |
| Transaction API | `OCResult<T>` | **HTTP 200** with non-zero `code` | § Error Codes (Transaction API) › Response Format (L1988) |
| Wallet API | `OCResult<T>` | **HTTP 200** with non-zero `code` | § Error Codes (Wallet API) › Response Format (L1842) |
| DeFi Data / Transaction | `OCResult<T>` | business errors HTTP 200; gateway errors **401 / 429** ("Handle both the HTTP status and the body `code`") | § Error Codes (DeFi API) › Response Format (L4226) |
| B402 Payments | **different**: `{status, type, code: string, errorData, data, subData, params}` (connector types); success envelope code `"000000000"`, errors `1160101…1160409`; request body wrapped as `{"body": {...}}` | gateway errors with HTTP status (400/401/403/429/500/503); x402 outcomes HTTP 200 inside `data` | § Integration Guide (B402) › Read and Cache Supported Configurations (L4881); § Error Codes (B402) › B402 Envelope Errors (L5057) |

Our parser (`packages/binance/src/envelope.ts`) therefore treats `success === false`, a non-zero numeric `code`, or a
b402 code other than `"000000000"` as an error regardless of HTTP status, and treats a body without an envelope (e.g.
a gateway 401 or a WAF page) as a transport error. Error codes are **module-scoped**: `40470` means "Requested DeFi
resource not found" in DeFi but "Tax token cannot configure referral fee" in Trading.

## 3. Facts the Ijaro plan depends on (from the narrative sections)

| Topic | Fact | Source (llms-full.txt unless noted) |
| --- | --- | --- |
| RWA execution mode | Ondo (type 1): always RFQ (InchFusion + CowSwap + PcsXRfq), `executionMode=RFQ`. bStocks (type 3): LiquidMesh SWAP route and PcsXRfq RFQ route may both be returned. xStocks (type 2): AMM, `executionMode=SWAP` | § Introduction (Trading API) › Equity Token Trading (RWA) (L2235) |
| RFQ flow | `GET /quote` → (`GET /approve-transaction` with `vendor`=`vendorName`) → `GET /swap` returns `rfq.typedDataToSign` → sign EIP-712 → `POST /order/submit` (`userSignature`, `vendor`, `quoteId`=`rfq.orderId`, `requestId` UUID for idempotency) → poll `GET /order/{orderId}` until FILLED/FAILED. No raw transaction is broadcast in RFQ mode | § Integration Flow (Trading API) › RFQ Mode (Equity Tokens) (L2678) |
| `userWalletAddress` | Required in `/quote` for RFQ routes (Ondo/bStock); receiver of the RFQ order; must be the EIP-712 signer | § Introduction (Trading API) › Key Constraints for Equity Token Trading (L2276) |
| Quote validity | `quoteId` TTL **30 seconds**; `/swap` after that → `40401 QUOTE_EXPIRED`; request a new quote instead of retrying | § Key Constraints (L2276); § Integration Flow › Step 2 — Get a Quote (L2436) |
| Market hours | Ondo outside US hours → `40367 ONDO_MARKET_STATE_NOT_TRADABLE`; bStock → `40369 BSTOCK_INVALID_TRADING_TIME` | § Key Constraints (L2276); § Error Codes (Trading API) › RFQ Orders (L3092) |
| Minimum order | `40375 ONDO_FROM_USD_AMOUNT_TOO_SMALL` — exact minimum is in `msg` (doc example: "Minimum order amount is 20 USD."); `40366` max single order (market-maker limit) | § Error Codes (Trading API) › RFQ Orders (L3092) |
| Pairing | Ondo must pair with a whitelisted stablecoin (USDT on BSC) → else `40368`; bStock whitelist → else `40370`; no liquidity → `40374` | § Error Codes (Trading API) › RFQ Orders (L3092) |
| Swap build | `GET /swap` needs `quoteId` + same `binanceChainId`, `fromTokenAddress`, `toTokenAddress`, `amount`, required `userWalletAddress`, and `slippagePercent` **or** `autoSlippage=true`; mismatch → `40462`; unsigned EVM tx under `data.tx` (`from,to,data,value,gas,gasPrice[,maxPriorityFeePerGas]`) | § Integration Flow (Trading API) › Step 3 — Build the Swap Transaction (L2454) |
| Amount units | Trading `amount`: smallest unit (integer string). DeFi amounts: **human-readable decimals** (e.g. `"10"` = 10 USDT). DeFi timestamps: Unix **seconds**; elsewhere ms | connector `GetAggregatedQuoteRequest.amount`; § DeFi Introduction › Data Format Conventions (L3675) |
| Broadcast | `POST /api/v1/dex/pre-transaction/broadcast-transaction` body `{binanceChainId, address, signedTransaction, enableMevProtection?}` → `data.txHash`, `data.orderId`; KYT codes `40311–40314`, `40434`; `40431` broadcast failed | § Integration Flow (Trading API) › Step 5 (L2603); § Error Codes (Transaction API) |
| Status | `GET /api/v1/dex/post-transaction/transaction-detail-by-txhash` → `data[].txStatus` ∈ `pending/success/fail`; empty `data` right after broadcast = not indexed yet | § Integration Flow (Trading API) › Step 6 (L2636) |
| DeFi build | `POST /api/v1/defi/transaction/{deposit,redeem}` keyed by `investmentId` (+`address`); returns ordered `dataList` (APPROVE first when needed); `simulate=true` adds `preview`; reverts under simulate → `40484`/`40485` (HTTP 200). Venus is `defiProtocolId=venus`, Earn, deposit/redeem/claim | § Integration Flow (DeFi API) › Step 2, Step 3 (L3755, L3820); § Supported Chains & Protocols (L3494) |
| DeFi APPROVE | **Unlimited** (`type(uint256).max`) allowance; calldata has no server-side expiry (LP actions: 20 min) | § Integration Flow (DeFi API) › Calldata Validity & Approvals (L4119) |
| DeFi redeem delay | `data.redeemDelayDays` `[min,max]` days, `[]` = instant | § Integration Flow (DeFi API) › Redeem waiting period (L3926) |
| RWA market status | `rwa/tokens` item `statusInfo`: `openState`, `marketStatus` (premarket, regular, postmarket, overnight, closed, pause), `reasonCode` (MARKET_CLOSED, MARKET_PAUSED, MARKET_MAINTENANCE, ASSET_PAUSED, ASSET_LIMITED, TRADING, UNSUPPORTED), `reasonMsg` (cash_dividend, stock_dividend, stock_split, merger, acquisition, spinoff, maintenance, corporate action; earnings), `nextOpenTime`, `nextCloseTime` (ms) | connector `GetRwaTokenListResponseDataInnerStatusInfo` (llms-full.txt has no field-level text for RWA) |
| Reference price | `referencePrice`: "A per-share converted price derived from the on-chain token price, not an official quote from the traditional stock market" | connector `GetRwaTokenPriceResponseDataInner` |
| Share ratio | `rwa/tokens` item carries `tokenToShareRatio` — "E.g. `1.003701` means 1 token ≈ 1.003701 underlying shares"; there is no separate `multiplier` field. `assetType`: 1=Stock, 2=Pre-IPO, 3=ETF | connector `GetRwaTokenListResponseDataInner` |

## 4. Endpoint tables (generated)

<!-- BEGIN GENERATED: pnpm endpoints -->

Generated 2026-09-23T18:28:49.557Z from `docs/vendor/llms-full.txt` (fetched 2026-09-23T17:52:39.789Z, 8416 lines, sha256 `ea604b558bd3…`) and `@binance-web3/wallet@12.3.0`.
Operations: 65 in the llms-full.txt API Reference, 65 in the connector.

Legend: `*` marks a required sub-field; _path/query/body/header_ is where the connector puts the parameter on the wire; `x{}` object, `x[]` array. `recvWindow` and `nonce` (optional on every operation) are omitted — see Authentication.

### General Data

| Method | Path | Required params | Optional params | Response `data` fields | Source (llms-full.txt) |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/dex/market/supported/chain` | — | — | `[]` of: `binanceChainId`, `name`, `shortName`, `logoUrl`, `caseSensitive`, `nativeTokenSymbol`, `nativeTokenDecimals` | § API Reference › General Data › "Get Supported Chains" (L7749), op `getSupportedChains` |
| POST | `/api/v1/dex/market/price` | — | — | `[]` of: `binanceChainId`, `tokenContractAddress`, `price`, `time` | § API Reference › General Data › "Get Token Price" (L7757), op `getTokenPrice` |
| POST | `/api/v1/dex/market/price-info` | — | — | `[]` of: `binanceChainId`, `tokenContractAddress`, `price`, `time`, `marketCap`, `priceChange5M`, `priceChange1H`, `priceChange4H`, `priceChange24H`, `volume5M`, `volume1H`, `volume4H`, `volume24H`, `buyVolume5M`, `buyVolume1H`, `buyVolume4H`, `buyVolume24H`, `sellVolume5M`, `sellVolume1H`, `sellVolume4H`, `sellVolume24H`, `txs5M`, `txs1H`, `txs4H`, `txs24H`, `buyTxs5M`, `buyTxs1H`, `buyTxs4H`, `buyTxs24H`, `sellTxs5M`, `sellTxs1H`, `sellTxs4H`, `sellTxs24H`, `maxPrice`, `minPrice`, `circSupply`, `liquidity`, `holders`, `bnVolume5M`, `bnVolume1H`, `bnVolume4H`, `bnVolume24H`, `bnBuyVolume5M`, `bnBuyVolume1H`, `bnBuyVolume4H`, `bnBuyVolume24H`, `bnSellVolume5M`, `bnSellVolume1H`, `bnSellVolume4H`, `bnSellVolume24H`, `bnTxs5M`, `bnTxs1H`, `bnTxs4H`, `bnTxs24H`, `bnBuyTxs5M`, `bnBuyTxs1H`, `bnBuyTxs4H`, `bnBuyTxs24H`, `bnSellTxs5M`, `bnSellTxs1H`, `bnSellTxs4H`, `bnSellTxs24H` | § API Reference › General Data › "Get Token Trading Info" (L7765), op `getTokenTradingInfo` |
| GET | `/api/v1/dex/market/candles` | `binanceChainId` _query_, `tokenContractAddress` _query_ | `bar` _query_, `after` _query_, `before` _query_, `limit` _query_ | not typed in connector | § API Reference › General Data › "Get Candles" (L7773), op `getCandles` |
| GET | `/api/v1/dex/market/token/search` | `chains` _query_, `search` _query_ | — | `[]` of: `binanceChainId`, `tokenName`, `tokenSymbol`, `tokenLogoUrl`, `tokenContractAddress`, `decimals`, `explorerUrl`, `change`, `holders`, `liquidity`, `marketCap`, `price`, `tagList{}` | § API Reference › General Data › "Search Token" (L7781), op `searchToken` |
| POST | `/api/v1/dex/market/token/basic-info` | `binanceChainId` _query_, `tokenContractAddress` _query_ | — | `binanceChainId`, `tokenContractAddress`, `tokenName`, `tokenSymbol`, `tokenLogoUrl`, `decimals`, `creatorAddress`, `createTime`, `tagList{}` | § API Reference › General Data › "Get Token Basic Info" (L7789), op `getTokenBasicInfo` |
| GET | `/api/v1/dex/market/token/advanced-info` | `binanceChainId` _query_, `tokenContractAddress` _query_ | — | `binanceChainId`, `tokenContractAddress`, `isInternal`, `protocolId`, `progress`, `createTime`, `creatorAddress`, `devCreatedTokenCount`, `devMigratedTokenCount`, `devMigratedTokenPercent`, `top10HoldingPercent`, `devHoldingPercent`, `smartMoneyHoldingPercent`, `kolHoldingPercent`, `bundlerHoldingPercent`, `proHoldingPercent`, `freshWalletHoldingPercent`, `sniperHoldingPercent`, `insiderHoldingPercent`, `holders`, `bnHolderCount`, `bnTraderCount7D`, `tokenTags[]` | § API Reference › General Data › "Get Token Advanced Info" (L7797), op `getTokenAdvancedInfo` |
| GET | `/api/v1/dex/market/token/hot-token` | `binanceChainId` _query_ | `rankBy` _query_, `rankingTimeFrame` _query_, `priceChangePercentMin` _query_, `priceChangePercentMax` _query_, `volumeMin` _query_, `volumeMax` _query_, `txsMin` _query_, `txsMax` _query_, `marketCapMin` _query_, `marketCapMax` _query_, `liquidityMin` _query_, `liquidityMax` _query_, `devHoldingPercentMin` _query_, `devHoldingPercentMax` _query_, `inflowUsdMin` _query_, `inflowUsdMax` _query_, `holdersMin` _query_, `holdersMax` _query_, `bnHolderCountMin` _query_, `bnHolderCountMax` _query_, `top10HoldingPercentMin` _query_, `top10HoldingPercentMax` _query_, `sniperHoldingPercentMin` _query_, `sniperHoldingPercentMax` _query_, `smartMoneyHoldingPercentMin` _query_, `smartMoneyHoldingPercentMax` _query_, `kolHoldingPercentMin` _query_, `kolHoldingPercentMax` _query_, `proHoldingPercentMin` _query_, `proHoldingPercentMax` _query_, `freshWalletHoldingPercentMin` _query_, `freshWalletHoldingPercentMax` _query_, `insiderHoldingPercentMin` _query_, `insiderHoldingPercentMax` _query_, `bundlerHoldingPercentMin` _query_, `bundlerHoldingPercentMax` _query_, `devCreatedTokenCountMin` _query_, `devCreatedTokenCountMax` _query_, `devMigratedTokenCountMin` _query_, `devMigratedTokenCountMax` _query_, `devMigratedTokenPercentMin` _query_, `devMigratedTokenPercentMax` _query_, `isDevSoldAll` _query_, `isDevBurned` _query_, `isMint` _query_, `isFreeze` _query_, `isHideWashTradingTokens` _query_, `isHideDevWashTradingTokens` _query_, `isHideInternalWashTradingTokens` _query_, `pageId` _query_, `size` _query_ | `page`, `items[]` | § API Reference › General Data › "Get Hot Token List" (L7805), op `getHotTokenList` |
| GET | `/api/v1/dex/market/token/holder` | `binanceChainId` _query_, `tokenContractAddress` _query_ | `tagFilter` _query_ | `[]` of: `holderWalletAddress`, `holdAmount`, `holdingPercent`, `nativeTokenSymbol`, `nativeTokenBalance`, `boughtAmount`, `avgBuyPrice`, `soldAmount`, `avgSellPrice`, `maxHoldAmount`, `lastTradeTime`, `realizedPnlUsd`, `fundingSource`, `fundingSourceLabel`, `fundingSourceHash`, `fundingSourceTime`, `fundingSourceAmount` | § API Reference › General Data › "Get Holders Ranking" (L7813), op `getHoldersRanking` |
| GET | `/api/v1/dex/market/token/top-trader` | `binanceChainId` _query_, `tokenContractAddress` _query_ | `tagFilter` _query_ | `[]` of: `holderWalletAddress`, `holdAmount`, `holdingPercent`, `boughtAmount`, `avgBuyPrice`, `soldAmount`, `avgSellPrice`, `maxHoldAmount`, `lastTradeTime`, `realizedPnlUsd`, `fundingSource`, `fundingSourceLabel`, `fundingSourceHash`, `fundingSourceTime`, `fundingSourceAmount` | § API Reference › General Data › "Get Top Traders" (L7821), op `getTopTraders` |
| GET | `/api/v1/dex/market/token/top-liquidity` | `binanceChainId` _query_, `tokenContractAddress` _query_ | — | `[]` of: `pool`, `protocolName`, `protocolLogoUrl`, `liquidityUsd`, `poolAddress`, `liquidityAmount[]` | § API Reference › General Data › "Get Top Liquidity Pools" (L7829), op `getTopLiquidityPools` |
| GET | `/api/v1/dex/market/trades` | `binanceChainId` _query_, `tokenContractAddress` _query_ | `cursor` _query_, `limit` _query_, `tagFilter` _query_, `walletAddressFilter` _query_ | `cursor`, `trades[]` | § API Reference › General Data › "Get Token Trades" (L7837), op `getTokenTrades` |
| GET | `/api/v1/dex/market/memepump/tokenDevInfo` | `binanceChainId` _query_, `tokenContractAddress` _query_ | — | `devLaunchedInfo{}`, `devHoldingInfo{}` | § API Reference › General Data › "Get Token Dev Info" (L7845), op `getTokenDevInfo` |

### Address Portfolio

| Method | Path | Required params | Optional params | Response `data` fields | Source (llms-full.txt) |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/dex/market/portfolio/supported/chain` | — | — | `[]` of: `binanceChainId`, `name`, `shortName`, `logoUrl`, `caseSensitive`, `nativeTokenSymbol`, `nativeTokenDecimals` | § API Reference › Address Portfolio › "Get Portfolio Supported Chains" (L7856), op `getPortfolioSupportedChains` |
| GET | `/api/v1/dex/market/portfolio/overview` | `binanceChainId` _query_, `walletAddress` _query_, `timeFrame` _query_ | — | `realizedPnlUsd`, `realizedPnlPercent`, `dailyPnl[]`, `winRate`, `tokenCountByPnlPercent{}`, `buyTxCount`, `sellTxCount`, `totalTokenCount`, `buyTxVolume`, `sellTxVolume`, `avgBuyValueUsd`, `top3PnlTokenSumUsd`, `top3PnlTokenPercent`, `topPnlTokenList[]` | § API Reference › Address Portfolio › "Get Address Portfolio Overview" (L7864), op `getAddressPortfolioOverview` |
| GET | `/api/v1/dex/market/portfolio/recent-pnl` | `binanceChainId` _query_, `walletAddress` _query_ | `cursor` _query_, `limit` _query_ | `cursor`, `pnlList[]` | § API Reference › Address Portfolio › "Get Address Recent PnL" (L7872), op `getAddressRecentPnL` |
| GET | `/api/v1/dex/market/portfolio/token/latest-pnl` | `binanceChainId` _query_, `walletAddress` _query_, `tokenContractAddress` _query_ | — | `realizedPnlUsd`, `realizedPnlPercent`, `buyTxVolume`, `buyAmount`, `buyTxCount`, `sellTxVolume`, `sellAmount`, `sellTxCount`, `buyAvgPrice`, `sellAvgPrice`, `tokenBalanceUsd`, `tokenBalanceAmount`, `maxBalanceAmount`, `holdingDuration`, `isPnlSupported` | § API Reference › Address Portfolio › "Get Address PnL for Specific Token" (L7880), op `getAddressPnLForSpecificToken` |
| GET | `/api/v1/dex/market/portfolio/dex-history` | `binanceChainId` _query_, `walletAddress` _query_ | `begin` _query_, `end` _query_, `tokenContractAddress` _query_, `type` _query_, `cursor` _query_, `limit` _query_ | `cursor`, `transactionList[]` | § API Reference › Address Portfolio › "Get DEX Trade History" (L7888), op `getDexTradeHistory` |
| GET | `/api/v1/dex/market/leaderboard/list` | `binanceChainId` _query_, `timeFrame` _query_, `sortBy` _query_ | `walletType` _query_, `minRealizedPnlUsd` _query_, `maxRealizedPnlUsd` _query_, `minWinRatePercent` _query_, `maxWinRatePercent` _query_, `minTxs` _query_, `maxTxs` _query_, `minTxVolume` _query_, `maxTxVolume` _query_, `cursor` _query_, `limit` _query_ | `cursor`, `items[]` | § API Reference › Address Portfolio › "Get Leaderboard" (L7896), op `getLeaderboard` |
| GET | `/api/v1/dex/market/address-tracker/trades` | `trackerType` _query_ | `walletAddress` _query_, `tradeType` _query_, `binanceChainId` _query_, `minVolume` _query_, `maxVolume` _query_, `minMarketCap` _query_, `maxMarketCap` _query_, `isHideRiskToken` _query_, `limit` _query_ | `trades[]` | § API Reference › Address Portfolio › "Get Tracked Trades" (L7904), op `getTrackedTrades` |

### RWA Data

| Method | Path | Required params | Optional params | Response `data` fields | Source (llms-full.txt) |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/dex/market/rwa/platforms` | — | `platformId` _query_ | `[]` of: `platformId`, `tickerCount`, `chainDistribution[]`, `website`, `logoUrl` | § API Reference › RWA Data › "Get RWA Token Issuance Platforms" (L7915), op `getRwaTokenIssuancePlatforms` |
| GET | `/api/v1/dex/market/rwa/price` | `binanceChainId` _query_, `tokenContractAddresses` _query_ | — | `[]` of: `binanceChainId`, `tokenContractAddress`, `platformId`, `tokenPrice`, `referencePrice`, `tokenPriceUpdatedAt` | § API Reference › RWA Data › "Get RWA Token Price" (L7923), op `getRwaTokenPrice` |
| GET | `/api/v1/dex/market/rwa/search` | `keyword` _query_ | `platformId` _query_ | `[]` of: `ticker`, `companyName`, `assets[]` | § API Reference › RWA Data › "Search RWA Token" (L7931), op `searchRwaToken` |
| GET | `/api/v1/dex/market/rwa/underlying-profile` | `binanceChainId` _query_, `tokenContractAddress` _query_ | — | `binanceChainId`, `tokenContractAddress`, `platformId`, `underlyingTicker`, `underlyingFullName`, `assetType`, `tokenToShareRatio`, `protections`, `companyInfo` | § API Reference › RWA Data › "Get RWA Underlying Info" (L7939), op `getRwaUnderlyingInfo` |
| GET | `/api/v1/dex/market/rwa/tokens` | — | `binanceChainId` _query_, `platformId` _query_, `tabId` _query_ | `[]` of: `binanceChainId`, `tokenContractAddress`, `platformId`, `assetType`, `tokenName`, `tokenSymbol`, `tokenLogoUrl`, `decimals`, `underlyingTicker`, `underlyingName`, `underlyingNameZh`, `tokenToShareRatio`, `tags`, `statusInfo{}`, `tokenPrice`, `referencePrice`, `volume24H`, `marketCap`, `peRatioTTM` | § API Reference › RWA Data › "Get RWA Token List" (L7947), op `getRwaTokenList` |
| GET | `/api/v1/dex/market/rwa/underlying-market` | `binanceChainId` _query_, `tokenContractAddress` _query_ | — | `binanceChainId`, `tokenContractAddress`, `platformId`, `assetType`, `statusInfo{}`, `marketData{}` | § API Reference › RWA Data › "Get RWA Underlying Market Data" (L7955), op `getRwaUnderlyingMarketData` |

### Trading API

| Method | Path | Required params | Optional params | Response `data` fields | Source (llms-full.txt) |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/dex/aggregator/supported/chain` | — | `binanceChainId` _query_ | `[]` of: `binanceChainId`, `name`, `shortName`, `logoUrl` | § API Reference › Trading API › "Get Aggregator Supported Chains" (L7966), op `getAggregatorSupportedChains` |
| GET | `/api/v1/dex/aggregator/approve-transaction` | `binanceChainId` _query_, `tokenContractAddress` _query_, `approveAmount` _query_ | `vendor` _query_ | `[]` of: `data`, `dexContractAddress`, `gasLimit`, `gasPrice` | § API Reference › Trading API › "Get ERC-20 Approve Transaction" (L7975), op `getErc20ApproveTransaction` |
| GET | `/api/v1/dex/aggregator/quote` | `binanceChainId` _query_, `amount` _query_, `fromTokenAddress` _query_, `toTokenAddress` _query_ | `vendor` _query_, `userWalletAddress` _query_, `feePercent` _query_, `feeSource` _query_ | `[]` of: `quoteId`, `vendorName`, `binanceChainId`, `fromTokenAmount`, `toTokenAmount`, `tradeFee`, `estimateGasFee`, `priceImpactPercent`, `router`, `fromToken{}`, `toToken{}`, `dexRouterList[]`, `executionMode`, `approveTarget`, `isBest`, `feeAmount`, `feeToken`, `actualSwapAmount` | § API Reference › Trading API › "Get Aggregated Quote" (L7983), op `getAggregatedQuote` |
| GET | `/api/v1/dex/aggregator/swap` | `binanceChainId` _query_, `amount` _query_, `fromTokenAddress` _query_, `toTokenAddress` _query_, `userWalletAddress` _query_, `quoteId` _query_ | `slippagePercent` _query_, `approveTransaction` _query_, `approveAmount` _query_, `gasLimit` _query_, `gasLevel` _query_, `priceImpactProtectionPercent` _query_, `autoSlippage` _query_, `maxAutoSlippagePercent` _query_, `computeUnitLimit` _query_, `computeUnitPrice` _query_, `tips` _query_, `feePercent` _query_, `fromTokenReferrerWalletAddress` _query_, `toTokenReferrerWalletAddress` _query_ | `routerResult{}`, `tx{}`, `executionMode`, `rfq` | § API Reference › Trading API › "Build Swap Transaction" (L7991), op `buildSwapTransaction` |
| GET | `/api/v1/dex/aggregator/quote-and-swap` | `binanceChainId` _query_, `amount` _query_, `fromTokenAddress` _query_, `toTokenAddress` _query_, `userWalletAddress` _query_, `vendor` _query_ | `slippagePercent` _query_, `excludeDexes` _query_, `enableRFQ` _query_, `approveTransaction` _query_, `approveAmount` _query_, `gasLimit` _query_, `gasLevel` _query_, `priceImpactProtectionPercent` _query_, `autoSlippage` _query_, `maxAutoSlippagePercent` _query_, `computeUnitLimit` _query_, `computeUnitPrice` _query_, `tips` _query_, `feePercent` _query_, `fromTokenReferrerWalletAddress` _query_, `toTokenReferrerWalletAddress` _query_ | `routerResult{}`, `tx{}`, `executionMode`, `rfq` | § API Reference › Trading API › "Quote and Build Swap Transaction (Flash API)" (L7999), op `quoteAndBuildSwapTransaction` |
| GET | `/api/v1/dex/aggregator/swap-instruction` | `binanceChainId` _query_, `amount` _query_, `fromTokenAddress` _query_, `toTokenAddress` _query_, `slippagePercent` _query_, `userWalletAddress` _query_, `quoteId` _query_ | `priceImpactProtectionPercent` _query_, `autoSlippage` _query_, `maxAutoSlippagePercent` _query_, `computeUnitLimit` _query_, `computeUnitPrice` _query_, `gasLevel` _query_, `tips` _query_, `feePercent` _query_, `fromTokenReferrerWalletAddress` _query_, `toTokenReferrerWalletAddress` _query_ | `addressLookupTableAccount[]`, `instructionLists[]`, `routerResult{}`, `tx{}` | § API Reference › Trading API › "Build Solana Swap Instructions" (L8008), op `buildSolanaSwapInstructions` |
| GET | `/api/v1/dex/aggregator/history` | `binanceChainId` _query_, `txHash` _query_ | — | not typed in connector | § API Reference › Trading API › "Get Transaction Status" (L8027), op `getTransactionStatus` |
| POST | `/api/v1/dex/aggregator/order/submit` | `requestId` _body_, `userSignature` _body_, `vendor` _body_, `quoteId` _body_ | `signingScheme` _body_ | `orderId`, `status`, `createdAt` | § API Reference › Trading API › "Submit RFQ Order" (L8043), op `submitRfqOrder` |
| GET | `/api/v1/dex/aggregator/order/{orderId}` | `orderId` _path+body_ | — | `orderId`, `status`, `txHash`, `fromAmount`, `toAmount`, `filledAt`, `createdAt` | § API Reference › Trading API › "Get RFQ Order Status" (L8055), op `getRfqOrderStatus` |

### Transaction API

| Method | Path | Required params | Optional params | Response `data` fields | Source (llms-full.txt) |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/dex/pre-transaction/supported/chain` | — | — | `[]` of: `binanceChainId`, `name`, `shortName`, `logoUrl` | § API Reference › Transaction API › "Get Transaction Supported Chains" (L8066), op `getTransactionSupportedChains` |
| GET | `/api/v1/dex/pre-transaction/gas-price` | `binanceChainId` _query_ | — | `evmLegacyGasPrice`, `eip1559GasPrice`, `solanaGasPrice` | § API Reference › Transaction API › "Get Gas Price" (L8074), op `getGasPrice` |
| GET | `/api/v1/dex/pre-transaction/block-height` | `binanceChainId` _query_ | — | `binanceChainId`, `blockHeight` | § API Reference › Transaction API › "Get Latest Block Height" (L8088), op `getLatestBlockHeight` |
| POST | `/api/v1/dex/pre-transaction/gas-limit` | `binanceChainId` _body_, `evmTx{}` (from*, to*, value*, data*) _body_, `solTx{}` (base64Tx*) _body_, `tronTx{}` (from*, txType*, triggerSmartContractParams, transferContractParams) _body_ | — | `gasLimit`, `energyRequired`, `bandwidthRequired`, `freeEnergy`, `freeBandwidth`, `energyFee`, `bandwidthFee` | § API Reference › Transaction API › "Get Gas Limit" (L8096), op `getGasLimit` |
| POST | `/api/v1/dex/pre-transaction/simulate` | `binanceChainId` _body_, `evmTx{}` (from*, to*, value*, data*) _body_, `solTx{}` (base64Tx*, address) _body_, `tronTx{}` (from*, txType*, triggerSmartContractParams, transferContractParams) _body_ | — | `status`, `failReason`, `balanceChanges[]`, `allowanceChanges[]` | § API Reference › Transaction API › "Simulate Transactions" (L8106), op `simulateTransactions` |
| POST | `/api/v1/dex/pre-transaction/broadcast-transaction` | `binanceChainId` _body_, `signedTransaction` _body_, `address` _body_ | `enableMevProtection` _body_ | `orderId`, `txHash` | § API Reference › Transaction API › "Broadcast Transactions" (L8116), op `broadcastTransactions` |
| GET | `/api/v1/dex/post-transaction/orders` | `address` _query_, `binanceChainId` _query_ | `txStatus` _query_, `orderId` _query_, `cursor` _query_, `limit` _query_ | `cursor`, `orders[]` | § API Reference › Transaction API › "Get Broadcast Orders" (L8125), op `getBroadcastOrders` |

### Wallet API

| Method | Path | Required params | Optional params | Response `data` fields | Source (llms-full.txt) |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/dex/balance/supported/chain` | — | `binanceChainId` _query_ | `[]` of: `binanceChainId`, `name`, `shortName`, `logoUrl` | § API Reference › Wallet API › "Get Wallet Supported Chains" (L8136), op `getWalletSupportedChains` |
| GET | `/api/v1/dex/balance/all-token-balances-by-address` | — | `address` _query_, `chains` _query_, `excludeRiskToken` _query_, `page` _query_, `pageSize` _query_ | `[]` of: `page`, `pageSize`, `tokenAssets[]` | § API Reference › Wallet API › "Get All Token Balances by Address" (L8144), op `getAllTokenBalancesByAddress` |
| POST | `/api/v1/dex/balance/token-balances-by-address` | `address` _body_, `tokenContractAddresses[]` (binanceChainId*, tokenContractAddress*) _body_ | `excludeRiskToken` _body_ | `[]` of: `tokenAssets[]` | § API Reference › Wallet API › "Get Token Balances by Address" (L8152), op `getTokenBalancesByAddress` |
| GET | `/api/v1/dex/post-transaction/transactions-by-address` | `address` _query_, `chains` _query_ | `tokenContractAddress` _query_, `begin` _query_, `end` _query_, `cursor` _query_, `limit` _query_ | `[]` of: `cursor`, `transactionList[]` | § API Reference › Wallet API › "Get Transactions by Address" (L8160), op `getTransactionsByAddress` |
| GET | `/api/v1/dex/post-transaction/transaction-detail-by-txhash` | — | `binanceChainId` _query_, `txHash` _query_, `itype` _query_ | `[]` of: `chainIndex`, `height`, `txTime`, `txhash`, `txStatus`, `gasLimit`, `gasUsed`, `gasPrice`, `txFee`, `nonce`, `amount`, `symbol`, `methodId`, `l1OriginHash`, `fromDetails[]`, `toDetails[]`, `internalTransactionDetails[]`, `tokenTransferDetails[]` | § API Reference › Wallet API › "Get Transaction Detail by Hash" (L8168), op `getTransactionDetailByHash` |

### Defi Data

| Method | Path | Required params | Optional params | Response `data` fields | Source (llms-full.txt) |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/defi/data/position/list` | `addresses[]` _body_ | `binanceChainIds[]` _body_ | `totalValue`, `addressList[]` | § API Reference › Defi Data › "Get DeFi Positions" (L8179), op `getDeFiPositions` |
| POST | `/api/v1/defi/data/protocol/list` | — | `binanceChainId` _body_, `investType` _body_, `sortField` _body_, `sortDirection` _body_, `page` _body_, `size` _body_ | `page`, `size`, `total`, `list[]` | § API Reference › Defi Data › "List DeFi Protocols" (L8188), op `listDeFiProtocols` |
| POST | `/api/v1/defi/data/protocol/detail` | `defiProtocolId` _body_ | — | `defiProtocolId`, `protocolName`, `protocolLogo`, `description`, `websiteUrl`, `investType[]`, `supportedChains[]`, `tvl`, `tags[]`, `founded`, `fdv`, `totalFunding`, `socialLinks{}`, `team[]`, `fundRaising[]`, `securityScore`, `dimensionScores{}`, `highlights[]`, `faq[]` | § API Reference › Defi Data › "Get Protocol Detail" (L8196), op `getProtocolDetail` |
| POST | `/api/v1/defi/data/investment/list` | `investType` _body_ | `defiProtocolId` _body_, `tokenAddressList[]` _body_, `binanceChainId` _body_, `sortField` _body_, `sortDirection` _body_, `page` _body_, `size` _body_ | `page`, `size`, `total`, `list[]` | § API Reference › Defi Data › "List DeFi Investments" (L8204), op `listDeFiInvestments` |
| POST | `/api/v1/defi/data/investment/detail` | `investmentId` _body_ | — | `binanceChainId`, `defiProtocolId`, `protocolName`, `protocolLogo`, `investmentId`, `investmentName`, `investType`, `investable`, `apyBps`, `apyDisplay`, `apyType`, `tvl`, `poolAddress`, `feeRate`, `assetTokenList[]`, `rewardTokenList[]`, `lpTokenList[]`, `borrowTokenList[]` | § API Reference › Defi Data › "Get Investment Detail" (L8212), op `getInvestmentDetail` |

### Defi Transaction

| Method | Path | Required params | Optional params | Response `data` fields | Source (llms-full.txt) |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/defi/transaction/deposit` | `address` _body_, `investmentId` _body_, `token{}` (tokenAddress*, amount*) _body_ | `simulate` _body_ | `dataList[]`, `preview{}`, `redeemDelayDays[]` | § API Reference › Defi Transaction › "Build DeFi Deposit Transaction" (L8223), op `buildDeFiDepositTransaction` |
| POST | `/api/v1/defi/transaction/redeem` | `address` _body_, `investmentId` _body_ | `token{}` (tokenAddress*, amount*) _body_, `ratio` _body_, `slippageBps` _body_, `simulate` _body_ | `dataList[]`, `preview{}`, `redeemDelayDays[]` | § API Reference › Defi Transaction › "Build DeFi Redeem Transaction" (L8232), op `buildDeFiRedeemTransaction` |
| POST | `/api/v1/defi/transaction/lp-add` | `address` _body_, `investmentId` _body_, `tokenList[]` (tokenAddress*, amount*) _body_ | `tickLower` _body_, `tickUpper` _body_, `priceRange` _body_, `nftId` _body_, `slippageBps` _body_, `simulate` _body_ | `dataList[]`, `preview{}`, `redeemDelayDays[]` | § API Reference › Defi Transaction › "Build LP Add Transaction" (L8252), op `buildLpAddTransaction` |
| POST | `/api/v1/defi/transaction/lp-add/calculate` | `address` _body_, `investmentId` _body_, `inputToken{}` (tokenAddress*, amount*) _body_ | `tickLower` _body_, `tickUpper` _body_, `priceRange` _body_, `nftId` _body_ | `inputTokenAmount`, `pairedTokenAddress`, `pairedTokenAmount` | § API Reference › Defi Transaction › "Calculate LP Add Paired Amounts" (L8273), op `calculateLpAddPairedAmounts` |
| POST | `/api/v1/defi/transaction/lp-remove` | `address` _body_, `investmentId` _body_, `nftId` _body_, `ratio` _body_ | `slippageBps` _body_, `simulate` _body_ | `dataList[]`, `preview{}`, `redeemDelayDays[]` | § API Reference › Defi Transaction › "Build LP Remove Transaction" (L8287), op `buildLpRemoveTransaction` |
| POST | `/api/v1/defi/transaction/claim` | `address` _body_, `claimType` _body_ | `binanceChainId` _body_, `investmentId` _body_, `defiProtocolId` _body_, `nftId` _body_, `redemptionId` _body_, `tokenAddressList[]` _body_, `simulate` _body_ | `dataList[]`, `preview{}`, `redeemDelayDays[]` | § API Reference › Defi Transaction › "Build DeFi Claim Transaction" (L8296), op `buildDeFiClaimTransaction` |

### B402 Payments

| Method | Path | Required params | Optional params | Response `data` fields | Source (llms-full.txt) |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v2/b402/supported` | `body` _body_ | — | (envelope: status, type, code, errorData, data, subData, params) `kinds[]`, `extensions[]`, `signers` | § API Reference › B402 Payments › "Get B402 Supported Configurations V2" (L8316), op `getB402SupportedConfigurationsV2` |
| POST | `/api/v2/b402/verify` | `body{}` (x402Version*, paymentPayload*, paymentRequirements*) _body_ | — | (envelope: status, type, code, errorData, data, subData, params) `isValid`, `payer`, `invalidReason`, `invalidMessage` | § API Reference › B402 Payments › "Verify B402 Payment V2" (L8324), op `verifyB402PaymentV2` |
| POST | `/api/v2/b402/settle` | `body{}` (x402Version*, paymentPayload*, paymentRequirements*, settleAmount) _body_ | — | (envelope: status, type, code, errorData, data, subData, params) `success`, `transaction`, `payer`, `network`, `amount`, `errorReason`, `errorMessage`, `extensions` | § API Reference › B402 Payments › "Settle B402 Payment V2" (L8332), op `settleB402PaymentV2` |
| POST | `/api/v1/b402/supported` | `body` _body_ | — | (envelope: status, type, code, errorData, data, subData, params) `kinds[]`, `extensions[]`, `signers` | § API Reference › B402 Payments › "Get B402 Supported Configurations V1" (L8340), op `getB402SupportedConfigurationsV1` |
| POST | `/api/v1/b402/verify` | `body{}` (x402Version*, paymentPayload*, paymentRequirements*) _body_ | — | (envelope: status, type, code, errorData, data, subData, params) `isValid`, `payer`, `invalidReason`, `invalidMessage` | § API Reference › B402 Payments › "Verify B402 Payment V1" (L8348), op `verifyB402PaymentV1` |
| POST | `/api/v1/b402/settle` | `body{}` (x402Version*, paymentPayload*, paymentRequirements*, settleAmount) _body_ | — | (envelope: status, type, code, errorData, data, subData, params) `success`, `transaction`, `payer`, `network`, `amount`, `confirmations`, `errorReason`, `errorMessage` | § API Reference › B402 Payments › "Settle B402 Payment V1" (L8356), op `settleB402PaymentV1` |

### WebSocket API

| Method | Path | Required params | Optional params | Response `data` fields | Source (llms-full.txt) |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/dex/market/wss/auth/token` | — | — | `token` | § API Reference › WebSocket API › "Get WebSocket Auth Token" (L8367), op `getWebSocketAuthToken` |

### Doc ↔ connector anomalies (auto-detected)

- `getTokenPrice` (POST /api/v1/dex/market/price): the connector has no body parameters, so its typed method always sends an empty body.
- `getTokenTradingInfo` (POST /api/v1/dex/market/price-info): the connector has no body parameters, so its typed method always sends an empty body.
- `getTokenBasicInfo` (POST /api/v1/dex/market/token/basic-info): the connector has no body parameters, so its typed method always sends an empty body.
- `getRfqOrderStatus` (GET /api/v1/dex/aggregator/order/{orderId}): the connector also puts `orderId` in a JSON body and signs it, while Authentication says GET bodies sign as "".

<!-- END GENERATED -->
