/**
 * @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
 *
 *   #370 SPAN-RESCORE validator — the BUILD of the lever the rescore-ceiling-probe greenlit.
 *
 *   The probe + its falsifier established two things: (1) 116/259 unresolved EU rows are "swaps" — the
 *   gold locality IS in the gazetteer but the model emitted a different/fragmented token (e.g. the model
 *   splits "Grudziądz" into "Grudzi"+"dz" on the ą combining mark, #555, so it never resolves); (2) the
 *   gold locality, postcode-disambiguated, resolves p50 1.8 km from truth — a REAL coordinate, not a
 *   same-name mirage. So the open question this script answers is the BUILD's: can a post-hoc span
 *   relabel RECOVER the right locality span WITHOUT being told the gold — by enumerating the RAW tokens
 *   (diacritics intact, unlike the model's subwords) and exact-matching the same-country gazetteer?
 *
 *   The rescore (DeepSeek-validated design):
 *     - Fires ONLY when the parse is currently unresolved (the #685 brake — never second-guess a
 *       working coordinate).
 *     - Enumerates contiguous RAW-token spans ≤4 tokens, skipping any span that overlaps a CONFIDENT
 *       street / house_number / postcode node (those are the parse's load-bearing constituents).
 *     - Exact canonical same-country gazetteer match (normalized: lowercase, strip diacritics/punct).
 *     - SHORTEST matching span wins (the over-merge guard: "Santa Maria" beats "Santa Maria da Feira").
 *
 *   Measures, on the same 7-locale coord panel: recovery rate (how many swaps the enumeration recovers),
 *   gold-match rate (did it recover the RIGHT locality), and the recovered coord p50/p90 vs truth — the
 *   honest test of whether the production rescore moves coordinates.
 *
 *   Run: node --experimental-strip-types scripts/eval/span-rescore-validate.ts [--n 150]
 */
import { createWofResolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"
import { existsSync, readFileSync } from "node:fs"
import { arg } from "../lib/cli-args.ts"

const TOK = "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
const CARD = "neural-weights-en-us/model-card.json"
const ANCHOR = "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json"
const WOF = "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db"
const MODEL = arg("model", "out/v191/model.onnx")
const N = Number(arg("n", "150"))
const LOCALES: [string, string][] = [
	["IT", "data/eval/external/oa-it-coord-150.jsonl"],
	["PT", "data/eval/external/oa-pt-coord-150.jsonl"],
	["PL", "data/eval/external/oa-pl-coord-150.jsonl"],
	["AT", "data/eval/external/oa-at-coord-150.jsonl"],
	["CZ", "data/eval/external/oa-cz-coord-150.jsonl"],
	["FR", "data/eval/external/oa-fr-coord-150.jsonl"],
	["AU", "data/eval/external/oa-au-coord-150.jsonl"],
]

type N9 = { placeId?: string; children?: unknown[] }
const hasWof = (n: N9): boolean => !!n.placeId?.startsWith("wof:") || ((n.children as N9[]) ?? []).some(hasWof)

const pctile = (xs: number[], p: number): number => {
	if (!xs.length) return NaN
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}
const norm = (s: string): string =>
	s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.trim()

interface RawTok {
	text: string
	start: number
	end: number
}
/** Whitespace/punctuation tokenization of the raw, char offsets preserved, diacritics intact. */
const tokenizeRaw = (raw: string): RawTok[] => {
	const toks: RawTok[] = []
	const re = /[^\s,;/]+/g
	let m: RegExpExecArray | null
	while ((m = re.exec(raw)) !== null) toks.push({ text: m[0], start: m.index, end: m.index + m[0].length })
	return toks
}

type FlatNode = { tag: string; conf: number; start: number; end: number }
const flatten = (roots: unknown[]): FlatNode[] => {
	const out: FlatNode[] = []
	const walk = (ns: unknown[]) => {
		for (const n of ns as { tag?: string; confidence?: number; start?: number; end?: number; children?: unknown[] }[]) {
			if (n.tag && n.start != null && n.end != null)
				out.push({ tag: n.tag, conf: n.confidence ?? 0, start: n.start, end: n.end })
			if (n.children) walk(n.children)
		}
	}
	walk(roots)
	return out
}

interface Lookup {
	findPlace(q: {
		text: string
		country?: string
		postcode?: string
		limit?: number
	}): Promise<{ name: string; lat: number; lon: number; exactMatch?: boolean }[]>
}

/**
 * The production span-rescore. Returns the recovered locality {text, span, lat, lon} or null. Pure
 * post-hoc: it does not touch the existing parse beyond reading it for confident-constituent
 * ranges.
 */
async function spanRescore(
	raw: string,
	roots: unknown[],
	lookup: Lookup,
	country: string,
	postcode: string | undefined,
	/** Postcode→point anchor for the consistency gate, resolved by the caller (null when unavailable). */
	anchor: { lat: number; lon: number } | null,
	/** Reject a candidate match farther than this from the postcode anchor. 0 disables the gate. */
	gateKm: number
): Promise<{ text: string; start: number; end: number; lat: number; lon: number } | null> {
	const toks = tokenizeRaw(raw)
	// Confident constituents to never absorb into a locality span (the load-bearing parse parts).
	const avoid = flatten(roots).filter(
		(n) => (n.tag === "postcode" || n.tag === "house_number" || n.tag === "street") && n.conf >= 0.7
	)
	const overlapsAvoid = (s: number, e: number) => avoid.some((a) => s < a.end && a.start < e)

	// Enumerate contiguous token spans, SHORTEST first (the over-merge guard).
	type Span = { text: string; start: number; end: number; i: number; j: number }
	const spans: Span[] = []
	for (let len = 1; len <= 4; len++) {
		for (let i = 0; i + len <= toks.length; i++) {
			const j = i + len - 1
			const start = toks[i]!.start
			const end = toks[j]!.end
			if (overlapsAvoid(start, end)) continue
			spans.push({ text: raw.slice(start, end), start, end, i, j })
		}
	}
	// LONGEST (most-specific) span first. Diagnostic finding (#370 build): the gold locality is usually
	// the LONGER multi-token name ("Tomaszów Mazowiecki", "Nogueira Do Cravo"); shortest-wins grabs the
	// ambiguous prefix ("Tomaszów") which resolves to a DIFFERENT same-name place 100+ km away. Prefer
	// the longest exact match so the specific name beats its own prefix. (DeepSeek's shortest-wins guard
	// was aimed at the opposite over-merge; on real OA the disambiguating tail token makes longest right.)
	spans.sort((a, b) => b.j - b.i - (a.j - a.i))

	for (const sp of spans) {
		const key = norm(sp.text)
		if (key.length < 2 || /^\d+$/.test(key)) continue // skip bare numbers / empties
		const hits = await lookup.findPlace({ text: sp.text, country, postcode, limit: 5 })
		const exact = hits.filter((h) => h.exactMatch && norm(h.name) === key && (h.lat !== 0 || h.lon !== 0))
		for (const h of exact) {
			// Postcode-consistency gate: when the postcode resolves to a point, reject a match that lands
			// nowhere near it — the coverage-gap false-positive ("Pereiro" 200 km from the postcode is the
			// wrong Pereiro). When the postcode doesn't resolve (PL/PT/AU here), the gate can't fire and the
			// rescore falls through to longest-exact-match — so it never HURTS the locales it can't gate.
			if (anchor && gateKm > 0 && haversineKm(anchor.lat, anchor.lon, h.lat, h.lon) > gateKm) continue
			return { text: sp.text, start: sp.start, end: sp.end, lat: h.lat, lon: h.lon }
		}
	}
	return null
}

async function main() {
	const { createScorer } = await import("@mailwoman/neural/scorer")
	const { WofSqlitePlaceLookup, WofCandidateTableLookup } = await import("@mailwoman/resolver-wof-sqlite")
	const lookup = new WofSqlitePlaceLookup({ databasePath: WOF }) as unknown as Lookup & {
		findPlace: Lookup["findPlace"]
	}
	// Postcode→point anchor for the consistency gate. The candidate gazetteer folds postcodes as
	// queryable rows (the demo's resolver); IT/CZ postcodes resolve here, PL/PT/AU don't (gate no-ops there).
	const GATE_KM = Number(arg("gate", "50")) // 0 disables the gate
	const CAND = arg("candidate-db", "/mnt/playpen/mailwoman-data/wof/candidate-global-20h.db")
	const pcLookup = new WofCandidateTableLookup({ databasePath: CAND }) as unknown as Lookup
	const resolver = createWofResolver(lookup as never)
	const model = await createScorer({
		modelPath: MODEL,
		tokenizerPath: TOK,
		modelCardPath: CARD,
		anchorLookupPath: ANCHOR,
		strict: true,
		tier: "server",
	})

	console.log(`loc | unres | recov goldMatch | recovKm p50/p90 | net-resolve-lift`)
	const G = { unres: 0, recov: 0, gold: 0 }
	const recovKm: number[] = []
	for (const [cc, file] of LOCALES) {
		if (!existsSync(file)) continue
		const rows = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.slice(0, N)
			.map((l) => JSON.parse(l))
		const s = { unres: 0, recov: 0, gold: 0 }
		const km: number[] = []
		for (const row of rows) {
			const tree = await model.parse(row.raw, { postcodeRepair: true })
			const r = await resolver.resolveTree(tree as never, { defaultCountry: cc })
			if ((r.roots as N9[]).some(hasWof)) continue
			s.unres++
			const pc = ((row.components?.postcode ?? "") as string).toString().trim() || undefined
			// Resolve the postcode anchor for the consistency gate (once per row).
			let anchor: { lat: number; lon: number } | null = null
			if (pc && GATE_KM > 0) {
				const pcHits = await pcLookup.findPlace({ text: pc, country: cc, limit: 2 })
				const a = pcHits.find((h) => h.lat !== 0 || h.lon !== 0)
				if (a) anchor = { lat: a.lat, lon: a.lon }
			}
			const hit = await spanRescore(row.raw, (tree as { roots: unknown[] }).roots, lookup, cc, pc, anchor, GATE_KM)
			if (!hit) continue
			s.recov++
			const gold = ((row.components?.locality as string) ?? "").toString().trim()
			const isGold = norm(hit.text) === norm(gold)
			if (isGold) s.gold++
			const tLat = Number(row.lat),
				tLon = Number(row.lon)
			const dist = Number.isFinite(tLat) && Number.isFinite(tLon) ? haversineKm(tLat, tLon, hit.lat, hit.lon) : NaN
			if (Number.isFinite(dist)) km.push(dist)
			if (process.env.DEBUG && !isGold)
				console.error(
					`  [${cc}] WRONG: raw="${row.raw}" gold="${gold}" → recovered="${hit.text}" pc=${pc ?? "-"} dist=${dist.toFixed(0)}km`
				)
		}
		const kmStr = km.length ? `${pctile(km, 50).toFixed(1)}/${pctile(km, 90).toFixed(0)} (n${km.length})` : "—"
		const lift = s.unres ? `${((100 * s.recov) / s.unres).toFixed(0)}% of unres recovered` : "—"
		console.log(
			`${cc.padEnd(3)} | ${String(s.unres).padEnd(5)} | ${String(s.recov).padEnd(5)} ${String(s.gold).padEnd(9)} | ${kmStr.padEnd(15)} | ${lift}`
		)
		G.unres += s.unres
		G.recov += s.recov
		G.gold += s.gold
		recovKm.push(...km)
	}
	// Coordinate-quality breakdown — the metric that matters (#566): grade the assembled coordinate, not
	// the gold STRING (a "Santa Eulália" vs gold "Santa Eulália Viz" is 1 km, coordinate-right but
	// string-wrong). @25 km is the benchmark's right-place bar.
	const within = (r: number) => recovKm.filter((d) => d <= r).length
	const n = recovKm.length || 1
	console.log(
		`\n#370 SPAN-RESCORE (v4.13.0, raw-token enumeration + longest exact same-country gazetteer match):\n` +
			`   unresolved tail = ${G.unres} → recovered = ${G.recov} (${((100 * G.recov) / Math.max(G.unres, 1)).toFixed(0)}% of the tail)\n` +
			`   of recovered, RIGHT locality (== gold STRING) = ${G.gold} (${((100 * G.gold) / Math.max(G.recov, 1)).toFixed(0)}%)\n` +
			`   recovered coord vs truth: p50 ${pctile(recovKm, 50).toFixed(1)} km · p90 ${pctile(recovKm, 90).toFixed(0)} km (n${recovKm.length})\n` +
			`   coordinate quality: ≤10km ${within(10)} (${((100 * within(10)) / n).toFixed(0)}%) · ≤25km ${within(25)} (${((100 * within(25)) / n).toFixed(0)}%) · ≤100km ${within(100)} (${((100 * within(100)) / n).toFixed(0)}%) · >100km ${n - within(100)}\n` +
			`   → NET lift: ${within(25)} of ${G.unres} unresolved EU rows now resolve RIGHT-PLACE (@25km) — ${((100 * within(25)) / Math.max(G.unres, 1)).toFixed(0)}% of the no-result tail, at the cost of ${n - within(100)} >100km mis-fires (the coverage-gap false-positives a postcode-region gate would reject).`
	)
}
await main()
