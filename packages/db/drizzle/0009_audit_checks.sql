ALTER TABLE "holdings" ADD CONSTRAINT "holdings_tokens_ck" CHECK (tokens ~ '^[0-9]+$');--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_vtokens_ck" CHECK (vtoken_units ~ '^[0-9]+$');--> statement-breakpoint
-- A re-spelled duplicate of a recorded hash is a replay: keep the original, then lower-case the rest.
DELETE FROM "receipts" r USING "receipts" s WHERE r.tx_hash <> lower(r.tx_hash) AND s.tx_hash = lower(r.tx_hash);--> statement-breakpoint
UPDATE "receipts" SET tx_hash = lower(tx_hash) WHERE tx_hash <> lower(tx_hash);--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_tx_hash_ck" CHECK (tx_hash = lower(tx_hash));