/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Assembles a CJK overlay corpus, then writes its `SOURCE_RIGHTS.json`.
 *
 *   Usage:
 *     node packages/corpus/lib/tools/cjk-overlay.run.ts \
 *       --jp-corpus $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-jp-full-2026-08-04 \
 *       --cn-train <cn-units-train.jsonl> --cn-val <cn-units-val.jsonl> --cn-test <cn-units-test.jsonl> \
 *       --out-dir $MAILWOMAN_DATA_ROOT/corpus/versioned/v8-cjk-<date> \
 *       [--volume-root <dir>] [--jp-version <version>] [--extra-corpus DIR:SOURCE ...] [--force]
 *       [--unshippable-reason <why>]
 *
 *   `--volume-root` defaults to the training volume's `corpus/versioned`, where the manifest's paths point.
 */

import { parseArguments, requiredArgument } from "@mailwoman/core/scripting/arguments"
import { pythonJSONDumps } from "@mailwoman/core/strings/python-json"

import { buildCJKOverlay, CN_UNITS_SOURCE, OVERLAY_JP_SOURCE, OVERLAY_JP_VERSION } from "#cjk/overlay"
import { openSourceRightsAdmission, writeSourceRightsRecord } from "#source-register/corpus-inputs"

/**
 * The training volume's mount, as `MAILWOMAN_VOLUME_MOUNT` sets it for the trainer.
 */
const VOLUME_ROOT = "/data/corpus/versioned"

const { values } = parseArguments({
	options: {
		"jp-corpus": { type: "string" },
		"cn-train": { type: "string" },
		"cn-val": { type: "string" },
		"cn-test": { type: "string" },
		"out-dir": { type: "string" },
		"volume-root": { type: "string", default: VOLUME_ROOT },
		"jp-version": { type: "string", default: OVERLAY_JP_VERSION },
		"extra-corpus": { type: "string", multiple: true, default: [] },
		force: { type: "boolean", default: false },
		"unshippable-reason": { type: "string" },
	},
})

const command = "cjk-overlay"

const extraCorpora = values["extra-corpus"].map((entry) => {
	const at = entry.lastIndexOf(":")
	const directory = at === -1 ? "" : entry.slice(0, at)
	const source = at === -1 ? "" : entry.slice(at + 1)

	if (!directory || !source) throw new Error(`--extra-corpus takes DIR:SOURCE, got ${entry}`)

	return { directory, source }
})

const outDir = requiredArgument(command, "--out-dir", values["out-dir"])

const admission = await openSourceRightsAdmission({
	context: "CJK overlay assembly",
	unshippableReason: values["unshippable-reason"] ?? null,
})

admission.admitAll([OVERLAY_JP_SOURCE, CN_UNITS_SOURCE, ...extraCorpora.map((extra) => extra.source)])

const report = await buildCJKOverlay({
	jpCorpus: requiredArgument(command, "--jp-corpus", values["jp-corpus"]),
	cnTrain: requiredArgument(command, "--cn-train", values["cn-train"]),
	cnVal: requiredArgument(command, "--cn-val", values["cn-val"]),
	cnTest: requiredArgument(command, "--cn-test", values["cn-test"]),
	outDir,
	volumeRoot: values["volume-root"],
	jpVersion: values["jp-version"],
	force: values.force,
	extraCorpora,
})

await writeSourceRightsRecord(admission.record(), outDir)

console.log(pythonJSONDumps(report, { indent: 2, ensureASCII: false }))
