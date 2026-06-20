/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Incrementally add one or more countries' admin coverage to an EXISTING `admin-global-priority.db`
 *   from the Overture `divisions` theme — WITHOUT a full `build-unified-wof` re-ingest.
 *
 *   Why this exists: the canonical admin gazetteer is built from the cloned WOF repos + a hand-listed
 *   `--overture-countries` set, so a country that's on neither (e.g. CA) is simply absent. A full
 *   rebuild can add it, but reproducing the exact WOF-repo inputs is error-prone (a sibling repo
 *   not re-globbed silently drops coverage). This path is safe by construction: it COPIES the
 *   frozen live DB (every existing country preserved), backfills only the requested countries from
 *   Overture's global divisions theme (reusing `ingestOvertureDivisions` — the same code the full
 *   build uses), re-runs the freeze (ancestors closure, coincident_roles, indexes), and VACUUMs to
 *   a new file. The country-gate rides `spr.country` (set on every Overture row), so resolution
 *   works immediately.
 *
 *   Run: node --experimental-strip-types scripts/augment-admin-overture.ts\
 *   --in /mnt/playpen/mailwoman-data/wof/admin-global-priority.db\
 *   --out /mnt/playpen/mailwoman-data/wof/admin-global-priority-ca.db\
 *   --countries CA [--release 2026-06-17.0]
 */

import { buildCoincidentRoles } from "@mailwoman/resolver-wof-sqlite/coincident-roles"
import { createUnifiedIndexes, populateAncestors } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import { copyFileSync, existsSync, unlinkSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { ingestOvertureDivisions } from "./build-unified-wof.ts"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const IN = arg("in", "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db")
const OUT = arg("out")
const COUNTRIES = arg("countries")
	.split(",")
	.map((c) => c.trim().toUpperCase())
	.filter(Boolean)
const RELEASE = arg("release", "2026-06-17.0")

if (!OUT || COUNTRIES.length === 0) {
	console.error(
		"Usage: augment-admin-overture.ts --in <admin.db> --out <new.db> --countries CA[,AU,...] [--release 2026-06-17.0]"
	)
	process.exit(1)
}

const WORK = `${OUT}.work`
if (existsSync(WORK)) unlinkSync(WORK)
console.error(`Copying ${IN} → ${WORK} (preserves all existing coverage) ...`)
copyFileSync(IN, WORK)

const db = new DatabaseSync(WORK)
const before = Number((db.prepare("SELECT count(*) AS n FROM spr").get() as { n: number }).n)

// Start synthetic ids ABOVE every id already in the DB (WOF or a prior Overture backfill) so this
// augment never collides with existing rows — a flat OVERTURE_ID_BASE would `INSERT OR REPLACE`
// straight over the EU Overture divisions.
const idBase = Number((db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM spr").get() as { m: number }).m) + 1
const n = await ingestOvertureDivisions(db, COUNTRIES, RELEASE, idBase)
console.error(`Ingested ${n.toLocaleString()} ${COUNTRIES.join(",")} divisions from Overture`)

console.error("Re-freezing: ancestors closure ...")
populateAncestors(db)
console.error("  coincident_roles ...")
buildCoincidentRoles(db)
console.error("  indexes ...")
createUnifiedIndexes(db)
db.exec("ANALYZE")
db.exec("PRAGMA optimize")

const after = Number((db.prepare("SELECT count(*) AS n FROM spr").get() as { n: number }).n)
const added = db
	.prepare(
		`SELECT country, count(*) AS n FROM spr WHERE country IN (${COUNTRIES.map(() => "?").join(",")}) GROUP BY country`
	)
	.all(...COUNTRIES) as Array<{ country: string; n: number }>
console.error(`spr: ${before.toLocaleString()} → ${after.toLocaleString()} (+${(after - before).toLocaleString()})`)
console.error(`  added: ${added.map((r) => `${r.country}=${Number(r.n).toLocaleString()}`).join(", ")}`)

const integrity = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check
if (integrity !== "ok") throw new Error(`integrity_check failed: ${integrity}`)

if (existsSync(OUT)) unlinkSync(OUT)
db.prepare("VACUUM INTO ?").run(OUT)
db.close()
if (existsSync(WORK)) unlinkSync(WORK)
console.error(`Wrote ${OUT}`)
