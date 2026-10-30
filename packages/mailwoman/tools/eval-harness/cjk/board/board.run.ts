/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Scores a character-encoder weights package on a held-out CJK board and prints the pre-registered read.
 *
 *   The read argmax-decodes each row's character labels from the package's `model.onnx`, reconstructs the spans, and
 *   resolves the predicted prefecture and municipality pair against the centroid table at 15 km. The JP, KR and TW
 *   boards share it; `--resolve-tags region,subregion` with that board's centroid table reads the KR and TW boards.
 *
 *   ```sh
 *   node packages/mailwoman/tools/eval-harness/cjk/board/board.run.ts --weights packages/neural-weights-cjk \
 *     --board $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-jp-kana-2026-09-06/jp-board.jsonl.zst --all-municipalities
 *   ```
 *
 *   `--predictions <jsonl>` writes each row's label ids, and `--result <json>` writes the totals, so another scorer can
 *   read the same predictions.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { encodeCharUnits, encoderDescriptorFromCard, parseCharVocabulary } from "@mailwoman/neural/char-encoder"
import { ONNXRunner } from "@mailwoman/neural/onnx/runner"
import { readLabelsFromModelCard } from "@mailwoman/neural/weights/channels"
import { resolvePath } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { formatBoardReport } from "#tools/eval-harness/cjk/board/report"
import { type BoardRow, type CentroidTable, RESOLVE_TAGS, scoreBoard } from "#tools/eval-harness/cjk/board/score"

const PROBE_DIRECTORY = ["corpus", "versioned", "v8-jp-probe"] as const

const { values } = parseArguments({
	options: {
		weights: { type: "string" },
		board: { type: "string" },
		centroids: { type: "string" },
		"label-set": { type: "string" },
		"resolve-tags": { type: "string" },
		"all-municipalities": { type: "boolean" },
		predictions: { type: "string" },
		result: { type: "string" },
	},
})

if (!values.weights)
	throw new Error("usage: board.run.ts --weights <weights package directory> [--board <jsonl[.zst]>]")

const weights = resolvePath(values.weights)
const cardPath = resolvePath(weights, "model-card.json")
const card = await readLocalJSONFile<Record<string, unknown>>(cardPath)
const encoder = encoderDescriptorFromCard(card, cardPath)

if (encoder.kind !== "char") throw new Error(`${cardPath} declares no character encoder; this board reads a char graph`)

const labels = await readLabelsFromModelCard(cardPath)

if (!labels) throw new Error(`${cardPath} has no labels`)

const cardLabelSet = typeof card.label_set === "string" ? card.label_set : null
const labelSet = values["label-set"] ?? cardLabelSet

if (!labelSet) throw new Error(`${cardPath} states no label_set; pass --label-set`)

if (cardLabelSet && cardLabelSet !== labelSet) {
	throw new Error(`--label-set ${labelSet} differs from the card's ${cardLabelSet}, which would mislabel every span`)
}

let resolveTags = RESOLVE_TAGS[labelSet]

if (values["resolve-tags"]) {
	const [first = "", second = ""] = values["resolve-tags"].split(",").map((tag) => tag.trim())

	resolveTags = [first, second]
}

if (!resolveTags) throw new Error(`label set ${labelSet} has no default resolve tags; pass --resolve-tags`)

const tags = new Set(labels.map((label) => label.slice(label.indexOf("-") + 1)))

for (const tag of resolveTags) {
	if (!tags.has(tag)) throw new Error(`resolve tag ${tag} is not in label set ${labelSet}`)
}

const vocabularyPath = resolvePath(weights, encoder.charVocab)
const vocabulary = parseCharVocabulary(await readLocalJSONFile(vocabularyPath), vocabularyPath)
const boardPath = values.board ?? dataRootPath(...PROBE_DIRECTORY, "jp-probe-board.jsonl.zst").toString()

const centroids = await readLocalJSONFile<CentroidTable>(
	values.centroids ?? dataRootPath(...PROBE_DIRECTORY, "jp-muni-centroids.json")
)

const runner = await ONNXRunner.create(resolvePath(weights, "model.onnx"), { fixedSeqLen: encoder.maxUnits })
const predictions: string[] = []

const result = await scoreBoard(
	JSONSpliterator.fromAsync<BoardRow>(boardPath),
	async (raw) => {
		const encoding = encodeCharUnits(raw, vocabulary, encoder)
		const { logits, numLabels } = await runner.inferChars(encoding.charIDs, encoding.attentionMask)

		if (numLabels !== labels.length) {
			throw new Error(`model.onnx emits ${numLabels} logits per unit for a ${labels.length}-label card`)
		}

		const ids = logits.map((row) => row.indexOf(Math.max(...row)))

		if (values.predictions) {
			predictions.push(stringifyJSON({ raw, ids }))
		}

		return ids
	},
	centroids,
	{ labels, resolveTags }
)

if (values.predictions) {
	await writeLocalTextFile(predictions, values.predictions)
}

if (values.result) {
	await writeLocalJSONFile(
		{
			board: boardPath,
			weights: weights.toString(),
			label_set: labelSet,
			resolve_tags: resolveTags,
			...result,
			tag_hit: Object.fromEntries(result.tag_hit),
			tag_total: Object.fromEntries(result.tag_total),
			per_register: Object.fromEntries(result.per_register),
			per_municipality: Object.fromEntries(result.per_municipality),
		},
		values.result
	)
}

console.log(formatBoardReport(result, { allMunicipalities: values["all-municipalities"] }))
