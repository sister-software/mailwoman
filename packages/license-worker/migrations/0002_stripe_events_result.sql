-- Renames the webhook ledger's `outcome` column to `result`, matching the ledger schema's name for it.
ALTER TABLE stripe_events RENAME COLUMN outcome TO result;
