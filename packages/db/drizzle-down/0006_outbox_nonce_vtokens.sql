DROP INDEX "tx_outbox_nonce_uq";--> statement-breakpoint
DELETE FROM "tx_outbox" WHERE status = 'FAILED' AND broadcast_via IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tx_outbox_nonce_uq" ON "tx_outbox" USING btree ("chain_id","from_address","nonce");--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN "vtoken_units";
