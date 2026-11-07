CREATE TABLE "cluster_facts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster" text DEFAULT '*' NOT NULL,
	"fact" text NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'client' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "IDX_cluster_facts_cluster" ON "cluster_facts" USING btree ("cluster");