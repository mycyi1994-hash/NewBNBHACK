/**
 * pnpm live:check [--usd 1] — the read-only preflight before the small live test
 * (docs/LIVE_TEST.md): config, the database, the worker's last status and the public BSC RPC.
 * It never calls the Binance Web3 API, never signs and never writes. Prints each check and GO,
 * or NO-GO with exit code 1. The rules are in live-check-rules.ts (tested).
 */
import { createRuntime, viemChainPort } from '@yieldvest/agent';
import { assertBscChain, BSC_USDT } from '@yieldvest/chain';
import { loadConfig } from '@yieldvest/config';
import {
  getPlan,
  isoTime,
  listApiCalls,
  listInstruments,
  openGuardianActions,
  planFromRow,
  readWorkerStatus,
  unsettledOutbox,
} from '@yieldvest/db';
import { liveChecks, type LiveCheckFacts } from './live-check-rules.js';

const MARK = { ok: '✓', warn: '!', fail: '✗' } as const;
const args = process.argv.slice(2).filter((a) => a !== '--');
const usdFlag = args.indexOf('--usd');
const testUsd = usdFlag >= 0 ? (args[usdFlag + 1] ?? '') : '1';
const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
/** Error labels only: a raw driver message can carry the host. */
const label = (error: unknown) =>
  (error as { code?: unknown }).code !== undefined
    ? `code ${String((error as { code: unknown }).code)}`
    : 'unreachable';

if (!/^\d+(\.\d{1,2})?$/.test(testUsd)) {
  console.log('usage: pnpm live:check [--usd <dollars, default 1>]');
  process.exitCode = 2;
} else {
  const config = loadConfig();
  if (!config.databaseUrl) {
    console.log(`  ${MARK.fail} database  no DATABASE_URL here`);
    console.log('NO-GO: database');
    process.exitCode = 1;
  } else {
    const rt = createRuntime(config);
    const db = rt.database.db;
    const chain = viemChainPort(rt.bsc);
    const now = new Date();
    try {
      const [safeRow, yieldRow] = await Promise.all([
        getPlan(db, 'H-SAFE'),
        getPlan(db, 'H-YIELD'),
      ]);
      const [tick, tape, venus] = await Promise.all([
        readWorkerStatus(db, 'tick'),
        readWorkerStatus(db, 'tape'),
        readWorkerStatus(db, 'venus'),
      ]);
      const house = rt.houseAddress;
      const vToken = text(venus?.value.vToken);
      const guardian = [
        ...(await openGuardianActions(db, 'H-SAFE')),
        ...(await openGuardianActions(db, 'H-YIELD')),
      ];
      const tickAt = text(tick?.value.at);
      const facts: LiveCheckFacts = {
        now,
        testUsd,
        config: {
          executionMode: config.executionMode,
          minBuyUsd: String(config.caps.minBuyUsd),
          apiCredentials:
            config.binance.apiKey !== undefined && config.binance.apiSecret !== undefined,
          houseKey: house !== undefined,
          telegram:
            config.telegram.botToken !== undefined && config.telegram.opsChatId !== undefined,
        },
        safe: safeRow ? planFromRow(safeRow) : undefined,
        yield: yieldRow ? planFromRow(yieldRow) : undefined,
        unsettled: (await unsettledOutbox(db)).map((tx) => tx.txHash),
        worker: {
          ...(tickAt ? { tick: { at: tickAt, mode: text(tick?.value.mode) ?? '?' } } : {}),
          ...(text(tape?.value.slotAt) ? { tapeSlotAt: text(tape?.value.slotAt) } : {}),
          ...(text(venus?.value.verifiedAt)
            ? { venusVerifiedAt: text(venus?.value.verifiedAt) }
            : {}),
        },
        house: house
          ? await Promise.all([chain.balanceOf(BSC_USDT, house), chain.nativeBalance(house)]).then(
              ([usdtUnits, bnbWei]) => ({ usdtUnits, bnbWei }),
              (error: unknown) => ({ error: `rpc ${label(error)}` }),
            )
          : undefined,
        venus: vToken
          ? await chain.venusMarketState(vToken).then(
              ({ mintPaused, redeemPaused }) => ({ mintPaused, redeemPaused }),
              (error: unknown) => ({ error: `rpc ${label(error)}` }),
            )
          : undefined,
        guardian: guardian.filter(
          (g, i) => guardian.findIndex((o) => o.rule === g.rule && o.action === g.action) === i,
        ),
        registry: (await listInstruments(db)).map((i) => ({
          ticker: i.ticker,
          issuer: i.issuer,
          verifiedAt: isoTime(i.verifiedAt),
        })),
        apiCodes: (await listApiCalls(db, new Date(now.getTime() - 60 * 60_000))).map(
          (c) => c.code,
        ),
      };
      const { checks, go: rulesGo } = liveChecks(facts);
      // Every RPC behind the client must be BSC mainnet (the message names hosts, never paths).
      const chainProblem = await assertBscChain(rt.bsc).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : 'unknown'),
      );
      checks.push(
        chainProblem === undefined
          ? { name: 'rpc chain', mark: 'ok', detail: 'every RPC answers chain id 56' }
          : { name: 'rpc chain', mark: 'fail', detail: chainProblem },
      );
      const go = rulesGo && chainProblem === undefined;
      console.log(`live:check — $${testUsd} test, ${now.toISOString()}`);
      for (const check of checks) {
        console.log(`  ${MARK[check.mark]} ${check.name.padEnd(9)} ${check.detail}`);
      }
      const failing = checks.filter((c) => c.mark === 'fail').map((c) => c.name);
      const warning = checks.filter((c) => c.mark === 'warn').map((c) => c.name);
      if (go) {
        console.log(`GO${warning.length ? ` (read the warnings: ${warning.join(', ')})` : ''}`);
      } else {
        console.log(`NO-GO: ${failing.join(', ')}`);
        process.exitCode = 1;
      }
    } catch (error) {
      console.log(`  ${MARK.fail} database  unreadable (${label(error)}) — pnpm db:migrate?`);
      console.log('NO-GO: database');
      process.exitCode = 1;
    } finally {
      await rt.close();
    }
  }
}
