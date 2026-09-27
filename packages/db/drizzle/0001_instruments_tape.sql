CREATE TABLE "instruments" (
	"id" text PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"issuer" text NOT NULL,
	"platform_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer NOT NULL,
	"asset_type" integer,
	"multiplier" text NOT NULL,
	"multiplier_source" text NOT NULL,
	"api_share_ratio" text,
	"verified_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tape_samples" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sampled_at" timestamp with time zone NOT NULL,
	"instrument_id" text NOT NULL,
	"session" text NOT NULL,
	"open_state" boolean,
	"market_status" text,
	"reason_code" text,
	"token_price" text,
	"reference_price" text,
	"price_updated_at" timestamp with time zone,
	"size_usd" integer NOT NULL,
	"expected_out" text,
	"price_impact_pct" text,
	"vendor" text,
	"execution_mode" text,
	"route" text,
	"error_code" text,
	"error_msg" text,
	"latency_ms" integer
);
--> statement-breakpoint
CREATE INDEX "instruments_ticker_idx" ON "instruments" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "tape_samples_sampled_at_idx" ON "tape_samples" USING btree ("sampled_at");--> statement-breakpoint
CREATE INDEX "tape_samples_instrument_idx" ON "tape_samples" USING btree ("instrument_id","sampled_at");