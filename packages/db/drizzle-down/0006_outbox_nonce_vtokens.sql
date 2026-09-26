DROP INDEX "tx_outbox_nonce_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "tx_outbox_nonce_uq" ON "tx_outbox" USING btree ("chain_id","from_address","nonce");--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN "vtoken_units";
