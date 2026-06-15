/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Coverage reconciliation (#621) — THE PRODUCT OUTPUT: what replaces inspecting the map by eye.
 *
 *   Over the entities resolved across sources (#618), classify each by which KIND of source its
 *   records come from:
 *
 *   - **eligibility** sources — entities that exist as providers / facilities: NPPES org NPIs, TX HHSC
 *       nursing facilities.
 *   - **funding** source — entities enrolled in a funding program: FCC Rural Health Care filings.
 *
 *   Three buckets fall out:
 *
 *   - **enrolled** — resolves to BOTH an eligibility and a funding record.
 *   - **eligible, not enrolled** — an eligibility record with NO funding record resolving to it (the
 *       ANTI-JOIN: the set you currently find by eye).
 *   - **funded, not in the eligibility set** — a funding record with no eligibility record resolving to
 *       it.
 *
 *   Output: GeoJSON (drops on the same map) + a table, each entity tagged with its bucket + source
 *   memberships. We produce the reconciled join; what a gap MEANS — and whether it's real or a
 *   sampling artifact — is the consumer's call, not ours. This is strictly a set-membership
 *   reconciliation, never an allegation.
 *
 *   Run: node --experimental-strip-types scripts/record-matcher/coverage-reconciliation.ts\
 *   [--cap 2000] [--wof <admin.db>] [--data-root <dir>] [--out-md <md>] [--out-geojson <geojson>]
 */

import { decodeAsJson } from "@mailwoman/core/decoder"
import { createWofResolver, type ResolverBackend } from "@mailwoman/core/resolver"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import {
	geocodeAddressVia,
	ingestRows,
	resolveEntities,
	streamRows,
	type ColumnMapping,
	type ResolvedEntity,
	type SourceRecord,
} from "@mailwoman/registry"
import { writeFileSync } from "node:fs"
import { geocodeAddress, ShardProvider } from "../../mailwoman/out/geocode-core.js"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const SOURCES = arg("sources", "/mnt/playpen/mailwoman-data/record-matcher/sources")
const CAP = Number(arg("cap", "2000"))
const STATE = arg("state", "TX").toUpperCase()
const WOF = arg("wof", "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db")
const DATA_ROOT = arg("data-root", "/mnt/playpen/mailwoman-data")
const OUT_MD = arg("out-md", "")
const OUT_GEOJSON = arg("out-geojson", "")

const norm = (s: string | undefined) => (s ?? "").trim()

/** Which kind of source a record's provenance label denotes. */
const ELIGIBILITY = new Set(["nppes", "txhhsc-nursing"])
const FUNDING = new Set(["fcc-rhc"])

interface SourceSpec {
	source: string
	path: string
	mapping: ColumnMapping
	inState: (row: Record<string, string>) => boolean
}

const S = `${SOURCES}`
const SPECS: SourceSpec[] = [
	{
		source: "txhhsc-nursing",
		path: `${S}/txhhsc_nursing-facilities_20260611.tsv`,
		mapping: {
			id: "Facility ID",
			organization: "Facility Name",
			address: ["Physical Address", "Physical Address CITY", "Physical Address State", "Physical Address Zipcode"],
			phone: "Facility Phone Number",
			source: "txhhsc-nursing",
		},
		inState: (r) => norm(r["Physical Address State"]).toUpperCase() === STATE,
	},
	{
		source: "fcc-rhc",
		path: `${S}/fcc-rhc_posted-services_form461-465_20260615.tsv`,
		mapping: {
			id: "HCP Number",
			organization: "HCP Name",
			address: ["Site Address Line 1", "Site City", "Site State", "Site ZIP Code"],
			phone: "Contact Phone",
			email: "Contact E-mail",
			source: "fcc-rhc",
		},
		inState: (r) => norm(r["Site State"]).toUpperCase() === STATE,
	},
	{
		source: "nppes",
		path: `${S}/nppes_npi-registry_20260607.tsv`,
		mapping: {
			id: "NPI",
			organization: "Provider Organization Name (Legal Business Name)",
			address: [
				"Provider First Line Business Practice Location Address",
				"Provider Business Practice Location Address City Name",
				"Provider Business Practice Location Address State Name",
				"Provider Business Practice Location Address Postal Code",
			],
			phone: "Provider Business Practice Location Address Telephone Number",
			source: "nppes",
		},
		inState: (r) =>
			norm(r["Provider Business Practice Location Address State Name"]).toUpperCase() === STATE &&
			norm(r["Entity Type Code"]) === "2" &&
			!!norm(r["Provider Organization Name (Legal Business Name)"]),
	},
]

type Bucket = "enrolled" | "eligible-not-enrolled" | "funded-not-eligible"

function bucketOf(sources: Set<string>): Bucket {
	const hasEligibility = [...sources].some((s) => ELIGIBILITY.has(s))
	const hasFunding = [...sources].some((s) => FUNDING.has(s))
	if (hasEligibility && hasFunding) return "enrolled"
	if (hasEligibility) return "eligible-not-enrolled"
	return "funded-not-eligible"
}

async function main(): Promise<void> {
	// --- Ingest each source into one combined record set (geo-first resolve). ---
	const rawBySource = new Map<string, Record<string, string>[]>()
	for (const spec of SPECS) {
		console.error(`[A] ${spec.source}: streaming + ${STATE} filter (cap ${CAP})…`)
		const kept: Record<string, string>[] = []
		for await (const row of streamRows(spec.path)) {
			if (!spec.inState(row)) continue
			kept.push(row)
			if (kept.length >= CAP) break
		}
		rawBySource.set(spec.source, kept)
		console.error(`    ${spec.source}: ${kept.length} rows`)
	}

	console.error("[B] building the geocoder…")
	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
	const mod = await import("@mailwoman/resolver-wof-sqlite")
	const lookup = new mod.WofSqlitePlaceLookup({ databasePath: WOF })
	const resolver = createWofResolver(lookup as unknown as ResolverBackend)
	const shardProvider = new ShardProvider(mod, DATA_ROOT)

	let geo = 0
	let total = 0
	const seam = geocodeAddressVia({
		parse: async (raw: string) => decodeAsJson(await classifier.parse(raw, { postcodeRepair: true })),
		geocode: async (raw: string) => {
			const g = await geocodeAddress(raw, {
				classifier,
				resolver,
				shards: shardProvider.for,
				defaultCountry: "US",
				placeCountry: false,
			})
			total++
			if (g.lat !== null) geo++
			return g
		},
		country: "US",
	})

	console.error("[C] geocoding + ingesting…")
	const records: SourceRecord[] = []
	for (const spec of SPECS) {
		const recs = await ingestRows(rawBySource.get(spec.source)!, spec.mapping, { geocodeAddress: seam })
		for (const r of recs) r.id = `${spec.source}:${r.id}`
		records.push(...recs)
	}
	shardProvider.close()
	lookup.close()
	console.error(`    ${records.length} records; geocoded ${geo}/${total} (${((100 * geo) / total).toFixed(1)}%)`)

	console.error("[D] resolving + reconciling…")
	const { entities } = resolveEntities(records, { trainEM: true, collapseSpatial: true })

	// --- Classify every entity into a reconciliation bucket. ---
	const classified = entities.map((e) => {
		const sources = new Set(e.records.map((r) => r.source ?? "?"))
		return { e, sources, bucket: bucketOf(sources) }
	})
	const counts: Record<Bucket, number> = { enrolled: 0, "eligible-not-enrolled": 0, "funded-not-eligible": 0 }
	for (const c of classified) counts[c.bucket]++

	const repName = (e: ResolvedEntity) =>
		e.representative.organization?.canonical ??
		[e.representative.name?.given, e.representative.name?.family].filter(Boolean).join(" ") ??
		e.representative.id

	// --- GeoJSON: every located entity, tagged with bucket + sources (drops on the map). ---
	const features = classified
		.filter((c) => c.e.coordinate)
		.map((c) => ({
			type: "Feature" as const,
			geometry: { type: "Point" as const, coordinates: [c.e.coordinate!.longitude, c.e.coordinate!.latitude] },
			properties: {
				entityId: c.e.id,
				bucket: c.bucket,
				sources: [...c.sources].sort().join(","),
				name: repName(c.e),
				recordCount: c.e.records.length,
			},
		}))
	const geojson = { type: "FeatureCollection" as const, features }

	// --- Report. ---
	const eligibleTotal = counts.enrolled + counts["eligible-not-enrolled"]
	const enrolledRate = eligibleTotal > 0 ? counts.enrolled / eligibleTotal : 0
	const pct = (x: number) => (100 * x).toFixed(1)
	const lines: string[] = []
	lines.push(`# Coverage reconciliation — eligibility ↔ enrollment (#621)`)
	lines.push("")
	lines.push(
		`_Generated by \`scripts/record-matcher/coverage-reconciliation.ts\`. ${STATE}-scoped, ≤${CAP} rows per ` +
			`source, resolved BLIND across sources. **Eligibility** = NPPES org NPIs + TX HHSC nursing facilities; ` +
			`**funding/enrollment** = FCC Rural Health Care filings. Each resolved entity is classified by which kinds ` +
			`of source its records span. This is a **set-membership reconciliation, not a determination** — see the ` +
			`caveat below._`
	)
	lines.push("")
	lines.push(`## The reconciliation`)
	lines.push("")
	lines.push(`| bucket | entities | meaning |`)
	lines.push(`|---|---:|---|`)
	lines.push(`| **enrolled** | ${counts.enrolled} | resolves to an eligibility record AND a funding record |`)
	lines.push(
		`| **eligible, not enrolled** | ${counts["eligible-not-enrolled"]} | eligibility record, no funding record resolved (the **anti-join**) |`
	)
	lines.push(
		`| **funded, not in eligibility set** | ${counts["funded-not-eligible"]} | funding record, no eligibility record resolved |`
	)
	lines.push("")
	lines.push(
		`Of the ${eligibleTotal} entities with an eligibility record, ${pct(enrolledRate)}% also resolve to a funding ` +
			`record **in this capped sample** — a sampling FLOOR, not a coverage rate (most funding records fall outside ` +
			`the per-source cap; see the caveat below). The deliverable is the anti-join SET, not this percentage.`
	)
	lines.push("")
	lines.push(`## Anti-join spot-check — first 15 "eligible, not enrolled" (candidates for review)`)
	lines.push("")
	lines.push(`| entity | sources | name | coordinate |`)
	lines.push(`|---|---|---|---|`)
	for (const c of classified.filter((x) => x.bucket === "eligible-not-enrolled").slice(0, 15)) {
		const coord = c.e.coordinate ? `${c.e.coordinate.latitude.toFixed(4)}, ${c.e.coordinate.longitude.toFixed(4)}` : "—"
		lines.push(`| ${c.e.id} | ${[...c.sources].sort().join(", ")} | ${repName(c.e)} | ${coord} |`)
	}
	lines.push("")
	lines.push(`## The caveat that matters`)
	lines.push("")
	lines.push(
		`This is a **capped sample** (≤${CAP}/source), so "eligible, not enrolled" includes entities that ARE enrolled ` +
			`in reality but whose funding record fell outside the sample — a **sampling artifact, not a finding**. At full ` +
			`scale the anti-join tightens, but it is STILL only a set of candidates: a missing funding record can mean the ` +
			`entity didn't apply, applied under a different name we didn't resolve, is ineligible, or any number of things. ` +
			`We produce the reconciled join and surface the candidates; **what a gap means, and whether to act on it, is ` +
			`entirely the data consumer's call.** Nothing here is an allegation.`
	)
	lines.push("")

	const md = lines.join("\n")
	console.log(md)
	if (OUT_MD) {
		writeFileSync(OUT_MD, md)
		console.error(`[written] ${OUT_MD}`)
	}
	if (OUT_GEOJSON) {
		writeFileSync(OUT_GEOJSON, JSON.stringify(geojson))
		console.error(`[written] ${OUT_GEOJSON} (${features.length} features)`)
	}
}

await main()
