DROP INDEX "tx_outbox_nonce_uq";--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "vtoken_units" text DEFAULT '0' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tx_outbox_nonce_uq" ON "tx_outbox" USING btree ("chain_id","from_address","nonce") WHERE not (status = 'FAILED' and broadcast_via is null);