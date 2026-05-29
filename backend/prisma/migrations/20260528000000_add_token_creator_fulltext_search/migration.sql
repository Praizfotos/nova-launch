-- Add full-text search index for creator field on tokens
-- Enables searching tokens by creator name/address using full-text search instead of LIKE scans

CREATE INDEX IF NOT EXISTS "Token_creator_fulltext_idx" ON "Token" USING gin (to_tsvector('english', "creator"));

-- Add a combined full-text search index for efficient multi-field searches
CREATE INDEX IF NOT EXISTS "Token_fulltext_idx" ON "Token" USING gin (
  to_tsvector('english', "name" || ' ' || "symbol" || ' ' || "creator")
);
