/**
 * The house signer (SPEC §5 v2: one signer, in the worker only). The private key comes from the
 * validated config and never leaves this object; logs and outbox rows carry only the address.
 */
import type { Hex, TransactionSerializable } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export interface Signer {
  readonly address: Hex;
  sign(tx: TransactionSerializable): Promise<Hex>;
}

export function houseSigner(privateKey: Hex): Signer {
  const account = privateKeyToAccount(privateKey);
  return { address: account.address, sign: (tx) => account.signTransaction(tx) };
}
