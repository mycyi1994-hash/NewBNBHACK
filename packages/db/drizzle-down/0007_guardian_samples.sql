DROP TABLE "guardian_samples";--> statement-breakpoint
ALTER TABLE "guardian_events" DROP CONSTRAINT "guardian_events_action_ck";--> statement-breakpoint
ALTER TABLE "guardian_events" ADD CONSTRAINT "guardian_events_action_ck" CHECK (action in ('warn', 'pause_buys', 'redeem_all'));
