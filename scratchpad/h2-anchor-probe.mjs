// H2 from the deepparse brief, tested confound-free: what does the postcode-ANCHOR channel actually
// emit on the rows where we mis-tag a house number as a postcode?
//
// Turning the channel off would grade a channel-starved model (#718) — a confound. So instead: ask
// the channel directly. If it emits confidence 0 with matchType "none" (i.e. "this is not a postcode
// at all"), the channel is INNOCENT and something else drives the over-emission. If it fires, it is
// a suspect.
import fs from "node:fs"

import { extractPostcodeAnchors } from "/home/lab/Projects/mailwoman/neural/postcode-anchor.ts"
import { PostcodeBinaryResolver } from "/home/lab/Projects/mailwoman/neural/postcode-binary-resolver.ts"

const BIN =
	"/home/lab/Projects/mailwoman/scratchpad/v264-cache/node_modules/@mailwoman/neural-weights-en-us/postcode-us.bin"
const resolver = new PostcodeBinaryResolver(new Uint8Array(fs.readFileSync(BIN)))

// The rows where we tag the house number as a postcode (measured tonight, current main).
const rows = [
	"Epleskogen 39A",
	"Øvste Skogen 121",
	"Tindvegen nedre 44B",
	"14 Glen Neaves",
	"aleja Wojska Polskiego 178",
	"aleja Wojska 178",
	"22024 main st, ca",
	// the NL minimal pairs — gold says NO postcode for the last three
	"1234AB, Amsterdam",
	"1234SA, Amsterdam",
	"Haarlemmerdijk 12, 1234SS, Amsterdam",
	"Haarlemmerdijk 12, 0123AB, Amsterdam",
]

console.log("what the postcode-ANCHOR channel says on the over-emission rows:\n")
console.log(`${"input".padEnd(40)} ${"span".padEnd(9)} ${"matchType".padEnd(10)} ${"conf".padEnd(6)} posterior`)
console.log("-".repeat(94))
for (const r of rows) {
	const anchors = extractPostcodeAnchors(r, resolver)
	if (!anchors.length) {
		console.log(`${r.padEnd(40)} (no anchor span matched at all)`)
		continue
	}
	for (const a of anchors) {
		const post = Object.entries(a.posterior ?? {})
			.sort((x, y) => y[1] - x[1])
			.slice(0, 3)
			.map(([k, v]) => `${k}:${v.toFixed(2)}`)
			.join(" ")
		console.log(
			`${r.padEnd(40)} ${String(a.normalized).padEnd(9)} ${String(a.matchType).padEnd(10)} ${a.confidence.toFixed(3).padEnd(6)} ${post || "(empty)"}`
		)
	}
}
