CREATE TABLE IF NOT EXISTS "field_notes" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "source" text DEFAULT 'telegram' NOT NULL,
        "chat_id" text NOT NULL,
        "message_id" text NOT NULL,
        "update_id" bigint,
        "sender" text,
        "text" text,
        "media" jsonb DEFAULT '[]'::jsonb,
        "document_id" varchar,
        "status" text DEFAULT 'filed' NOT NULL,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now(),
        CONSTRAINT "field_notes_update_id_unique" UNIQUE("update_id")
);
DO $$ BEGIN
 ALTER TABLE "field_notes" ADD CONSTRAINT "field_notes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "IDX_field_notes_document" ON "field_notes" USING btree ("document_id");
