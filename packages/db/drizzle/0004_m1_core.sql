CREATE TABLE "cycles" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"state" text DEFAULT 'running' NOT NULL,
	"outcome_kind" text,
	"outcome" jsonb,
	"why_key" text,
	"why_params" jsonb,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"instrument_id" text,
	"spend_usd" numeric(38, 18),
	"interest_usd" numeric(38, 18),
	"retry_at" timestamp with time zone,
	"execution_mode" text NOT NULL,
	CONSTRAINT "cycles_state_ck" CHECK (state in ('running', 'awaiting_tx', 'done')),
	CONSTRAINT "cycles_outcome_kind_ck" CHECK (outcome_kind in ('BOUGHT', 'DEFERRED', 'SKIPPED', 'FAILED')),
	CONSTRAINT "cycles_execution_mode_ck" CHECK (execution_mode in ('simulate', 'live'))
);
--> statement-breakpoint
CREATE TABLE "guardian_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"rule" text NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb NOT NULL,
	"plan_id" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "guardian_events_action_ck" CHECK (action in ('warn', 'pause_buys', 'redeem_all'))
);
--> statement-breakpoint
CREATE TABLE "holdings" (
	"plan_id" text NOT NULL,
	"instrument_id" text NOT NULL,
	"tokens" text NOT NULL,
	"decimals" integer NOT NULL,
	"multiplier_at_last_update" text NOT NULL,
	"shares" text NOT NULL,
	"cost_usd" numeric(38, 18) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holdings_plan_id_instrument_id_pk" PRIMARY KEY("plan_id","instrument_id")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"plan_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_kind_ck" CHECK (kind in ('preview', 'run', 'stop')),
	CONSTRAINT "jobs_status_ck" CHECK (status in ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "judge_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_ref" text,
	"wallet_address" text,
	"mode" text NOT NULL,
	"ticker" text NOT NULL,
	"issuer_preference" text[] NOT NULL,
	"principal_usd" numeric(38, 18) DEFAULT '0' NOT NULL,
	"contribution_usd" numeric(38, 18) DEFAULT '0' NOT NULL,
	"harvested_unspent_usd" numeric(38, 18) DEFAULT '0' NOT NULL,
	"cadence" text NOT NULL,
	"window" text NOT NULL,
	"max_per_buy_usd" numeric(38, 18) NOT NULL,
	"max_daily_usd" numeric(38, 18) NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"paused_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"lock_until" timestamp with time zone,
	CONSTRAINT "plans_owner_kind_ck" CHECK (owner_kind in ('house', 'judge', 'skill')),
	CONSTRAINT "plans_mode_ck" CHECK (mode in ('safe', 'yield')),
	CONSTRAINT "plans_status_ck" CHECK (status in ('active', 'paused', 'stopped')),
	CONSTRAINT "plans_amounts_ck" CHECK (principal_usd >= 0 and contribution_usd >= 0 and harvested_unspent_usd >= 0 and max_per_buy_usd > 0 and max_daily_usd >= max_per_buy_usd),
	CONSTRAINT "plans_yield_principal_ck" CHECK (mode <> 'yield' or status <> 'active' or principal_usd > 0)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"cycle_id" bigint,
	"plan_id" text NOT NULL,
	"kind" text NOT NULL,
	"tx_hash" text NOT NULL,
	"explorer_url" text NOT NULL,
	"chain_id" integer NOT NULL,
	"amounts" jsonb NOT NULL,
	"broadcast_via" text NOT NULL,
	"simulated_at" timestamp with time zone,
	"block_number" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_kind_ck" CHECK (kind in ('approve', 'swap', 'deposit', 'redeem')),
	CONSTRAINT "receipts_status_ck" CHECK (status in ('success', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "skill_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"wallet_address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "spend_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"cycle_id" bigint,
	"owner_kind" text NOT NULL,
	"day" date NOT NULL,
	"amount_usd" numeric(38, 18) NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_ledger_status_ck" CHECK (status in ('reserved', 'spent', 'released')),
	CONSTRAINT "spend_ledger_amount_ck" CHECK (amount_usd >= 0)
);
--> statement-breakpoint
CREATE TABLE "tx_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"cycle_id" bigint,
	"kind" text NOT NULL,
	"chain_id" integer NOT NULL,
	"from_address" text NOT NULL,
	"nonce" integer NOT NULL,
	"raw_tx" text NOT NULL,
	"tx_hash" text NOT NULL,
	"status" text NOT NULL,
	"broadcast_via" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tx_outbox_status_ck" CHECK (status in ('SIGNED', 'PENDING', 'CONFIRMED', 'FAILED')),
	CONSTRAINT "tx_outbox_kind_ck" CHECK (kind in ('approve', 'swap', 'deposit', 'redeem'))
);
--> statement-breakpoint
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_events" ADD CONSTRAINT "guardian_events_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tx_outbox" ADD CONSTRAINT "tx_outbox_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tx_outbox" ADD CONSTRAINT "tx_outbox_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cycles_plan_due_uq" ON "cycles" USING btree ("plan_id","due_at");--> statement-breakpoint
CREATE INDEX "cycles_plan_started_idx" ON "cycles" USING btree ("plan_id","started_at");--> statement-breakpoint
CREATE INDEX "guardian_events_ts_idx" ON "guardian_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "plans_due_idx" ON "plans" USING btree ("status","next_due_at");--> statement-breakpoint
CREATE INDEX "plans_owner_idx" ON "plans" USING btree ("owner_kind","owner_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_tx_uq" ON "receipts" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "receipts_plan_idx" ON "receipts" USING btree ("plan_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_tokens_hash_uq" ON "skill_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "spend_ledger_day_idx" ON "spend_ledger" USING btree ("day","status");--> statement-breakpoint
CREATE UNIQUE INDEX "spend_ledger_cycle_uq" ON "spend_ledger" USING btree ("cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tx_outbox_nonce_uq" ON "tx_outbox" USING btree ("chain_id","from_address","nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "tx_outbox_hash_uq" ON "tx_outbox" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "tx_outbox_status_idx" ON "tx_outbox" USING btree ("status");