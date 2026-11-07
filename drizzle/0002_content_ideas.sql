CREATE TABLE "content_ideas" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"target_keyword" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"cluster" text,
	"article_type" text,
	"is_pillar" boolean DEFAULT false,
	"search_volume" integer,
	"priority" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"content_id" varchar,
	"evidence" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "IDX_content_ideas_status" ON "content_ideas" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_content_ideas_cluster" ON "content_ideas" USING btree ("cluster");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_content_ideas_dedupe_key" ON "content_ideas" USING btree ("dedupe_key");