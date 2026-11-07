CREATE TABLE IF NOT EXISTS "cluster_settings" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "cluster" text NOT NULL,
        "language" text NOT NULL,
        "country" text NOT NULL,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now(),
        CONSTRAINT "cluster_settings_cluster_unique" UNIQUE("cluster")
);
