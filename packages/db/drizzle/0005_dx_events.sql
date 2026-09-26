CREATE TABLE "dx_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"module" text NOT NULL,
	"endpoint" text NOT NULL,
	"code" text NOT NULL,
	"http_status" integer,
	"msg" text,
	"request_id" text,
	"region" text,
	"meaning" text NOT NULL,
	"logged_at" timestamp with time zone,
	CONSTRAINT "dx_events_kind_ck" CHECK (kind in ('unknown_code', 'undocumented_shape'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "dx_events_first_uq" ON "dx_events" USING btree ("kind","module","endpoint","code");