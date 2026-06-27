/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Gen-wof-bootstrap.ts — WOF-bootstrap end-to-end eval set (Direction C, Phase 1).
 *
 *   Samples real Who's-On-First US places (localities + postcodes), renders them into address strings
 *   (canonical AND rule-defeating perturbations), and labels each with the source WOF id + centroid
 *   coords. Running these through parse->resolve and checking the resolved WOF id is the first
 *   END-TO-END "address -> correct place" benchmark (the resolver has unit tests but no whole-stack
 *   accuracy number).
 *
 *   WHY WOF-sourced: it's independent of our Pelias-lineage suite, and the resolver's 142k-candidate
 *   ambiguity (real Springfield-style conflicts) makes round-tripping non-trivial. The synthetic
 *   house/street don't affect the label (the resolver is admin-level), but make the parse
 *   realistic
 *
 *   - Exercise the street-overspan failure. Caveat: these are SYNTHETIC address strings; the
 *       OpenAddresses track adds an independent REAL-address coordinate-error signal.
 *
 *   Hierarchy-tolerant label: a locality row accepts {locality_id, region_id}; a postcode row accepts
 *   {postcode_id, region_id}.
 *
 *   Output JSONL row: {input, expected_id, acceptable_ids[], specificity, lat, lon,
 *   expected:{locality?,region?,postcode?}, template, perturb, source}
 *
 *   Usage: node --experimental-strip-types scripts/eval/gen-wof-bootstrap.ts\
 *   --admin /mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db\
 *   --postcode /mnt/playpen/mailwoman-data/wof/whosonfirst-data-postalcode-us-latest.db\
 *   --per-region 8 --postcodes 120 --out /tmp/wof-bootstrap/eval.jsonl
 *
 *   Ported faithfully from scripts/eval/gen-wof-bootstrap.py. NOTE: the seeded RNG is
 *   distribution-faithful but NOT CPython-bit-identical (see python-random.ts); the per-region
 *   sampling, render templates, and output schema are preserved.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { pyJsonDumps, pyReprDict } from "../lib/python-json.ts"
import { SeededRandom } from "../lib/python-random.ts"

// state/territory name -> USPS abbreviation (real addresses use the abbrev).
const STATE_ABBREV: Record<string, string> = {
	Alabama: "AL",
	Alaska: "AK",
	Arizona: "AZ",
	Arkansas: "AR",
	California: "CA",
	Colorado: "CO",
	Connecticut: "CT",
	Delaware: "DE",
	Florida: "FL",
	Georgia: "GA",
	Hawaii: "HI",
	Idaho: "ID",
	Illinois: "IL",
	Indiana: "IN",
	Iowa: "IA",
	Kansas: "KS",
	Kentucky: "KY",
	Louisiana: "LA",
	Maine: "ME",
	Maryland: "MD",
	Massachusetts: "MA",
	Michigan: "MI",
	Minnesota: "MN",
	Mississippi: "MS",
	Missouri: "MO",
	Montana: "MT",
	Nebraska: "NE",
	Nevada: "NV",
	"New Hampshire": "NH",
	"New Jersey": "NJ",
	"New Mexico": "NM",
	"New York": "NY",
	"North Carolina": "NC",
	"North Dakota": "ND",
	Ohio: "OH",
	Oklahoma: "OK",
	Oregon: "OR",
	Pennsylvania: "PA",
	"Rhode Island": "RI",
	"South Carolina": "SC",
	"South Dakota": "SD",
	Tennessee: "TN",
	Texas: "TX",
	Utah: "UT",
	Vermont: "VT",
	Virginia: "VA",
	Washington: "WA",
	"West Virginia": "WV",
	Wisconsin: "WI",
	Wyoming: "WY",
	"District of Columbia": "DC",
	"Puerto Rico": "PR",
}

const STREETS = [
	"Main St",
	"Oak Ave",
	"Maple Dr",
	"Park Ave",
	"1st St",
	"2nd Ave",
	"Elm St",
	"Washington Blvd",
	"Lake Rd",
	"Hill St",
	"Cedar Ln",
	"Pine St",
	"Sunset Blvd",
	"Broadway",
	"Market St",
	"Church St",
	"5th Ave",
	"Highland Ave",
	"Center St",
]

const ZIP_RE = /^\d{5}$/

/** Collapse the space between a 2-letter region + adjacent number ('NY 10025' -> 'NY10025'). */
function glue(s: string): string {
	return s.replace(/\b([A-Z]{2})\s+(\d{3,5})\b/g, "$1$2")
}

// (name, fn) — canonical is the identity; the rest defeat rule cues (cf. perturb-golden.ts).
const PERTURBATIONS: Array<[string, (s: string) => string]> = [
	["canonical", (s) => s],
	["lowercase", (s) => s.toLowerCase()],
	["nocomma", (s) => s.replaceAll(",", "")],
	["glued", glue],
]

interface SprRow {
	id: number
	name: string | null
	latitude: number
	longitude: number
	ancestor_id: number
}

function loadRegions(con: DatabaseSync): Map<number, string> {
	const rows = con.prepare("SELECT id, name FROM spr WHERE placetype='region'").all() as Array<{
		id: number
		name: string
	}>
	const out = new Map<number, string>()
	for (const r of rows) out.set(r.id, r.name)
	return out
}

/** Return [(id, name, lat, lon, region_id)] — per-region seeded sample for state diversity. */
function sampleLocalities(con: DatabaseSync, perRegion: number, rng: SeededRandom): SprRow[] {
	const rows = con
		.prepare(
			"SELECT s.id, s.name, s.latitude, s.longitude, a.ancestor_id " +
				"FROM spr s JOIN ancestors a ON a.id = s.id AND a.ancestor_placetype='region' " +
				"WHERE s.placetype='locality' AND s.country='US' AND s.latitude != 0 AND s.is_current != 0 " +
				"ORDER BY s.id" // deterministic order; rng.sample picks reproducibly
		)
		.all() as unknown as SprRow[]
	const byRegion = new Map<number, SprRow[]>()
	for (const r of rows) {
		let group = byRegion.get(r.ancestor_id)
		if (!group) {
			group = []
			byRegion.set(r.ancestor_id, group)
		}
		group.push(r)
	}
	const out: SprRow[] = []
	for (const group of byRegion.values()) {
		out.push(...rng.sample(group, Math.min(perRegion, group.length)))
	}
	return out
}

function samplePostcodes(con: DatabaseSync, n: number, rng: SeededRandom): SprRow[] {
	const rows = con
		.prepare(
			"SELECT s.id, s.name, s.latitude, s.longitude, a.ancestor_id " +
				"FROM spr s JOIN ancestors a ON a.id = s.id AND a.ancestor_placetype='region' " +
				"WHERE s.placetype='postalcode' AND s.latitude != 0 AND s.is_current != 0 " +
				"ORDER BY s.id"
		)
		.all() as unknown as SprRow[]
	const filtered = rows.filter((r) => ZIP_RE.test(String(r.name ?? "")))
	return rng.sample(filtered, Math.min(n, filtered.length))
}

/** Insertion-ordered Counter, rendered like Python's `dict(Counter(...))`. */
function counter(values: Iterable<string>): Map<string, number> {
	const m = new Map<string, number>()
	for (const v of values) m.set(v, (m.get(v) ?? 0) + 1)
	return m
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			admin: { type: "string", default: "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db" },
			postcode: { type: "string", default: "/mnt/playpen/mailwoman-data/wof/postalcode-us.db" },
			"per-region": { type: "string", default: "8" },
			postcodes: { type: "string", default: "120" },
			seed: { type: "string", default: "20260530" },
			out: { type: "string", default: "/tmp/wof-bootstrap/eval.jsonl" },
		},
	})
	const perRegion = Number(values["per-region"])
	const nPostcodes = Number(values.postcodes)
	const out = values.out!
	const rng = new SeededRandom(Number(values.seed))

	const ca = new DatabaseSync(values.admin!, { readOnly: true })
	const regions = loadRegions(ca)
	const locs = sampleLocalities(ca, perRegion, rng)
	ca.close()
	// Postcodes are opt-in (the custom build is admin-only).
	let pcs: SprRow[] = []
	if (values.postcode && existsSync(values.postcode)) {
		const cp = new DatabaseSync(values.postcode, { readOnly: true })
		pcs = samplePostcodes(cp, nPostcodes, rng)
		cp.close()
	}

	const rows: Record<string, unknown>[] = []

	function emit(baseString: string, perturbTargets: string[], template: string, label: Record<string, unknown>): void {
		// perturb_targets: which perturbations to apply (some are no-ops for some templates)
		for (const [pname, fn] of PERTURBATIONS) {
			if (!perturbTargets.includes(pname)) continue
			const s = fn(baseString)
			if (pname !== "canonical" && s === baseString) continue // perturbation was a no-op
			rows.push({ template, ...label, input: s, perturb: pname })
		}
	}

	for (const loc of locs) {
		const regionName = regions.get(loc.ancestor_id)
		if (!regionName) continue
		const abbr = STATE_ABBREV[regionName] ?? regionName
		const label: Record<string, unknown> = {
			expected_id: loc.id,
			acceptable_ids: [loc.id, loc.ancestor_id],
			specificity: "locality",
			lat: loc.latitude,
			lon: loc.longitude,
			expected: { locality: loc.name, region: abbr },
			source: "wof-bootstrap",
		}
		// full (synthetic house+street) and no-street; comma/lowercase apply, glue doesn't (no ZIP)
		const house = rng.randint(1, 9999)
		const street = rng.choice(STREETS)
		emit(`${house} ${street}, ${loc.name}, ${abbr}`, ["canonical", "lowercase", "nocomma"], "full", label)
		emit(`${loc.name}, ${abbr}`, ["canonical", "lowercase", "nocomma"], "no_street", label)
	}

	for (const pc of pcs) {
		const regionName = regions.get(pc.ancestor_id)
		const abbr = regionName ? (STATE_ABBREV[regionName] ?? regionName) : null
		const label: Record<string, unknown> = {
			expected_id: pc.id,
			acceptable_ids: regionName ? [pc.id, pc.ancestor_id] : [pc.id],
			specificity: "postcode",
			lat: pc.latitude,
			lon: pc.longitude,
			expected: abbr ? { postcode: pc.name, region: abbr } : { postcode: pc.name },
			source: "wof-bootstrap",
		}
		if (abbr) {
			// region+postcode exercises the glue perturbation ("NY 10025" -> "NY10025")
			emit(`${abbr} ${pc.name}`, ["canonical", "lowercase", "glued"], "region_postcode", label)
		}
		emit(`${pc.name}`, ["canonical"], "postcode", label)
	}

	mkdirSync(dirname(out), { recursive: true })
	writeFileSync(out, rows.map((r) => pyJsonDumps(r) + "\n").join(""))
	console.log(`wrote ${rows.length} rows -> ${out}`)
	console.log(`by specificity: ${pyReprDict(counter(rows.map((r) => r.specificity as string)))}`)
	console.log(`by template: ${pyReprDict(counter(rows.map((r) => r.template as string)))}`)
	console.log(`by perturb: ${pyReprDict(counter(rows.map((r) => r.perturb as string)))}`)
	const regionCount = new Set(locs.map((l) => l.ancestor_id)).size
	console.log(`localities sampled: ${locs.length} across ${regionCount} regions; postcodes: ${pcs.length}`)
}

await main()
