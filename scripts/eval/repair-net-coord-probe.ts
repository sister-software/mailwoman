/**
 * @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
 *
 *   #723 net-COORD probe (DeepSeek consult 019ef789, turn 3B). Label-F1 says kill repairLeadingHouseNumber
 *   (−302 postcode); this measures the PRODUCT metric (coord resolve) so the kill decision rides on the
 *   right number. The repair fires on two leading-5-digit shapes; we render each from REAL US coord rows
 *   (overture NAD holdout, true lat/lon) and resolve with the repair ON (conventions=auto) vs OFF
 *   (conventions=false — the repair is the only US-active conventions pass, so this is the kill state):
 *     - rural   : "{hn5} {street}, {state}" — leading is the HOUSE NUMBER. Repair HELPS (recovers it).
 *     - pclead  : "{zip} {street}, {state}"  — leading is the POSTCODE. Repair HURTS (destroys it).
 *   Net(kill) = pclead gain − rural loss, weighted by real prevalence (reported separately; prevalence
 *   is a judgement call). Resolver = candidate gazetteer (admin/postcode centroids), so the rural ROOFTOP
 *   win #723 bought (within-1km) is below this probe's resolution — that loss is the known +3.8pt #723
 *   number and is flagged, not re-measured here.
 *
 *   Run: node --experimental-strip-types scripts/eval/repair-net-coord-probe.ts --model out/v192/model.onnx \
 *        --candidate-db /mnt/playpen/mailwoman-data/wof/candidate-global-20j.db --n 150
 */
import type { AddressNode, AddressTree } from "@mailwoman/resolver"
import { createWofResolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"
import { readFileSync } from "node:fs"

const arg = (k: string, d = ""): string => {
	const i = process.argv.indexOf(`--${k}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d
}
const MODEL = arg("model", "out/v192/model.onnx")
const CAND = arg("candidate-db", "/mnt/playpen/mailwoman-data/wof/candidate-global-20j.db")
const N = Number(arg("n", "150"))
const FILE = arg("file", "data/eval/external/overture-us-nad-holdout.jsonl")

const RANK: Record<string, number> = {
	country: 0,
	region: 1,
	county: 3,
	localadmin: 4,
	locality: 5,
	neighbourhood: 7,
	street: 9,
	address: 10,
}
function bestCoord(tree: AddressTree): { lat: number; lon: number } | null {
	let best: { lat: number; lon: number; r: number } | null = null
	const visit = (n: AddressNode): void => {
		const pt = String(n.sourceId ?? "").split(":")[0] ?? ""
		if (n.placeId?.startsWith("wof:") && n.lat !== undefined && n.lon !== undefined && (n.lat !== 0 || n.lon !== 0)) {
			const r = RANK[pt] ?? 5
			if (!best || r > best.r) best = { lat: n.lat, lon: n.lon, r }
		}
		for (const c of n.children ?? []) visit(c)
	}
	for (const r of tree.roots) visit(r)
	return best ? { lat: best.lat, lon: best.lon } : null
}

interface Row {
	input: string
	lat: number
	lon: number
	expected: { locality?: string; region?: string; postcode?: string }
	state?: string
}

async function main() {
	const { createScorer } = await import("@mailwoman/neural/scorer")
	const { WofCandidateTableLookup } = await import("@mailwoman/resolver-wof-sqlite")
	const resolver = createWofResolver(new WofCandidateTableLookup({ databasePath: CAND }) as never)
	const base = {
		modelPath: MODEL,
		tokenizerPath: "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model",
		modelCardPath: "neural-weights-en-us/model-card.json",
		anchorLookupPath: "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json",
		strict: true,
		tier: "server" as const,
	}
	// repair ON = conventions auto (US gate fires repairLeadingHouseNumber); OFF = conventions disabled.
	const on = await createScorer({ ...base, overrides: { conventions: "auto" } } as never)
	const off = await createScorer({ ...base, overrides: { conventions: false } } as never)

	const all = readFileSync(FILE, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as Row)
	// Only rows whose leading token is a 5-digit house number (the bare-5-digit shape the repair gates on)
	// and that carry a postcode + region, so both renders are well-formed.
	const rows: Array<{ hn: string; street: string; state: string; zip: string; lat: number; lon: number }> = []
	for (const r of all) {
		const m = r.input.match(/^(\d{5})\s+([^,]+),/)
		const state = r.expected.region ?? r.state ?? ""
		const zip = r.expected.postcode ?? ""
		if (m && state && /^\d{5}$/.test(zip))
			rows.push({ hn: m[1]!, street: m[2]!.trim(), state, zip, lat: r.lat, lon: r.lon })
		if (rows.length >= N) break
	}

	const opts = { defaultCountry: "US", spanRescore: true, postcodeConsistency: true } as never
	const score = async (raw: string, scorer: { parse: (t: string, o?: unknown) => Promise<unknown> }) => {
		const c = bestCoord(
			(await resolver.resolveTree((await scorer.parse(raw, { postcodeRepair: true })) as never, opts)) as never
		)
		return c
	}
	const strata = {
		rural: { on25: 0, off25: 0, on5: 0, off5: 0 },
		pclead: { on25: 0, off25: 0, on5: 0, off5: 0 },
	}
	let n = 0
	for (const row of rows) {
		const truth = { lat: row.lat, lon: row.lon }
		n++
		const ruralRaw = `${row.hn} ${row.street}, ${row.state}` // leading = house number
		const pcRaw = `${row.zip} ${row.street}, ${row.state}` // leading = postcode
		for (const [key, raw] of [
			["rural", ruralRaw],
			["pclead", pcRaw],
		] as const) {
			const cOn = await score(raw, on as never)
			const cOff = await score(raw, off as never)
			if (cOn) {
				const d = haversineKm(truth.lat, truth.lon, cOn.lat, cOn.lon)
				if (d <= 25) strata[key].on25++
				if (d <= 5) strata[key].on5++
			}
			if (cOff) {
				const d = haversineKm(truth.lat, truth.lon, cOff.lat, cOff.lon)
				if (d <= 25) strata[key].off25++
				if (d <= 5) strata[key].off5++
			}
		}
	}
	const pct = (x: number) => ((100 * x) / Math.max(n, 1)).toFixed(0)
	console.log(`\n#723 net-COORD probe — ${MODEL}  (n=${n} real US rows, rendered in 2 repair-triggering shapes)`)
	console.log(`  repair ON = conventions=auto (the live config) | repair OFF = the kill state\n`)
	for (const [key, label] of [
		["rural", 'rural  "{hn5} {street}, {state}"  (leading = HOUSE#; repair helps)'],
		["pclead", 'pclead "{zip} {street}, {state}"   (leading = POSTCODE; repair hurts)'],
	] as const) {
		const s = strata[key]
		console.log(`  ${label}`)
		console.log(
			`     @25km  repairON ${pct(s.on25)}%  repairOFF ${pct(s.off25)}%   kill Δ ${s.off25 - s.on25 >= 0 ? "+" : ""}${pct(s.off25 - s.on25)}pp`
		)
		console.log(
			`     @5km   repairON ${pct(s.on5)}%  repairOFF ${pct(s.off5)}%   kill Δ ${s.off5 - s.on5 >= 0 ? "+" : ""}${pct(s.off5 - s.on5)}pp`
		)
	}
	console.log(`\n  NOTE: candidate-gazetteer resolver = admin/postcode centroids; the rural ROOFTOP win #723 bought`)
	console.log(`  (within-1km) is below this resolution and not captured here — that is the known +3.8pt #723 trade.`)
}
await main()
