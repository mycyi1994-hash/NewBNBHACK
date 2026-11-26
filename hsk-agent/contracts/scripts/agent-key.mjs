// Makes the agent's key: a new wallet that can only call trade() on the vault, inside its limits.
// The key is written straight into ../.env.local (which git ignores) and is never printed. Only the address is shown:
// the deploy script needs the address, and the wallet needs a little HSK for gas.
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const file = new URL('../../.env.local', import.meta.url);
const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
const had = /^MOA_AGENT_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(text);
if (had) {
  console.log(`An agent key is already in .env.local. Its address:\n  ${privateKeyToAccount(had[1]).address}`);
} else {
  const key = generatePrivateKey();
  appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}# Moa's agent key: can only trade through the vault, inside its limits. Never commit or share.\nMOA_AGENT_PRIVATE_KEY=${key}\n`);
  console.log(`New agent key written to hsk-agent/.env.local (not shown). Its address:\n  ${privateKeyToAccount(key).address}`);
}
console.log('Send this address a little HSK for gas, and pass it to the deploy script as MOA_AGENT_ADDRESS.');
