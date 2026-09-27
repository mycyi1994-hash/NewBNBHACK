DROP TABLE "worker_status";--> statement-breakpoint
ALTER TABLE "tape_samples" DROP COLUMN "next_open_time";--> statement-breakpoint
ALTER TABLE "tape_samples" DROP COLUMN "reason_msg";
