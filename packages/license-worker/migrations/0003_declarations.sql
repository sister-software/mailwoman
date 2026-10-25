-- One row per declared license: an open-source, non-profit, academic or student declaration, or a thirty-day
-- evaluation. `lid` shares the `lic_` namespace with `licenses`, so the refresh and status routes answer either table
-- by the same id. `claim_id` is set for the intents whose token travels by email and is what the CLI polls.
-- `refresh_secret_pending` holds the plaintext secret until the first claim reads and clears it, as `licenses` does.
CREATE TABLE declarations (
	lid TEXT PRIMARY KEY,
	intent TEXT NOT NULL CHECK (intent IN ('open-source', 'non-profit', 'academic', 'student', 'evaluation')),
	licensee TEXT NOT NULL,
	email TEXT,
	organization TEXT,
	source_url TEXT,
	claim_id TEXT UNIQUE,
	verification TEXT NOT NULL DEFAULT 'unverified' CHECK (verification IN ('unverified', 'verified')),
	verified_at TEXT,
	refresh_secret_sha256 TEXT NOT NULL,
	refresh_secret_pending TEXT,
	first_install TEXT,
	license_state TEXT NOT NULL DEFAULT 'active' CHECK (license_state IN ('active', 'lapsed', 'revoked', 'review')),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- An address receives one evaluation. The other intents may repeat an address.
CREATE UNIQUE INDEX declarations_one_evaluation_per_email ON declarations(email) WHERE intent = 'evaluation';

-- One row per token minted for a declared license. `seq` is the issuance ordinal the token carries, and the unique
-- pair makes a repeated re-issuance one row.
CREATE TABLE issuances (
	issuance_id TEXT PRIMARY KEY,
	lid TEXT NOT NULL REFERENCES declarations(lid),
	seq INTEGER NOT NULL,
	issued TEXT NOT NULL,
	expires TEXT NOT NULL,
	install TEXT,
	payload_json TEXT NOT NULL,
	token TEXT NOT NULL,
	email_state TEXT NOT NULL DEFAULT 'pending' CHECK (email_state IN ('pending', 'sent', 'failed')),
	email_message_id TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	UNIQUE (lid, seq)
);

-- One row per granted download. `lid` is null for a hand-issued token, which the key id and licensee identify.
CREATE TABLE downloads (
	download_id TEXT PRIMARY KEY,
	lid TEXT,
	kid TEXT NOT NULL,
	licensee TEXT NOT NULL,
	install TEXT,
	artifact TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX downloads_by_lid ON downloads(lid, created_at);
