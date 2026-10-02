/**
 * pnpm agent:register [--site <url>] [--broadcast] — the Yieldvest agent's ERC-8004 identity on
 * BNB Smart Chain (DECISIONS D-33, TASKS M2-10).
 *
 * Reads the registration file the site serves at /api/agent (--site, default NEXT_PUBLIC_APP_URL)
 * and makes the chain hold exactly that file, one transaction per run — BNB Agent Studio's
 * two-phase registration: `register(agentURI)` while AGENT_ID is unset; then, once AGENT_ID is the
 * id that call printed (here and on the web deploy, so the file names its registry entry),
 * `setAgentURI(id, agentURI)`. With the chain already holding the site's file it says so and sends
 * nothing — the same command checks the registration later.
 *
 * Signs only with AGENT_IDENTITY_PRIVATE_KEY, a wallet of its own (the config refuses the house
 * key); the transaction spends gas and nothing else. Without --broadcast everything up to signing
 * is real: the BSC chain check, the registry's code, name and symbol, what the wallet already
 * holds, the call run by eth_call and simulated by the Transaction API, the gas estimate and the
 * fee. --broadcast also needs a public https site, a successful Transaction API simulation, a fee
 * within IDENTITY_MAX_FEE_WEI that the wallet can pay, no pending transaction of the wallet, and a
 * typed `y`. Exit: 0 done or nothing to do · 1 failed or refused · 2 usage.
 */
import { createRuntime } from '@yieldvest/agent';
import { BinanceApiError, broadcastSigned, simulateCall } from '@yieldvest/binance';
import {
  agentUri,
  assertBscChain,
  ERC8004_REGISTRY_BSC,
  identityRegistryAbi,
  parseRegistrationFile,
  registeredAgent,
  signableTx,
} from '@yieldvest/chain';
import { loadConfig } from '@yieldvest/config';
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  bnb,
  broadcastRefusals,
  fileProblem,
  nextStep,
  paddedGas,
  registeredProblem,
  siteProblem,
} from './agent-register-rules.js';
import { parseFlags } from './args.js';
import { confirmSpend } from './confirm.js';

const RECEIPT_TIMEOUT_MS = 180_000;
const REGISTRY = ERC8004_REGISTRY_BSC;
const ALREADY_KNOWN = /already known|known transaction|nonce too low/i;

/** viem's one-line reason, never its full message (an RPC URL can carry a key). */
const reasonOf = (error: unknown) =>
  error instanceof BaseError ? error.shortMessage : String(error).split('\n')[0];

/** True for a revert of the call itself (a missing agent), false for an RPC that failed. */
const reverted = (error: unknown) =>
  error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError);

const flags = parseFlags(process.argv.slice(2), { values: ['site'], switches: ['broadcast'] });

async function main(): Promise<number> {
  if (!flags.ok) {
    console.log(`${flags.error}\nusage: pnpm agent:register [--site <url>] [--broadcast]`);
    return 2;
  }
  const { broadcast } = flags.switches;
  const config = loadConfig();
  const key = config.agent.identityPrivateKey;
  if (!key) {
    console.log(
      'refused: AGENT_IDENTITY_PRIVATE_KEY is not set — a fresh wallet of its own, never the house key',
    );
    return 1;
  }
  const account = privateKeyToAccount(key);
  const identity = account.address;
  const agentId = config.agent.id;
  const site = flags.values.site ?? config.appUrl;
  const badSite = siteProblem(site, false);
  if (badSite) {
    console.log(`refused: ${badSite}`);
    return 1;
  }

  // The file exactly as the site serves it: what goes on chain is what anyone can read there.
  const source = new URL('/api/agent', site).href;
  const res = await fetch(source, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  }).catch((error: unknown) => {
    // fetch says only "fetch failed"; the cause names it (ECONNREFUSED, a timeout, DNS).
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    console.log(`refused: ${source} did not answer (${reasonOf(cause)})`);
    return null;
  });
  if (!res) return 1;
  if (!res.ok) {
    console.log(`refused: ${source} answered HTTP ${res.status}`);
    return 1;
  }
  const file = parseRegistrationFile(await res.json());
  const wrongFile = fileProblem(file, site, agentId);
  if (wrongFile) {
    console.log(`refused: ${wrongFile}`);
    return 1;
  }
  const uri = agentUri(file);
  console.log(`agent:register — the file at ${source} (${uri.length} bytes as an agent URI):`);
  console.log(JSON.stringify(file, null, 2));
  console.log(
    `identity wallet ${identity}${agentId ? `, AGENT_ID ${agentId}` : ', no AGENT_ID yet'}`,
  );

  const rt = createRuntime(config);
  try {
    await assertBscChain(rt.bsc);
    const [block, code, name, symbol, held] = await Promise.all([
      rt.bsc.getBlockNumber(),
      rt.bsc.getCode({ address: REGISTRY }),
      rt.bsc.readContract({ address: REGISTRY, abi: identityRegistryAbi, functionName: 'name' }),
      rt.bsc.readContract({ address: REGISTRY, abi: identityRegistryAbi, functionName: 'symbol' }),
      rt.bsc.readContract({
        address: REGISTRY,
        abi: identityRegistryAbi,
        functionName: 'balanceOf',
        args: [identity],
      }),
    ]);
    if (!code || code === '0x') throw new Error(`no contract at the registry ${REGISTRY}`);
    if (name !== 'AgentIdentity' || symbol !== 'AGENT') {
      throw new Error(`the registry is "${name}"/"${symbol}", not "AgentIdentity"/"AGENT"`);
    }
    let owner: string | null | undefined;
    let onChainUri: string | undefined;
    if (agentId !== undefined) {
      const id = BigInt(agentId);
      owner = await rt.bsc
        .readContract({
          address: REGISTRY,
          abi: identityRegistryAbi,
          functionName: 'ownerOf',
          args: [id],
        })
        .catch((error: unknown) => {
          if (reverted(error)) return null;
          throw error;
        });
      if (owner) {
        onChainUri = await rt.bsc.readContract({
          address: REGISTRY,
          abi: identityRegistryAbi,
          functionName: 'tokenURI',
          args: [id],
        });
      }
    }
    const step = nextStep({ identity, agentId, held, owner, onChainUri, uri });
    console.log(
      `registry ${REGISTRY} (${name}/${symbol}) at block ${block}; the wallet holds ${held} agent identit${held === 1n ? 'y' : 'ies'}`,
    );
    if (step.kind === 'refused') {
      console.log(`refused: ${step.reason}`);
      return 1;
    }
    if (step.kind === 'current') {
      console.log(
        `current: agent ${step.agentId} on chain holds the site's file byte for byte — nothing to send`,
      );
      return 0;
    }

    const data =
      step.kind === 'register'
        ? encodeFunctionData({ abi: identityRegistryAbi, functionName: 'register', args: [uri] })
        : encodeFunctionData({
            abi: identityRegistryAbi,
            functionName: 'setAgentURI',
            args: [step.agentId, uri],
          });
    const label =
      step.kind === 'register' ? 'register(agentURI)' : `setAgentURI(${step.agentId}, agentURI)`;

    // The call as the chain would run it now, from the identity wallet.
    let callProblem: string | undefined;
    try {
      const result = await rt.bsc.call({ account: identity, to: REGISTRY, data });
      const would =
        step.kind === 'register' && result.data
          ? `: it would be agent ${decodeFunctionResult({ abi: identityRegistryAbi, functionName: 'register', data: result.data })} at this block`
          : '';
      console.log(`eth_call ${label}: ok${would}`);
    } catch (error) {
      callProblem = `eth_call ${label} reverted: ${reasonOf(error)}`;
      console.log(callProblem);
    }
    const [estimate, gasPrice, balance, latestNonce, pendingNonce] = await Promise.all([
      callProblem
        ? Promise.resolve(0n)
        : rt.bsc.estimateGas({ account: identity, to: REGISTRY, data }),
      rt.bsc.getGasPrice(),
      rt.bsc.getBalance({ address: identity }),
      rt.bsc.getTransactionCount({ address: identity, blockTag: 'latest' }),
      rt.bsc.getTransactionCount({ address: identity, blockTag: 'pending' }),
    ]);
    const gas = paddedGas(estimate);

    // Rule 5: the Transaction API simulates every transaction before it is signed.
    let simulation: 'SUCCESS' | 'FAILED' | 'skipped' = 'skipped';
    if (config.binance.apiKey && config.binance.apiSecret) {
      try {
        const sim = await simulateCall(rt.client, {
          from: identity,
          to: REGISTRY,
          value: '0',
          data,
        });
        simulation = sim.status;
        console.log(
          `Transaction API simulation: ${sim.status}${sim.failReason ? ` (${sim.failReason})` : ''}`,
        );
      } catch (error) {
        simulation = 'FAILED';
        console.log(`Transaction API simulation: error — ${reasonOf(error)}`);
      }
    } else {
      console.log('Transaction API simulation: skipped (no BINANCE_WEB3_API_KEY/SECRET here)');
    }
    const fee = gas * gasPrice;
    console.log(
      `gas: estimate ${estimate}, limit ${gas}, price ${gasPrice} wei — up to ${bnb(fee)}; the wallet holds ${bnb(balance)}`,
    );
    if (callProblem || simulation === 'FAILED') {
      console.log('dry run failed: nothing signed');
      return 1;
    }
    if (!broadcast) {
      console.log(`dry run only: nothing signed. --broadcast signs ${label} after a typed y.`);
      return 0;
    }

    const refusals = broadcastRefusals({
      siteProblem: siteProblem(site, true),
      simulation,
      gas,
      gasPrice,
      balance,
      latestNonce,
      pendingNonce,
    });
    if (refusals.length > 0) {
      for (const refusal of refusals) console.log(`broadcast: refused — ${refusal}`);
      console.log('nothing signed');
      return 1;
    }
    const yes = await confirmSpend(
      `LIVE: ${label} on the ERC-8004 registry, from the identity wallet ${identity} — gas only, up to ${bnb(fee)}.`,
    );
    if (!yes) {
      console.log('broadcast: not confirmed — nothing signed');
      return 1;
    }

    const raw = await account.signTransaction(
      signableTx({ to: REGISTRY, data, value: 0n, gas, gasPrice, nonce: pendingNonce }),
    );
    const hash = keccak256(raw);
    console.log(`signed ${hash} — https://bscscan.com/tx/${hash}`);
    const via = await send(rt, identity, raw);
    if (via === null) return 1;
    console.log(`sent by ${via}; waiting up to 3 minutes for the receipt`);
    const receipt = await rt.bsc
      .waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })
      .catch(() => null);
    if (!receipt) {
      console.log(
        `not mined within 3 minutes: watch https://bscscan.com/tx/${hash}. A new run waits for it (pending nonce) and never registers a second agent (balanceOf).`,
      );
      return 1;
    }
    if (receipt.status !== 'success') {
      console.log(`reverted in block ${receipt.blockNumber}: only gas was spent`);
      return 1;
    }
    if (step.kind === 'register') {
      const found = registeredAgent(receipt.logs);
      const problem = registeredProblem(found, identity);
      if (problem || !found) {
        console.log(`mined in block ${receipt.blockNumber}, but ${problem}`);
        return 1;
      }
      console.log(
        `registered: agent ${found.agentId}, owner ${found.owner}, block ${receipt.blockNumber}`,
      );
      console.log(
        `next: set AGENT_ID=${found.agentId} here and on the web deploy, redeploy the web, then run pnpm agent:register --broadcast once more — the file then names its own registry entry (setAgentURI)`,
      );
      return 0;
    }
    const now = await rt.bsc.readContract({
      address: REGISTRY,
      abi: identityRegistryAbi,
      functionName: 'tokenURI',
      args: [step.agentId],
    });
    console.log(
      now === uri
        ? `updated: agent ${step.agentId} holds the site's file (block ${receipt.blockNumber})`
        : `mined in block ${receipt.blockNumber}, but agent ${step.agentId}'s URI is not the site's file yet — run pnpm agent:register to compare`,
    );
    return now === uri ? 0 : 1;
  } finally {
    await rt.close();
  }
}

/**
 * The signed bytes by the Transaction API, and the same bytes by RPC if that fails — never new
 * bytes, so at most this one transaction exists. A compliance refusal is final (DECISIONS D-13).
 * Returns the path that took them, or null when neither did.
 */
async function send(
  rt: ReturnType<typeof createRuntime>,
  address: string,
  raw: Hex,
): Promise<string | null> {
  try {
    await broadcastSigned(rt.client, { address, signedTransaction: raw });
    return 'the Transaction API';
  } catch (error) {
    if (error instanceof BinanceApiError && error.classify().category === 'compliance') {
      console.log(
        `the Transaction API refused it (${error.code ?? error.kind} ${error.msg}): not sent`,
      );
      return null;
    }
    console.log(`Transaction API broadcast failed (${reasonOf(error)}); the same bytes by RPC`);
  }
  try {
    await rt.bsc.sendRawTransaction({ serializedTransaction: raw });
    return 'RPC';
  } catch (error) {
    // Matched on the whole message (the node's words are in its details), printed as one line.
    const message = error instanceof Error ? error.message : String(error);
    if (ALREADY_KNOWN.test(message)) return 'the Transaction API (the RPC already had it)';
    console.log(
      `RPC refused it too (${reasonOf(error)}): check the hash on BscScan before running again`,
    );
    return null;
  }
}

process.exitCode = await main().catch((error: unknown) => {
  console.log(`failed: ${reasonOf(error)}`);
  return 1;
});
