import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"

/**
 * @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
 *
 *   COMPETITIVE BENCHMARK — mailwoman vs Nominatim vs Pelias on identical real addresses, scored the
 *   honest way. The three systems return structurally different things (mailwoman: parse→resolve to a
 *   gazetteer centroid; Nominatim: the matched OSM object; Pelias: ES over mixed sources), so a raw
 *   median-error comparison flatters whoever returns rooftops on the addresses they DO match and hides
 *   who returns nothing on the messy tail. Instead we score TWO axes:
 *
 *     PRIMARY  — resolve-rate @ a COARSE correctness threshold (within Xkm of truth). "No result"
 *                counts as a MISS. This is the honest denominator: it surfaces coverage + graceful
 *                degradation and refuses to let rooftop precision hide a low match rate. We use COARSE
 *                thresholds (5/25 km = "right locality area") because mailwoman resolves to admin/
 *                postcode CENTROIDS — a km-to-rooftop metric would unfairly reward Nominatim's
 *                rooftop-when-it-matches and penalize our centroid. Right-PLACE is the fair test.
 *     SECONDARY — conditional accuracy (median error among the rows the system DID place), reported at
 *                a fine + coarse threshold, clearly "conditional on resolve".
 *
 *   Same golden rows for all three systems → apples-to-apples on identical inputs. The set is the real,
 *   held-out OA coordinate goldens (truth lat/lon). Pelias (geocode.earth) rides scripts/diag-geocode-
 *   earth.ts via a DYNAMIC import, so this committed harness degrades gracefully (Pelias row skipped)
 *   for anyone without the operator's diag.
 *
 *   Run: GEOCODE_EARTH_API_KEY=… node --experimental-strip-types scripts/eval/competitive-benchmark.ts \
 *          [--n 40] [--locales it,pt,pl,at,cz,fr,au] [--systems mailwoman,nominatim,pelias] [--out <md>]
 */
import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import { createWOFResolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"

import { arg } from "../lib/cli-args.ts"

const TOK = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
const CARD = "neural-weights-en-us/model-card.json"
const ANCHOR = dataRootPath("anchor", "pilot-anchor-lookup.json")
// Production-representative resolver: admin gazetteer + the intl postcode→locality shard (the
// oa-resolver-eval default). admin-ONLY handicaps mailwoman — the postcode-coordinate-first path
// resolves localities the admin gazetteer misses. --wof overrides (comma-separated shard paths).
const WOF = arg(
	"wof",
	`${dataRootPath("wof", "admin-global-priority.db")},${dataRootPath("wof", "postcode-locality-intl.db")}`
).split(",")
const MODEL = arg("model", "out/v191/model.onnx") // v4.13.0 int8
const N = Number(arg("n", "40"))
const LOCALES = arg("locales", "it,pt,pl,at,cz,fr,au").split(",")
const SYSTEMS = arg("systems", "mailwoman,nominatim,pelias").split(",")
const OUT = arg("out", "")
// --span-rescore grades mailwoman TWICE per row — base (lever off) AND #370 spanRescore (lever on) — from
// the SAME parse, so the off→on lift sits in the same harness as Nominatim/Pelias without doubling API calls.
const RESCORE = process.argv.includes("--span-rescore")
const THRESHOLDS = [1, 5, 25] // km — coarse "right-place" tiers
const NOMINATIM_UA = "mailwoman-benchmark/1.0 (teffen@sister.software)"
const MESSY = process.argv.includes("--messy")
// Real-world degradation — the slice where a calibrated parser should beat a search index that leans
// on exact tokens + the comma structure + the postcode. SAFE: drops commas/dash-postcodes + lowercases
// + abbreviates common street words; never touches the house number.
function messify(raw: string): string {
	let s = raw.toLowerCase()
	s = s.replace(/\b\d{2,4}-\d{2,3}\b/g, " ") // dash-postcodes (PT 7920-031, PL 59-920) — unambiguously postcodes
	s = s
		.replace(/\brua\b/g, "r")
		.replace(/\bavenida\b/g, "av")
		.replace(/\bestrada\b/g, "estr")
		.replace(/\bstra(?:ss|ß)e\b/g, "str")
		.replace(/\bstreet\b/g, "st")
		.replace(/\bvia\b/g, "v")
		.replace(/\bavenue\b/g, "ave")
	s = s.replace(/,/g, " ").replace(/\s+/g, " ").trim()

	// drop the comma structure, collapse spaces
	return s
}

const PLACETYPE_RANK: Record<string, number> = {
	country: 0,
	region: 1,
	macrocounty: 2,
	county: 3,
	localadmin: 4,
	locality: 5,
	borough: 6,
	macrohood: 6,
	neighbourhood: 7,
	microhood: 8,
	street: 9,
	address: 10,
	venue: 10,
}
type Resolved = { placetype: string; lat: number; lon: number }
function mostSpecificCoord(tree: AddressTree): { lat: number; lon: number } | null {
	let best: Resolved | null = null as Resolved | null
	const visit = (n: AddressNode): void => {
		if (n.placeID?.startsWith("wof:") && n.lat !== undefined && n.lon !== undefined) {
			const placetype = String(n.sourceID ?? "").split(":")[0] ?? ""

			if (!best || (PLACETYPE_RANK[placetype] ?? 5) > (PLACETYPE_RANK[best.placetype] ?? 5))
				best = { placetype, lat: n.lat, lon: n.lon }
		}

		for (const c of n.children) visit(c)
	}

	for (const r of tree.roots) visit(r)

	return best ? { lat: best.lat, lon: best.lon } : null
}
const p50 = (xs: number[]): number => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : NaN)

type Coord = { lat: number; lon: number } | null
async function queryNominatim(raw: string, cc: string): Promise<Coord> {
	try {
		const u = new URL("https://nominatim.openstreetmap.org/search")
		u.searchParams.set("q", raw)
		u.searchParams.set("format", "jsonv2")
		u.searchParams.set("limit", "1")
		u.searchParams.set("countrycodes", cc.toLowerCase())
		const r = await fetch(u, { headers: { "User-Agent": NOMINATIM_UA } })

		if (!r.ok) return null
		const j = (await r.json()) as Array<{ lat: string; lon: string }>

		return j[0] ? { lat: Number(j[0].lat), lon: Number(j[0].lon) } : null
	} catch {
		return null
	}
}
async function loadPelias(): Promise<((q: string, country: string) => Promise<Coord>) | null> {
	if (!process.env.GEOCODE_EARTH_API_KEY) return null

	try {
		// `diag-geocode-earth.ts` is the operator's local, git-excluded geocode.earth probe — present
		// only when GEOCODE_EARTH_API_KEY is set, absent in a clean checkout / CI. Indirect the
		// specifier through a variable so the type-checker doesn't resolve a file that isn't there
		// (the result is cast structurally below regardless).
		const earthDiagModule = "../diag-geocode-earth.ts"
		const mod = await import(earthDiagModule)
		const fetchGeocodeData = (
			mod as {
				fetchGeocodeData?: (
					q: string,
					country?: string
				) => Promise<{ features?: Array<{ geometry?: { coordinates?: [number, number] } }> }>
			}
		).fetchGeocodeData

		if (!fetchGeocodeData) return null

		return async (q: string, country: string) => {
			try {
				const fc = await fetchGeocodeData(q, country)
				const c = fc.features?.[0]?.geometry?.coordinates

				return c ? { lat: c[1], lon: c[0] } : null
			} catch {
				return null
			}
		}
	} catch {
		return null
	}
}
// geocode.earth's free dev key is rate-limited (1000/day, 10/s). Be graceful — well under the cap.
const PELIAS_GRACE_MS = 400

type Tally = { n: number; within: Record<number, number>; resolvedErrs: number[]; noResult: number }
const newTally = (): Tally => ({
	n: 0,
	within: Object.fromEntries(THRESHOLDS.map((t) => [t, 0])),
	resolvedErrs: [],
	noResult: 0,
})
function record(t: Tally, err: number | null) {
	t.n++

	if (err === null) {
		t.noResult++

		return
	}
	t.resolvedErrs.push(err)

	for (const th of THRESHOLDS) if (err <= th) t.within[th]!++
}

async function main() {
	const { createScorer } = await import("@mailwoman/neural/scorer")
	const { WOFSqlitePlaceLookup, WOFCandidateTableLookup } = await import("@mailwoman/resolver-wof-sqlite")
	// --candidate-db <path> uses the DEMO's resolver (the byte-range candidate gazetteer, with the
	// promoted EU postcode/GeoNames coverage); else the CLI shards (admin + postcode-locality-intl).
	const CAND = arg("candidate-db", "")
	const lookup = CAND
		? new WOFCandidateTableLookup({ databasePath: CAND })
		: new WOFSqlitePlaceLookup({ databasePath: WOF })
	const resolver = createWOFResolver(lookup as never)
	const model = SYSTEMS.includes("mailwoman")
		? await createScorer({
				modelPath: MODEL,
				tokenizerPath: TOK,
				modelCardPath: CARD,
				anchorLookupPath: ANCHOR,
				strict: true,
				tier: "server",
			})
		: null
	const pelias = SYSTEMS.includes("pelias") ? await loadPelias() : null

	if (SYSTEMS.includes("pelias") && !pelias)
		console.error("⚠ pelias: GEOCODE_EARTH_API_KEY or diag-geocode-earth.ts unavailable — skipping that row")
	const sys0 = SYSTEMS.filter((s) => s !== "pelias" || pelias)
	// Inject the lever-on column right after the base mailwoman column.
	const sys =
		RESCORE && sys0.includes("mailwoman")
			? sys0.flatMap((s) => (s === "mailwoman" ? ["mailwoman", "mailwoman+rescore"] : [s]))
			: sys0

	const tallies: Record<string, Record<string, Tally>> = {}

	// system -> locale -> tally
	for (const s of sys) tallies[s] = {}

	let totalParses = 0

	// global across locales — the periodic-GC trigger (see the loop body)
	for (const cc of LOCALES) {
		const file = `data/eval/external/oa-${cc}-coord-150.jsonl`

		if (!existsSync(file)) {
			console.error(`${cc}: golden missing — skipped`)
			continue
		}
		const rows = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.slice(0, N)
			.map((l) => JSON.parse(l)) as Array<{ raw: string; lat: number; lon: number }>

		for (const s of sys) tallies[s]![cc] = newTally()
		console.error(`\n[${cc.toUpperCase()}] ${rows.length} rows…`)
		let i = 0

		for (const row of rows) {
			const truth = { lat: row.lat, lon: row.lon }
			const input = MESSY ? messify(row.raw) : row.raw

			if (model) {
				const tree = await model.parse(input, { postcodeRepair: true })
				// resolveTree decorates in place — clone per config so base + lever are independent.
				const base = await resolver.resolveTree(structuredClone(tree) as never, { defaultCountry: cc.toUpperCase() })
				const cBase = mostSpecificCoord(base as never)
				record(tallies["mailwoman"]![cc]!, cBase ? haversineKm(cBase.lat, cBase.lon, truth.lat, truth.lon) : null)

				if (RESCORE) {
					const lever = await resolver.resolveTree(structuredClone(tree) as never, {
						defaultCountry: cc.toUpperCase(),
						spanRescore: true,
					})
					const cLever = mostSpecificCoord(lever as never)
					record(
						tallies["mailwoman+rescore"]![cc]!,
						cLever ? haversineKm(cLever.lat, cLever.lon, truth.lat, truth.lon) : null
					)
				}
			}

			if (sys.includes("nominatim")) {
				const c = await queryNominatim(input, cc)
				record(tallies["nominatim"]![cc]!, c ? haversineKm(c.lat, c.lon, truth.lat, truth.lon) : null)
				await sleep(1100) // respect Nominatim's ~1 req/s policy
			}

			if (pelias) {
				const c = await pelias(input, cc)
				record(tallies["pelias"]![cc]!, c ? haversineKm(c.lat, c.lon, truth.lat, truth.lon) : null)
				await sleep(PELIAS_GRACE_MS) // graceful: stay well under geocode.earth's 10/s + 1000/day
			}

			// onnxruntime-node accumulates native tensor memory across runs faster than JS GC reclaims it
			// (~380-parse SIGKILL on the lab box). Periodic forced GC reclaims it; run with `node
			// --expose-gc` for long panels. No-op without the flag.
			if (++totalParses % 50 === 0) (globalThis as { gc?: () => void }).gc?.()

			if (++i % 10 === 0) console.error(`  ${i}/${rows.length}`)
		}
	}

	// ── scorecard ────────────────────────────────────────────────────────────
	const lines: string[] = []
	lines.push(`# Competitive benchmark — mailwoman vs Nominatim vs Pelias (${new Date().toISOString().slice(0, 10)})`)
	lines.push(
		`\n_Identical real held-out OA addresses (truth lat/lon), ${N} rows/locale. PRIMARY metric: **resolve-rate @ coarse km threshold** (within Xkm of truth; "no result" = miss) — the honest denominator, fair to centroids. SECONDARY: conditional median error (resolved rows only). Systems: ${sys.join(", ")}._\n`
	)
	lines.push(`## Resolve-rate @ 25 km (right-locality-area — the headline)\n`)
	const head = `| locale | ${sys.map((s) => s).join(" | ")} |`
	lines.push(head, `|${"---|".repeat(sys.length + 1)}`)
	const agg: Record<string, Tally> = Object.fromEntries(sys.map((s) => [s, newTally()]))

	for (const cc of LOCALES) {
		if (!tallies[sys[0]!]?.[cc]) continue
		const cells = sys.map((s) => {
			const t = tallies[s]![cc]!

			for (const th of THRESHOLDS) agg[s]!.within[th]! += t.within[th]!
			agg[s]!.n += t.n
			agg[s]!.resolvedErrs.push(...t.resolvedErrs)
			agg[s]!.noResult += t.noResult

			return t.n ? `${((100 * t.within[25]!) / t.n).toFixed(0)}%` : "—"
		})
		lines.push(`| ${cc.toUpperCase()} | ${cells.join(" | ")} |`)
	}
	lines.push(
		`| **ALL** | ${sys.map((s) => (agg[s]!.n ? `**${((100 * agg[s]!.within[25]!) / agg[s]!.n).toFixed(0)}%**` : "—")).join(" | ")} |`
	)
	lines.push(`\n## Full two-axis (aggregate)\n`)
	lines.push(`| system | n | @1km | @5km | @25km | cond. p50 (km) | no-result |`)
	lines.push(`|---|--:|--:|--:|--:|--:|--:|`)

	for (const s of sys) {
		const t = agg[s]!
		lines.push(
			`| ${s} | ${t.n} | ${((100 * t.within[1]!) / t.n).toFixed(0)}% | ${((100 * t.within[5]!) / t.n).toFixed(0)}% | ${((100 * t.within[25]!) / t.n).toFixed(0)}% | ${p50(t.resolvedErrs).toFixed(1)} | ${((100 * t.noResult) / t.n).toFixed(0)}% |`
		)
	}
	const md = lines.join("\n") + "\n"
	console.log(md)

	if (OUT) {
		writeFileSync(OUT, md)
		console.error(`\nwrote ${OUT}`)
	}
}
await main()
