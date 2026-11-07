CREATE TABLE IF NOT EXISTS "seo_lookups" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool" text NOT NULL,
	"cache_key" text NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_micro_usd" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_seo_lookups_cache_key" ON "seo_lookups" USING btree ("cache_key");
CREATE INDEX IF NOT EXISTS "IDX_seo_lookups_tool" ON "seo_lookups" USING btree ("tool");
