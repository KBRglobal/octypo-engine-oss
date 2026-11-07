CREATE TABLE IF NOT EXISTS "serp_briefs" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "cluster" text NOT NULL,
        "queries" jsonb DEFAULT '[]'::jsonb NOT NULL,
        "brief" text NOT NULL,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now(),
        CONSTRAINT "serp_briefs_cluster_unique" UNIQUE("cluster")
);
