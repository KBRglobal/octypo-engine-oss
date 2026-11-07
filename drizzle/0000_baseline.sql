CREATE TABLE "articles" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" varchar NOT NULL,
	"category" text,
	"excerpt" text,
	"publish_date" timestamp,
	"source_rss_feed_id" varchar,
	"source_url" text,
	"faq" jsonb DEFAULT '[]'::jsonb,
	"related_topic_ids" jsonb DEFAULT '[]'::jsonb,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"retries" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 3 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"next_attempt_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "content_entities" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_content_id" varchar NOT NULL,
	"entity_type" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"description" text,
	"topic_id" varchar,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"verified" boolean DEFAULT false,
	"article_count" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "content_fingerprints" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" varchar,
	"fingerprint" text NOT NULL,
	"source_url" text,
	"source_title" text,
	"rss_feed_id" varchar,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "content_fingerprints_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
CREATE TABLE "contents" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text DEFAULT 'article' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"meta_title" text,
	"meta_description" text,
	"primary_keyword" text,
	"secondary_keywords" jsonb DEFAULT '[]'::jsonb,
	"hero_image" text,
	"hero_image_alt" text,
	"card_image" text,
	"card_image_alt" text,
	"summary" text,
	"blocks" jsonb DEFAULT '[]'::jsonb,
	"seo_schema" jsonb,
	"seo_score" integer,
	"answer_capsule" text,
	"quick_facts" jsonb,
	"aeo_score" integer,
	"word_count" integer DEFAULT 0,
	"view_count" integer DEFAULT 0,
	"writer_id" varchar,
	"generated_by_ai" boolean DEFAULT false,
	"published_at" timestamp,
	"scheduled_for" timestamp,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "contents_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"extracted_text" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"idea_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "internal_links" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_content_id" varchar,
	"target_content_id" varchar,
	"anchor_text" text,
	"is_auto_suggested" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "library_items" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" varchar NOT NULL,
	"title" text NOT NULL,
	"angle" text NOT NULL,
	"key_points" jsonb DEFAULT '[]'::jsonb,
	"suggested_topic_id" varchar,
	"status" text DEFAULT 'idea' NOT NULL,
	"content_id" varchar,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "rss_feeds" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"category" text,
	"topic_id" varchar,
	"language" text DEFAULT 'en',
	"region" text,
	"is_active" boolean DEFAULT true,
	"last_fetched_at" timestamp,
	"fetch_interval_minutes" integer DEFAULT 60,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "seo_metadata" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" varchar NOT NULL,
	"quality_108_total" integer,
	"quality_108_breakdown" jsonb DEFAULT '{}'::jsonb,
	"quality_108_grade" varchar(5),
	"quality_108_passed" boolean DEFAULT false,
	"aeo_score" integer,
	"has_answer_capsule" boolean DEFAULT false,
	"has_faq_schema" boolean DEFAULT false,
	"faq_count" integer DEFAULT 0,
	"internal_links_out" integer DEFAULT 0,
	"internal_links_in" integer DEFAULT 0,
	"is_orphan" boolean DEFAULT false,
	"last_audit_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "seo_metadata_content_id_unique" UNIQUE("content_id")
);
--> statement-breakpoint
ALTER TABLE "library_items" ADD CONSTRAINT "library_items_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_metadata" ADD CONSTRAINT "seo_metadata_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_jobs_status" ON "background_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_jobs_type" ON "background_jobs" USING btree ("type");--> statement-breakpoint
CREATE INDEX "IDX_jobs_priority" ON "background_jobs" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "idx_content_entities_source" ON "content_entities" USING btree ("source_content_id");--> statement-breakpoint
CREATE INDEX "idx_content_entities_type" ON "content_entities" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX "idx_content_entities_normalized" ON "content_entities" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "IDX_contents_status" ON "contents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_contents_type" ON "contents" USING btree ("type");--> statement-breakpoint
CREATE INDEX "IDX_contents_published_at" ON "contents" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "IDX_contents_scheduled_for" ON "contents" USING btree ("scheduled_for");--> statement-breakpoint
CREATE INDEX "IDX_contents_writer" ON "contents" USING btree ("writer_id");--> statement-breakpoint
CREATE INDEX "IDX_documents_status" ON "documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_library_items_document" ON "library_items" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "IDX_library_items_status" ON "library_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_seo_metadata_content" ON "seo_metadata" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX "idx_seo_metadata_quality" ON "seo_metadata" USING btree ("quality_108_total");