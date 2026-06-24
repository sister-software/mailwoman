/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CONFIDENCE-DISCRIMINATION — the differentiator a search index cannot draw.
 *
 *   mailwoman returns a coordinate AND a calibrated per-result confidence (the decoder's per-span
 *   `conf=`, mapped through the shipped isotonic table to a probability of correctness). Nominatim
 *   returns one best guess with no probability you can route on. This harness measures the
 *   operational payoff of that confidence on the inputs that matter — the messy ones — by sweeping a
 *   confidence threshold τ:
 *
 *     precision(τ) = right-place @25km among the answers mailwoman is ≥τ confident about
 *     recall(τ)    = fraction of all rows mailwoman answers at ≥τ confidence
 *
 *   As τ rises mailwoman trades recall for precision: it abstains when unsure. Nominatim is a SINGLE
 *   (precision, recall) point on the identical messy set — no threshold to sweep, no way to know
 *   which answers to trust. The curve clearing Nominatim's point to the upper-left is the story: a
 *   calibrated parser buys precision by abstaining; a search index cannot.
 *
 *   Honesty (the judge-proof part): the curve is the SHIPPED model's measured calibration, and the
 *   discrimination is verified on a HELD-OUT messy slice (50/50 by row index) the curve is not drawn
 *   on. If the low-confidence bucket does not actually err more out-of-sample, the story is staged
 *   and the harness says so.
 *
 *   Grading is coordinate-first: right-place @25km against the OA truth lat/lon, the same honest
 *   denominator as `competitive-benchmark.ts` ("no result" = miss). A slice where mailwoman loses
 *   stays in the output.
 *
 *   TWO per-result confidence aggregations are captured from one collection so the better
 *   discriminator can be chosen transparently:
 *     - `node` — calibrated conf of the most-specific RESOLVED node (the answer's own component).
 *     - `min`  — min calibrated conf across ALL resolved nodes (the weakest driving component; "the
 *                answer is only as trustworthy as its least-sure part").
 *
 *   Collection (parse + resolve + Nominatim) is separated from analysis (sweep + plot): pass
 *   `--rows-out <jsonl>` to persist the graded rows, then `--rows-in <jsonl>` to re-sweep / re-plot
 *   instantly without re-parsing. Nominatim is disk-cached and only rate-limited on a cache miss.
 *
 *   Run: node --experimental-strip-types scripts/eval/confidence-discrimination.ts \
 *          [--locales us,it,pt,pl,fr,au] [--n 80] [--model out/v191/model.onnx] [--no-messy] \
 *          [--rows-out <jsonl>] [--rows-in <jsonl>] [--out <md>] [--svg <svg>] \
 *          [--cache /tmp/nominatim-messy-cache.json] [--agg node|min]
 */
import type { AddressNode, AddressTree } from "@mailwoman/resolver"
import { createWofResolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"
import { createCalibrator } from "@mailwoman/core/decoder"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"

// The first collection died silently at PL ~60/80 (no JS stack → a process-level kill). Surface it
// next time instead of exiting blind; the incremental --rows-out checkpoint makes a crash recoverable.
process.on("unhandledRejection", (e) => console.error("UNHANDLED REJECTION:", e))
process.on("uncaughtException", (e) => console.error("UNCAUGHT EXCEPTION:", e))

const arg = (k: string, d = ""): string => {
	const i = process.argv.indexOf(`--${k}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d
}
const TOK = "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
const CARD = "neural-weights-en-us/model-card.json"
const ANCHOR = "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json"
const WOF = [
	"/mnt/playpen/mailwoman-data/wof/admin-global-priority.db",
	"/mnt/playpen/mailwoman-data/wof/postcode-locality-intl.db",
]
const CALIB = "data/eval/calibration/isotonic-en-us-v4.13.0.json"
const MODEL = arg("model", "out/v191/model.onnx") // shipped v4.13.0 int8
const LOCALES = arg("locales", "us,it,pt,pl,fr,au").split(",")
const N = Number(arg("n", "80"))
const MESSY = !process.argv.includes("--no-messy")
const AGG = arg("agg", "min") as "node" | "min"
const TAU_GRID = [0, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.92, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99, 0.995]
const THRESH_KM = 25
const NOMINATIM_UA = "mailwoman-benchmark/1.0 (teffen@sister.software)"

// ── messy perturbation (mirrors competitive-benchmark.ts `messify`: lowercase, drop dash-postcodes
//    + comma structure, abbreviate common street words; NEVER touch the house number) ─────────────
export function messify(raw: string): string {
	let s = raw.toLowerCase()
	s = s.replace(/\b\d{2,4}-\d{2,3}\b/g, " ")
	s = s
		.replace(/\brua\b/g, "r")
		.replace(/\bavenida\b/g, "av")
		.replace(/\bestrada\b/g, "estr")
		.replace(/\bstra(?:ss|ß)e\b/g, "str")
		.replace(/\bstreet\b/g, "st")
		.replace(/\bvia\b/g, "v")
		.replace(/\bavenue\b/g, "ave")
	s = s.replace(/,/g, " ").replace(/\s+/g, " ").trim()
	return s
}

const PLACETYPE_RANK: Record<string, number> = {
	country: 0, region: 1, macrocounty: 2, county: 3, localadmin: 4, locality: 5,
	borough: 6, macrohood: 6, neighbourhood: 7, microhood: 8, street: 9, address: 10, venue: 10,
}

/**
 * Most-specific resolved node's coordinate + its calibrated parse confidence (`nodeConf`) AND the
 * min calibrated confidence across ALL resolved nodes (`minConf`, the weakest driving component).
 */
export function resolvedResult(
	tree: AddressTree,
): { lat: number; lon: number; nodeConf: number; minConf: number } | null {
	let best: { rank: number; lat: number; lon: number; conf: number } | null = null
	const confs: number[] = []
	const visit = (n: AddressNode): void => {
		if (n.placeId?.startsWith("wof:") && n.lat !== undefined && n.lon !== undefined) {
			const placetype = String(n.sourceId ?? "").split(":")[0] ?? ""
			const rank = PLACETYPE_RANK[placetype] ?? 5
			const conf = n.confidence ?? 0
			confs.push(conf)
			if (!best || rank > best.rank) best = { rank, lat: n.lat, lon: n.lon, conf }
		}
		for (const c of n.children) visit(c)
	}
	for (const r of tree.roots) visit(r)
	return best ? { lat: best.lat, lon: best.lon, nodeConf: best.conf, minConf: Math.min(...confs) } : null
}

type Coord = { lat: number; lon: number } | null
type NomCache = Record<string, { lat: number; lon: number } | null>

async function queryNominatim(raw: string, cc: string, cache: NomCache): Promise<{ coord: Coord; hit: boolean }> {
	const key = `${cc}:${raw}`
	if (key in cache) return { coord: cache[key] ?? null, hit: true }
	let out: Coord = null
	try {
		const u = new URL("https://nominatim.openstreetmap.org/search")
		u.searchParams.set("q", raw)
		u.searchParams.set("format", "jsonv2")
		u.searchParams.set("limit", "1")
		u.searchParams.set("countrycodes", cc.toLowerCase())
		const r = await fetch(u, { headers: { "User-Agent": NOMINATIM_UA } })
		if (r.ok) {
			const j = (await r.json()) as Array<{ lat: string; lon: string }>
			out = j[0] ? { lat: Number(j[0].lat), lon: Number(j[0].lon) } : null
		}
	} catch {
		out = null
	}
	cache[key] = out
	return { coord: out, hit: false }
}

/** One graded row: did each system answer, was it right-place, and how confident was mailwoman. */
export interface ScoredRow {
	cc: string
	mwAnswered: boolean
	errKm: number | null
	nodeConf: number
	minConf: number
	nomAnswered: boolean
	nomRight: boolean
}

async function collect(): Promise<ScoredRow[]> {
	const { createScorer } = await import("@mailwoman/neural/scorer")
	const { WofSqlitePlaceLookup } = await import("@mailwoman/resolver-wof-sqlite")
	const calibrate = createCalibrator(JSON.parse(readFileSync(CALIB, "utf8")))
	const lookup = new WofSqlitePlaceLookup({ databasePath: WOF })
	const resolver = createWofResolver(lookup as never)
	const model = await createScorer({
		modelPath: MODEL,
		tokenizerPath: TOK,
		modelCardPath: CARD,
		anchorLookupPath: ANCHOR,
		strict: true,
		tier: "server",
	})

	const cachePath = arg("cache", "/tmp/nominatim-messy-cache.json")
	const cache: NomCache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {}

	// Incremental row checkpoint: append every scored row so a mid-run crash (the silent SIGKILL the
	// first attempt hit at PL ~60/80) loses nothing. --rows-out resumes from here if present.
	const ckpt = arg("rows-out", "")
	const rows: ScoredRow[] = ckpt && existsSync(ckpt)
		? readFileSync(ckpt, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as ScoredRow)
		: []
	const done = new Set(rows.map((r) => r.cc)) // locales already fully collected in a prior partial run
	const append = (r: ScoredRow): void => {
		rows.push(r)
		if (ckpt) appendFileSync(ckpt, JSON.stringify(r) + "\n")
	}

	for (const cc of LOCALES) {
		const file = `data/eval/external/oa-${cc}-coord-150.jsonl`
		if (!existsSync(file)) {
			console.error(`${cc}: golden missing — skipped`)
			continue
		}
		const goldens = readFileSync(file, "utf8").trim().split("\n").slice(0, N).map((l) => JSON.parse(l)) as Array<{
			raw: string
			lat: number
			lon: number
		}>
		const already = rows.filter((r) => r.cc === cc).length
		if (already >= goldens.length) {
			console.error(`\n[${cc.toUpperCase()}] ${already} rows already checkpointed — skip`)
			continue
		}
		console.error(`\n[${cc.toUpperCase()}] ${goldens.length} rows (resuming from ${already})…`)
		let i = 0
		for (const g of goldens) {
			if (i++ < already) continue // resume past checkpointed rows
			const truth = { lat: g.lat, lon: g.lon }
			const input = MESSY ? messify(g.raw) : g.raw
			try {
				const tree = await model.parse(input, { postcodeRepair: true, calibrate })
				const resolved = await resolver.resolveTree(tree as never, { defaultCountry: cc.toUpperCase() })
				const c = resolvedResult(resolved as never)
				const errKm = c ? haversineKm(c.lat, c.lon, truth.lat, truth.lon) : null

				const { coord: nom, hit } = await queryNominatim(input, cc, cache)
				const nomRight = nom ? haversineKm(nom.lat, nom.lon, truth.lat, truth.lon) <= THRESH_KM : false

				append({
					cc,
					mwAnswered: !!c,
					errKm,
					nodeConf: c?.nodeConf ?? 0,
					minConf: c?.minConf ?? 0,
					nomAnswered: !!nom,
					nomRight,
				})
				// Rate-limit ONLY on a real Nominatim hit (cache miss); cached re-run skips it.
				if (!hit) await sleep(1100)
			} catch (e) {
				// One bad row must not kill the whole collection. Record a non-answer + move on.
				console.error(`  ⚠ row failed (${cc} "${input.slice(0, 40)}"): ${(e as Error).message}`)
				append({ cc, mwAnswered: false, errKm: null, nodeConf: 0, minConf: 0, nomAnswered: false, nomRight: false })
			}
			if (i % 20 === 0) {
				console.error(`  ${i}/${goldens.length}`)
				writeFileSync(cachePath, JSON.stringify(cache))
			}
		}
	}
	void done
	writeFileSync(cachePath, JSON.stringify(cache))
	return rows
}

function analyze(rows: ScoredRow[]): string {
	const confOf = (r: ScoredRow) => (AGG === "node" ? r.nodeConf : r.minConf)
	const right = (r: ScoredRow) => r.mwAnswered && r.errKm !== null && r.errKm <= THRESH_KM

	// 50/50 held-out split by row index (deterministic).
	const draw = rows.filter((_, i) => i % 2 === 0)
	const held = rows.filter((_, i) => i % 2 === 1)

	const sweep = (set: ScoredRow[]) =>
		TAU_GRID.map((tau) => {
			const accepted = set.filter((r) => r.mwAnswered && confOf(r) >= tau)
			const correct = accepted.filter(right).length
			return {
				tau,
				accepted: accepted.length,
				precision: accepted.length ? correct / accepted.length : NaN,
				recall: set.length ? accepted.length / set.length : NaN,
			}
		})
	const nomPoint = (set: ScoredRow[]) => {
		const ans = set.filter((r) => r.nomAnswered)
		return {
			precision: ans.length ? ans.filter((r) => r.nomRight).length / ans.length : NaN,
			recall: set.length ? ans.length / set.length : NaN,
		}
	}

	const curve = sweep(draw)
	const nom = nomPoint(draw)

	// honesty: split at the median confidence on DRAW, verify the low bucket errs more on HELD.
	const confs = draw.filter((r) => r.mwAnswered).map(confOf).sort((a, b) => a - b)
	const medConf = confs.length ? confs[Math.floor(confs.length / 2)]! : 0
	const heldAns = held.filter((r) => r.mwAnswered)
	const heldLow = heldAns.filter((r) => confOf(r) < medConf)
	const heldHigh = heldAns.filter((r) => confOf(r) >= medConf)
	const acc = (xs: ScoredRow[]) => (xs.length ? xs.filter(right).length / xs.length : NaN)

	const pct = (x: number) => (Number.isNaN(x) ? "—" : `${(100 * x).toFixed(1)}%`)
	const L: string[] = []
	L.push(`# Confidence-discrimination — mailwoman vs Nominatim on messy input`)
	L.push(
		`\n_Shipped model ${MODEL} (v4.13.0 int8), calibrated via ${CALIB}. ${MESSY ? "Messy" : "Clean"} OA goldens, ` +
			`${rows.length} rows across ${LOCALES.join("/")}, ≤${N}/locale. Right-place @${THRESH_KM}km, coordinate-graded ` +
			`("no result" = miss). Confidence aggregation: **${AGG}** ${
				AGG === "min" ? "(min calibrated conf across resolved nodes)" : "(most-specific resolved node)"
			}. Curve on a 50% draw split (${draw.length} rows); low-confidence bucket re-checked on the held-out 50% (${held.length} rows)._\n`,
	)
	L.push(`## Precision–recall by confidence threshold τ (mailwoman, draw split)\n`)
	L.push(`| τ | accepted | precision @25km | recall |`)
	L.push(`|--:|--:|--:|--:|`)
	for (const p of curve) L.push(`| ${p.tau.toFixed(3)} | ${p.accepted} | ${pct(p.precision)} | ${pct(p.recall)} |`)
	L.push(`\n**Nominatim (single point, same set):** precision ${pct(nom.precision)} · recall ${pct(nom.recall)}\n`)

	const beats = curve.filter((p) => !Number.isNaN(p.precision) && p.precision > nom.precision && p.recall >= 0.25)
	const head = beats.length ? beats[0]! : null
	L.push(`## Headline\n`)
	if (head) {
		L.push(
			`At **τ=${head.tau.toFixed(3)}**, mailwoman holds **${pct(head.precision)}** precision while still answering ` +
				`**${pct(head.recall)}** of rows — vs Nominatim's single **${pct(nom.precision)}** precision at ` +
				`**${pct(nom.recall)}** recall. mailwoman abstains where it is unsure; the search index cannot.\n`,
		)
	} else {
		L.push(`> No τ clears Nominatim's precision at ≥25% recall on this set (agg=${AGG}). Investigate / try --agg node.\n`)
	}

	L.push(`## Honesty check (held-out 50%, low- vs high-confidence)\n`)
	L.push(`Median ${AGG}-confidence on the draw split: ${medConf.toFixed(3)}. On the held-out rows:\n`)
	L.push(`| held-out bucket | n | right-place @25km |`)
	L.push(`|---|--:|--:|`)
	L.push(`| conf < ${medConf.toFixed(3)} (low) | ${heldLow.length} | ${pct(acc(heldLow))} |`)
	L.push(`| conf ≥ ${medConf.toFixed(3)} (high) | ${heldHigh.length} | ${pct(acc(heldHigh))} |`)
	const honest = acc(heldHigh) > acc(heldLow)
	L.push(
		`\n${honest ? "✓" : "✗"} The high-confidence bucket ${honest ? "outperforms" : "does NOT outperform"} the ` +
			`low-confidence bucket out-of-sample — the discrimination ${honest ? "holds" : "FAILS"} on held-out data.\n`,
	)

	const svgPath = arg("svg", "")
	if (svgPath) {
		writeFileSync(svgPath, renderSvg(curve, nom))
		console.error(`wrote ${svgPath}`)
	}
	return L.join("\n") + "\n"
}

/** Minimal self-contained precision–recall SVG: mailwoman curve (recall x, precision y) + Nominatim point. */
function renderSvg(
	curve: Array<{ precision: number; recall: number }>,
	nom: { precision: number; recall: number },
): string {
	const W = 520, H = 360, P = 56
	const xs = (r: number) => P + r * (W - 2 * P)
	const ys = (p: number) => H - P - p * (H - 2 * P)
	const pts = curve
		.filter((c) => !Number.isNaN(c.precision) && !Number.isNaN(c.recall))
		.map((c) => `${xs(c.recall).toFixed(1)},${ys(c.precision).toFixed(1)}`)
		.join(" ")
	const grid = [0, 0.25, 0.5, 0.75, 1]
		.map((t) => {
			const x = xs(t), y = ys(t)
			return (
				`<line x1="${x}" y1="${ys(0)}" x2="${x}" y2="${ys(1)}" stroke="#eee"/>` +
				`<line x1="${xs(0)}" y1="${y}" x2="${xs(1)}" y2="${y}" stroke="#eee"/>` +
				`<text x="${x}" y="${ys(0) + 18}" font-size="11" text-anchor="middle" fill="#666">${t}</text>` +
				`<text x="${xs(0) - 10}" y="${y + 4}" font-size="11" text-anchor="end" fill="#666">${t}</text>`
			)
		})
		.join("")
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui, sans-serif">` +
		`<rect width="${W}" height="${H}" fill="white"/>` +
		grid +
		`<polyline points="${pts}" fill="none" stroke="#2563eb" stroke-width="2.5"/>` +
		`<circle cx="${xs(nom.recall).toFixed(1)}" cy="${ys(nom.precision).toFixed(1)}" r="6" fill="#dc2626"/>` +
		`<text x="${xs(nom.recall) + 10}" y="${ys(nom.precision) + 4}" font-size="12" fill="#dc2626">Nominatim</text>` +
		`<text x="${W / 2}" y="${H - 12}" font-size="13" text-anchor="middle" fill="#111">recall (fraction answered)</text>` +
		`<text x="16" y="${H / 2}" font-size="13" text-anchor="middle" fill="#111" transform="rotate(-90 16 ${H / 2})">precision @25km</text>` +
		`<text x="${W / 2}" y="22" font-size="14" text-anchor="middle" fill="#111" font-weight="600">mailwoman trades recall for precision; Nominatim cannot</text>` +
		`</svg>\n`
	)
}

async function main(): Promise<void> {
	const rowsIn = arg("rows-in", "")
	const rows: ScoredRow[] = rowsIn
		? readFileSync(rowsIn, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ScoredRow)
		: await collect()
	const rowsOut = arg("rows-out", "")
	if (rowsOut && !rowsIn) {
		writeFileSync(rowsOut, rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
		console.error(`wrote ${rowsOut} (${rows.length} rows)`)
	}
	const md = analyze(rows)
	const out = arg("out", "")
	if (out) {
		writeFileSync(out, md)
		console.error(`wrote ${out}`)
	}
	console.log(md)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main()
