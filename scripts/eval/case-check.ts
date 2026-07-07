/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #619 follow-up probe: does the neural parser degrade on ALL-CAPS input (the TX HHSC facility
 *   distribution) vs the same address in title case? Confirms/refutes the case-robustness gap. Run:
 *   node --experimental-strip-types scripts/eval/case-check.ts
 */

import { readFileSync } from "node:fs"

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"

const { NeuralAddressClassifier } = await import("@mailwoman/neural")
const { ONNXRunner } = await import("@mailwoman/neural/onnx-runner")
const { MailwomanTokenizer } = await import("@mailwoman/neural/tokenizer")
const card = JSON.parse(readFileSync("neural-weights-en-us/model-card.json", "utf8"))
const [tokenizer, runner] = await Promise.all([
	MailwomanTokenizer.loadFromFile(dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")),
	ONNXRunner.create(dataRootPath("models", "quantized", "model-v140-step-40000-int8.onnx")),
])
const neural = new NeuralAddressClassifier({ tokenizer, runner, labels: card.labels })

const title = (s: string) => s.replace(/\b\w+/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
const samples = [
	"214 JONES RD, ELKHART, TX 75839",
	"1816 TILE FACTORY RD, PALESTINE, TX 75801",
	"2212 W REAGAN ST, PALESTINE, TX 75801",
	"4501 W CYPRESS ST, GRAND PRAIRIE, TX 75052",
	"100 N MAIN ST, FORT WORTH, TX 76102",
]
let capsLoc = 0
let titleLoc = 0

for (const caps of samples) {
	const tc = title(caps)
	const recCaps = decodeAsJSON(await neural.parse(caps, { postcodeRepair: true })) as Record<string, string>
	const recTitle = decodeAsJSON(await neural.parse(tc, { postcodeRepair: true })) as Record<string, string>
	const wantLoc = caps.split(",")[1]!.trim()
	const capsOk = (recCaps.locality ?? "").toUpperCase() === wantLoc
	const titleOk = (recTitle.locality ?? "").toUpperCase() === wantLoc

	if (capsOk) {
		capsLoc++
	}

	if (titleOk) {
		titleLoc++
	}
	console.log(
		`CAPS  loc=${recCaps.locality ?? "—"}  | TITLE loc=${recTitle.locality ?? "—"}  (want ${wantLoc})  ${capsOk ? "" : "CAPS-MISS"}${titleOk ? "" : " TITLE-MISS"}`
	)
}
console.log(`\nlocality correct: ALL-CAPS ${capsLoc}/${samples.length}  vs  TITLE-CASE ${titleLoc}/${samples.length}`)
