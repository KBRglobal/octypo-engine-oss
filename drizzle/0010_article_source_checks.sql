ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "source_checks" jsonb DEFAULT '[]'::jsonb;
