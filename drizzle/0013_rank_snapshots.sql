CREATE TABLE IF NOT EXISTS "rank_snapshots" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar NOT NULL,
	"keyword" text NOT NULL,
	"position" integer,
	"url" text,
	"search_volume" integer,
	"traffic_estimate" integer,
	"measured_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_rank_snapshots_run" ON "rank_snapshots" USING btree ("run_id");
CREATE INDEX IF NOT EXISTS "IDX_rank_snapshots_keyword" ON "rank_snapshots" USING btree ("keyword");
CREATE INDEX IF NOT EXISTS "IDX_rank_snapshots_measured" ON "rank_snapshots" USING btree ("measured_at");
