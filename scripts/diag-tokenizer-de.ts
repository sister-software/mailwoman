/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   DE-0 (night-shift 2026-06-02) — the tokenizer gate for the German parser-coverage push.
 *
 *   The neural parser truncates `Straußstraße`→`Strau` and mangles `Karl-Liebknecht-Straße`. Is that
 *   a TOKENIZER ceiling (ß / compounds can't be represented) or a MODEL/coverage issue (tokenizer
 *   round-trips fine, the model just mis-spans because it never saw German)? This decides whether
 *   the whole German push is worth a training shard. It loads the v0.6.0-a0 SentencePiece tokenizer
 *   and, per German sample: encodes → decodes → checks lossless round-trip, and prints the pieces
 *   with their character offsets so we can see exactly how ß / hyphenated compounds / umlauts
 *   segment.
 *
 *   GATE: clean round-trip ⇒ coverage is the fix (proceed). Drops/garbles ß or compounds ⇒ tokenizer
 *   ceiling, STOP and escalate (no training data fixes it).
 *
 *   Usage: node --experimental-strip-types scripts/diag-tokenizer-de.ts\
 *   [--tokenizer /mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model]
 */

import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"

const tokPath =
	process.argv[process.argv.indexOf("--tokenizer") + 1] && process.argv.includes("--tokenizer")
		? process.argv[process.argv.indexOf("--tokenizer") + 1]!
		: "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"

const SAMPLES = [
	"Straußstraße",
	"Straußstraße 27",
	"Karl-Liebknecht-Straße",
	"Goethestraße 8a",
	"Prenzlauer Allee 36",
	"München",
	"Schöneberg",
	"Düsseldorf",
	"Köln",
	"Straußstraße 27, 12623 Berlin",
]

const tok = await MailwomanTokenizer.loadFromFile(tokPath)

let allClean = true
const flagged: string[] = []
for (const text of SAMPLES) {
	const enc = tok.encode(text)
	const decoded = tok.decode(enc.ids)
	const roundTrip = decoded === text
	// Every NON-whitespace char must fall inside some piece's [start,end). (Inter-token spaces are
	// encoded by SentencePiece as the `▁` prefix on the next piece, NOT as an offset span — so a
	// space gap is expected and must NOT be counted as a dropped character.)
	const nonSpaceCovered = [...text].every((ch, i) => /\s/.test(ch) || enc.pieces.some((p) => i >= p.start && i < p.end))
	const hasSS = text.includes("ß")
	if (!roundTrip || !nonSpaceCovered) {
		allClean = false
		flagged.push(text)
	}
	console.log(`\nIN   : ${JSON.stringify(text)}`)
	console.log(`pieces: ${enc.pieces.map((p) => `${JSON.stringify(p.piece)}[${p.start},${p.end})`).join(" ")}`)
	console.log(
		`decode: ${JSON.stringify(decoded)}  roundTrip=${roundTrip}  nonSpaceCovered=${nonSpaceCovered}${hasSS ? "  (has ß)" : ""}`
	)
}

console.log(`\n===== DE-0 GATE =====`)
console.log(
	`samples: ${SAMPLES.length}  clean: ${allClean ? "ALL" : SAMPLES.length - flagged.length}/${SAMPLES.length}`
)
if (allClean) {
	console.log("VERDICT: tokenizer round-trips German orthography cleanly → ß/compounds are NOT the wall.")
	console.log("         The Strauß→Strau truncation is a MODEL/coverage issue → PROCEED to DE-1 (corpus coverage).")
} else {
	console.log(`VERDICT: tokenizer FAILS on: ${flagged.map((s) => JSON.stringify(s)).join(", ")}`)
	console.log("         Tokenizer ceiling → STOP. German push needs a tokenizer change (factorized embedding /")
	console.log("         vocab / char-fusion), NOT a training shard. Escalate to operator.")
}
