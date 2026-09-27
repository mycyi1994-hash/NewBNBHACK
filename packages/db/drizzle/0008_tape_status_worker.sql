CREATE TABLE "worker_status" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tape_samples" ADD COLUMN "reason_msg" text;--> statement-breakpoint
ALTER TABLE "tape_samples" ADD COLUMN "next_open_time" bigint;