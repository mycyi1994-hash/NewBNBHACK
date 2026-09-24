-- Rows recorded before this migration keep their own start time as the key (they were unique per run).
ALTER TABLE "tape_samples" ADD COLUMN "slot_at" timestamp with time zone;--> statement-breakpoint
UPDATE "tape_samples" SET "slot_at" = "sampled_at" WHERE "slot_at" IS NULL;--> statement-breakpoint
ALTER TABLE "tape_samples" ALTER COLUMN "slot_at" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tape_samples_slot_uq" ON "tape_samples" USING btree ("slot_at","instrument_id","size_usd");
