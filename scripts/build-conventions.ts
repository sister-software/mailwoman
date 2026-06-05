/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the **convention asset** (#290, Direction E) FROM SOURCE: compile the authored convention
 *   profiles in `data/conventions/conventions.json` into a read-only, provenance-stamped sqlite
 *   asset (`address_convention` keyed by WOF polygon id + a `meta` row), the same
 *   distributable-asset shape as `postcode-locality-intl.db`.
 *
 *   The authored JSON is the human-editable source of truth (diffable, code-reviewed); the `.db` is
 *   the queryable, immutable compiled form the resolver reads ON DEMAND (one indexed lookup per id,
 *   not the whole table paged into memory). Per the no-load-bearing-trivia design value: every row
 *   carries `source` provenance, and a convention that names a strategy this build doesn't register
 *   is rejected HERE, loudly, rather than silently no-opping at runtime.
 *
 *   Authored entry shape (each element of the JSON array): { "wof_id": 85633111, "source": "…why this
 *   row exists…", "convention": { …Convention… } }
 *
 *   Usage: node --experimental-strip-types scripts/build-conventions.ts\
 *   --src data/conventions/conventions.json\
 *   --output /mnt/playpen/mailwoman-data/wof/conventions.db
 */
import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { BUILTIN_STRATEGY_NAMES, type Convention } from "@mailwoman/resolver-wof-sqlite"

interface AuthoredConvention {
	wof_id: number
	source: string
	convention: Convention
}

const KNOWN = new Set<string>(BUILTIN_STRATEGY_NAMES)
const WEIGHT_KEYS = new Set(["pc", "name", "pop"])

function argval(flag: string, fallback?: string): string {
	const i = process.argv.indexOf(flag)
	if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!
	if (fallback !== undefined) return fallback
	throw new Error(`missing required ${flag}`)
}

/** Reject malformed or code-incoherent conventions at BUILD time (loud), so the runtime never has
to. */
function validate(rows: AuthoredConvention[]): void {
	const errors: string[] = []
	const seen = new Set<number>()
	for (const [i, r] of rows.entries()) {
		const at = `entry ${i} (wof_id=${r?.wof_id})`
		if (typeof r?.wof_id !== "number") errors.push(`${at}: wof_id must be a number`)
		else if (seen.has(r.wof_id)) errors.push(`${at}: duplicate wof_id`)
		else seen.add(r.wof_id)
		if (typeof r?.source !== "string" || !r.source.trim())
			errors.push(`${at}: every row needs non-empty 'source' provenance`)
		const c = r?.convention
		if (!c || typeof c !== "object") {
			errors.push(`${at}: missing convention object`)
			continue
		}
		for (const s of c.candidateStrategies ?? [])
			if (!KNOWN.has(s)) errors.push(`${at}: names unknown strategy "${s}" (known: ${[...KNOWN].join(", ")})`)
		for (const k of Object.keys(c.scoringWeights ?? {}))
			if (!WEIGHT_KEYS.has(k)) errors.push(`${at}: unknown scoringWeights key "${k}"`)
	}
	if (errors.length) throw new Error(`convention validation failed:\n  - ${errors.join("\n  - ")}`)
}

function build(src: string, output: string): void {
	const rows = JSON.parse(readFileSync(src, "utf8")) as AuthoredConvention[]
	if (!Array.isArray(rows)) throw new Error(`${src} must be a JSON array of authored conventions`)
	validate(rows)

	const db = new DatabaseSync(output)
	db.exec("DROP TABLE IF EXISTS address_convention; DROP TABLE IF EXISTS meta")
	db.exec(`CREATE TABLE address_convention (
		wof_id INTEGER PRIMARY KEY,   -- the WOF admin polygon this profile attaches to
		convention TEXT NOT NULL,     -- the Convention JSON
		source TEXT NOT NULL          -- provenance: why this row exists / where it came from
	)`)
	const ins = db.prepare("INSERT INTO address_convention (wof_id, convention, source) VALUES (?, ?, ?)")
	for (const r of rows) ins.run(r.wof_id, JSON.stringify(r.convention), r.source)

	// Freeze into the read-only distributable asset — same discipline as our other WOF tables.
	db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
	const meta: Record<string, string> = {
		name: "mailwoman-conventions",
		description: "Geographic Rule Engine convention profiles, keyed by WOF polygon id (Direction E)",
		schema_version: "1",
		source:
			"Authored profiles compiled from data/conventions/conventions.json (built from source, not a prebuilt dump)",
		rows: String(rows.length),
		strategies_known: [...KNOWN].join(","),
	}
	const insMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
	for (const [k, v] of Object.entries(meta)) insMeta.run(k, v)

	db.exec("PRAGMA journal_mode = DELETE") // no -wal/-shm sidecar; the .db is self-contained
	db.exec("ANALYZE")
	const ok = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check
	if (ok !== "ok") throw new Error(`integrity_check failed: ${ok}`)
	db.exec("VACUUM")
	db.close()
	console.log(`built ${output}: ${rows.length} convention(s), integrity=ok`)
}

build(argval("--src", "data/conventions/conventions.json"), argval("--output"))
