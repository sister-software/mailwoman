-- One row per subscription. `lid` is the opaque per-license serial the token carries; it is stable for the
-- subscription's life and is what online status is keyed by. `refresh_secret_pending` holds the plaintext refresh
-- secret from creation until the first successful claim reads and clears it; after that only the digest remains.
CREATE TABLE licenses (
	lid TEXT PRIMARY KEY,
	subscription_id TEXT NOT NULL UNIQUE,
	customer_id TEXT NOT NULL,
	checkout_session_id TEXT NOT NULL UNIQUE,
	plan_code TEXT NOT NULL,
	agreement_version TEXT NOT NULL,
	licensee TEXT NOT NULL,
	email TEXT NOT NULL,
	refresh_secret_sha256 TEXT NOT NULL,
	refresh_secret_pending TEXT,
	subscription_state TEXT NOT NULL DEFAULT 'active',
	payment_state TEXT NOT NULL DEFAULT 'pending',
	license_state TEXT NOT NULL DEFAULT 'active' CHECK (license_state IN ('active', 'lapsed', 'revoked', 'review')),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per paid invoice: the token minted for that period. The primary key on the invoice id is what makes a
-- replayed, duplicated, or reordered `invoice.paid` one token.
CREATE TABLE license_tokens (
	invoice_id TEXT PRIMARY KEY,
	lid TEXT NOT NULL REFERENCES licenses(lid),
	issued TEXT NOT NULL,
	expires TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	token TEXT NOT NULL,
	email_state TEXT NOT NULL DEFAULT 'pending' CHECK (email_state IN ('pending', 'sent', 'failed')),
	email_message_id TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX license_tokens_by_lid ON license_tokens(lid, expires);

-- Every webhook event id, written after its effects; no payload, ever.
CREATE TABLE stripe_events (
	event_id TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	object_id TEXT NOT NULL,
	received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	outcome TEXT NOT NULL DEFAULT 'recorded'
);
