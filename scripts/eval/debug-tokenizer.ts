import { NeuralAddressClassifier } from "@mailwoman/neural"

async function run() {
	const c = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
	const addr = "1600 Pennsylvania Ave NW, Washington, DC 20500"
	const enc = (c as any).cfg.tokenizer.encode(addr)
	console.log("TS pieces and IDs:")
	for (let i = 0; i < enc.pieces.length; i++) {
		const p = enc.pieces[i]
		console.log(`  id=${String(p.id).padStart(6)}  piece=${JSON.stringify(p.piece).padEnd(25)}  chars=[${p.start},${p.end})`)
	}
	console.log(`IDs (${enc.ids.length}): [${enc.ids.join(", ")}]`)
}

run().catch(console.error)
