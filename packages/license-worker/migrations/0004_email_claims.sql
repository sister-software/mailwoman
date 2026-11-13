-- The instant a caller claimed a row's email send. A caller sets it before it calls the provider, and only while the row
-- holds the email state the caller read and holds no claim younger than the lease. Two callers that read the same row
-- therefore send one message between them. Recording the send's outcome clears it. A claim older than the lease belongs
-- to a worker that stopped mid-send, and the reconciliation pass may take it over.
ALTER TABLE license_tokens ADD COLUMN email_claimed_at TEXT;
ALTER TABLE issuances ADD COLUMN email_claimed_at TEXT;
