CREATE TABLE "cost_ledger" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"kind" text DEFAULT 'model' NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"images" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" integer DEFAULT 0 NOT NULL,
	"article_id" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "IDX_cost_ledger_day" ON "cost_ledger" USING btree ("day");