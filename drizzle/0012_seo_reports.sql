CREATE TABLE IF NOT EXISTS "seo_reports" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"domain" text NOT NULL,
	"client_name" text NOT NULL,
	"seed" text,
	"payload" jsonb NOT NULL,
	"cost_micro_usd" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_seo_reports_token" ON "seo_reports" USING btree ("token");
CREATE INDEX IF NOT EXISTS "IDX_seo_reports_created" ON "seo_reports" USING btree ("created_at");
