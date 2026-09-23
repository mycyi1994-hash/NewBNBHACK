CREATE TABLE "api_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"region" text,
	"module" text NOT NULL,
	"endpoint" text NOT NULL,
	"method" text NOT NULL,
	"http_status" integer,
	"code" text,
	"msg" text,
	"latency_ms" integer NOT NULL,
	"request_id" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"fixture_path" text
);
--> statement-breakpoint
CREATE INDEX "api_calls_ts_idx" ON "api_calls" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "api_calls_endpoint_idx" ON "api_calls" USING btree ("module","endpoint");