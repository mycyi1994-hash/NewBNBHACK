ALTER TABLE "receipts" DROP CONSTRAINT "receipts_tx_hash_ck";--> statement-breakpoint
ALTER TABLE "plans" DROP CONSTRAINT "plans_vtokens_ck";--> statement-breakpoint
ALTER TABLE "holdings" DROP CONSTRAINT "holdings_tokens_ck";
