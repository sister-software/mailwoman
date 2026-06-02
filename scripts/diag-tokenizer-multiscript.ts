/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Multi-script tokenizer scoping (night-shift 2026-06-02) — the non-Latin generalization of the
 *   DE-0 gate (`diag-tokenizer-de.ts`). DE-0 showed the v0.6.0-a0 SentencePiece tokenizer
 *   round-trips German (Latin) orthography losslessly, so German is a coverage problem, not a
 *   tokenizer one. This asks the same question of the scripts the multi-locale push will eventually
 *   hit — Cyrillic, Greek, CJK, Korean, Arabic, Thai, Devanagari.
 *
 *   The interesting number here is NOT round-trip (SentencePiece `byte_fallback=true` guarantees
 *   losslessness for anything — worst case it emits raw UTF-8 byte pieces). It's FRAGMENTATION: how
 *   many pieces per character. A Latin morpheme like `straße` is one learned piece carrying
 *   meaning; a CJK character with no vocab entry becomes 3 byte pieces carrying none. A high
 *   pieces-per-char ratio means the model would have to learn address structure over structureless
 *   byte soup — which is why "just add training data" may not be enough for those scripts, and why
 *   a tokenizer change (factorized embedding / char-fusion / a multilingual vocab) is the real
 *   lever for them.
 */

import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"

const tokPath =
	process.argv.includes("--tokenizer") && process.argv[process.argv.indexOf("--tokenizer") + 1]
		? process.argv[process.argv.indexOf("--tokenizer") + 1]!
		: "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"

// One representative native-order address per script.
const SAMPLES: Array<{ script: string; text: string }> = [
	{ script: "Latin (DE)", text: "Straußstraße 27, 12623 Berlin" },
	{ script: "Latin (FR)", text: "12 rue de la Paix, 75002 Paris" },
	{ script: "Cyrillic (RU)", text: "ул. Тверская 12, 125009 Москва" },
	{ script: "Greek (EL)", text: "Λεωφόρος Συγγρού 100, 11741 Αθήνα" },
	{ script: "Japanese (JP)", text: "東京都中央区銀座1-1-1" },
	{ script: "Chinese (ZH)", text: "上海市黄浦区南京东路100号" },
	{ script: "Korean (KR)", text: "서울특별시 중구 세종대로 110" },
	{ script: "Arabic (AR)", text: "شارع التحرير 12، القاهرة" },
	{ script: "Thai (TH)", text: "ถนนสุขุมวิท 100 กรุงเทพ" },
	{ script: "Devanagari (HI)", text: "मुख्य मार्ग 12, नई दिल्ली" },
]

const tok = await MailwomanTokenizer.loadFromFile(tokPath)

// A byte-fallback piece looks like "<0xE6>" — count those to see raw-byte coverage.
const isBytepiece = (p: string) => /^<0x[0-9A-Fa-f]{2}>$/.test(p)

console.log("script              | chars | pieces | pcs/char | byte-pcs | round-trip")
console.log("--------------------|-------|--------|----------|----------|-----------")
for (const { script, text } of SAMPLES) {
	const enc = tok.encode(text)
	const decoded = tok.decode(enc.ids)
	const chars = [...text.replace(/\s/g, "")].length
	const pieces = enc.pieces.length
	const bytePcs = enc.pieces.filter((p) => isBytepiece(p.piece)).length
	const ratio = (pieces / chars).toFixed(2)
	const rt = decoded === text ? "ok" : "LOSSY"
	console.log(
		`${script.padEnd(19)} | ${String(chars).padStart(5)} | ${String(pieces).padStart(6)} | ${ratio.padStart(8)} | ${String(bytePcs).padStart(8)} | ${rt}`
	)
}
console.log("\nReading: round-trip 'ok' everywhere is expected (byte_fallback). The signal is pcs/char + byte-pcs:")
console.log("Latin ≈ 0.3–0.5 (morpheme pieces). A script in the 1.5–3+ range with many byte-pcs is")
console.log("represented as raw UTF-8 bytes — lossless but structureless. Those locales need a")
console.log("tokenizer change (factorized/multilingual vocab), not just more training data.")
