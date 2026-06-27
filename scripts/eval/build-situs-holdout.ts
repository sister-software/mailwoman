/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a {input, lat, lon} holdout for conformal interp calibration (#374/C) from a per-state
 *   situs shard. The situs address points (OA/NAD) are the GROUND TRUTH; running
 *   conformal-calibrate.ts interp-only against them measures the TIGER interpolation tier's error —
 *   and TIGER is an INDEPENDENT source from OA/NAD, so this is a non-circular holdout for any state
 *   (the same provenance separation the TX/Travis calibration relied on, available 50× over).
 *
 *   Usage: node scripts/eval/build-situs-holdout.ts --shard <situs.db> --region <ABBR> [--n 2500]
 *   [--out /tmp/<region>-situs-holdout.jsonl]
 */
import { writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

const { values: a } = parseArgs({
	options: {
		shard: { type: "string" },
		region: { type: "string", default: "" },
		n: { type: "string", default: "2500" },
		out: { type: "string", default: "" },
	},
})
if (!a.shard) throw new Error("--shard <situs.db> required")
const N = Number(a.n)
const region = a.region!.toUpperCase()
const out = a.out || `/tmp/${region.toLowerCase() || "x"}-situs-holdout.jsonl`

const db = new DatabaseSync(a.shard, { readOnly: true })
// Even, deterministic spread across the shard (not the first N clustered rows): sample by rowid modulo.
const total = (db.prepare("SELECT count(*) c FROM address_point").get() as { c: number }).c
const stride = Math.max(1, Math.floor(total / (N * 1.4)))
const rows = db
	.prepare(
		`SELECT number, street_raw, postcode, locality_norm, lat, lon
		 FROM address_point
		 WHERE number IS NOT NULL AND street_raw IS NOT NULL AND postcode IS NOT NULL
		   AND lat IS NOT NULL AND lon IS NOT NULL AND (rowid % ${stride}) = 0
		 LIMIT ${N}`
	)
	.all() as Array<{
	number: string | number
	street_raw: string
	postcode: string | number
	locality_norm: string | null
	lat: number
	lon: number
}>

const lines: string[] = []
for (const r of rows) {
	const number = String(r.number).trim()
	const street = String(r.street_raw).trim()
	const postcode = String(r.postcode).trim()
	const locality = String(r.locality_norm || "").trim()
	if (!number || !street || !postcode) continue
	// Realistic input: number street, locality REGION postcode. Interp is postcode-scoped, so the
	// postcode is what matters; locality/region help the parser route + resolve admin.
	const input = `${number} ${street}, ${[locality, region, postcode].filter(Boolean).join(" ")}`
	lines.push(JSON.stringify({ input, lat: r.lat, lon: r.lon }))
}
db.close()
writeFileSync(out, lines.join("\n") + "\n")
console.log(
	`${region || a.shard}: ${lines.length} holdout rows (of ${total.toLocaleString()} situs points, stride ${stride}) → ${out}`
)
console.log(`sample: ${lines[0]}`)
