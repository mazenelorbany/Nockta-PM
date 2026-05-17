-- Extensions required by Nockta Flow
CREATE EXTENSION IF NOT EXISTS "pgcrypto";      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";       -- trigram fuzzy search
CREATE EXTENSION IF NOT EXISTS "citext";        -- case-insensitive emails
CREATE EXTENSION IF NOT EXISTS "btree_gin";     -- composite GIN indexes for FTS + filters
