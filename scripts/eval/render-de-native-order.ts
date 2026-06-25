/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Re-render the OpenAddresses German de-sample from US word order into native German order.
 *
 *   The shipped `openaddresses-de-sample.jsonl` renders every German row US-style — `27 Straußstraße,
 *   Berlin, Berlin 12623` (house-number FIRST, postcode TRAILING after the city). Real German
 *   addresses are written `Straußstraße 27, 12623 Berlin` (house AFTER street, postcode BEFORE
 *   city). A model trained on German order scores ~46% locality on the US-order rendering and ~84%
 *   on the native rendering — the "German collapse" was substantially this rendering mismatch. See
 *   `docs/articles/evals/2026-06-06-anchor-pilot.md` (the order-artifact correction).
 *
 *   This reproduces the native-order eval asset deterministically so the finding's numbers are
 *   re-runnable: parse house# + street out of the US-order `input`, take locality + postcode from
 *   the gold `expected`, and re-emit in German order. Everything else (lat, lon, expected, state,
 *   source) is preserved verbatim, so `oa-resolver-eval --eval <output>` measures the same points,
 *   only rendered the way Germans write them.
 *
 *   Run: node --experimental-strip-types scripts/eval/render-de-native-order.ts\
 *   --in data/eval/external/openaddresses-de-sample.jsonl\
 *   --out data/eval/external/openaddresses-de-sample-native-order.jsonl
 */
import { readFileSync, writeFileSync } from "node:fs"
import { arg } from "../lib/cli-args.ts"

interface DeRow {
	input: string
	lat: number
	lon: number
	expected: { locality?: string; region?: string; postcode?: string }
	state: string
	source: string
}

const inPath = arg("in", "data/eval/external/openaddresses-de-sample.jsonl")
const outPath = arg("out", "data/eval/external/openaddresses-de-sample-native-order.jsonl")

/**
 * `"27 Straußstraße, Berlin, Berlin 12623"` → `"Straußstraße 27, 12623 Berlin"`. House number is
 * the leading `\d+` (optionally a unit letter, `27a` / `27 A`) of the first comma-segment; the rest
 * is the street. Locality and postcode come from the gold `expected` so we never depend on the
 * US-order string's trailing layout. Rows with no leading house number render street-only (still
 * German order).
 */
function toNativeOrder(r: DeRow): string | null {
	const first = r.input.split(",")[0]?.trim()
	if (!first) return null
	const locality = r.expected.locality
	const postcode = r.expected.postcode
	if (!locality || !postcode) return null

	const m = /^(\d+\s*[A-Za-z]?)\s+(.+)$/.exec(first)
	const tail = `${postcode} ${locality}`
	if (!m) return `${first}, ${tail}` // no leading house number — street-only
	const [, house, street] = m
	return `${street!.trim()} ${house!.trim()}, ${tail}`
}

const lines = readFileSync(inPath, "utf8").split("\n").filter(Boolean)
const out: string[] = []
let skipped = 0
for (const line of lines) {
	const r = JSON.parse(line) as DeRow
	const native = toNativeOrder(r)
	if (!native) {
		skipped++
		continue
	}
	out.push(JSON.stringify({ ...r, input: native }))
}
writeFileSync(outPath, out.join("\n") + "\n")
console.error(`Done: ${out.length} rows re-rendered native-order, skipped ${skipped}. → ${outPath}`)
