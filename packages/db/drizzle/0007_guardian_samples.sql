CREATE TABLE "guardian_samples" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"metric" text NOT NULL,
	"value" numeric(38, 18) NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guardian_events" DROP CONSTRAINT "guardian_events_action_ck";--> statement-breakpoint
CREATE INDEX "guardian_samples_metric_ts_idx" ON "guardian_samples" USING btree ("metric","ts");--> statement-breakpoint
ALTER TABLE "guardian_events" ADD CONSTRAINT "guardian_events_action_ck" CHECK (action in ('warn', 'pause_buys', 'stop_deposits', 'redeem_all'));