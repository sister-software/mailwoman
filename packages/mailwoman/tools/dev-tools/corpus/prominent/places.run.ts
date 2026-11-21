// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The prominent-places census (see `places.ts`).
 *
 *   Usage:
 *     node packages/mailwoman/tools/dev-tools/corpus/prominent/places.run.ts places --out <dir> \
 *       [--candidate-db <path>] [--geonames-glob <glob>] [--geonames-postal <path>] [--geonames-postal-dir <dir>]
 *     node packages/mailwoman/tools/dev-tools/corpus/prominent/places.run.ts scan --out <dir> --manifest <MANIFEST.json> \
 *       [--limit-files N]
 *     node packages/mailwoman/tools/dev-tools/corpus/prominent/places.run.ts coverage --out <dir>
 *     node packages/mailwoman/tools/dev-tools/corpus/prominent/places.run.ts report --out <dir>
 *     node packages/mailwoman/tools/dev-tools/corpus/prominent/places.run.ts inputs --out <dir> [--per-band N] \
 *       [--include <WOF id>,<WOF id>]
 *     node packages/mailwoman/tools/dev-tools/corpus/prominent/places.run.ts grade --out <dir>
 *     node packages/mailwoman/tools/dev-tools/corpus/prominent/places.run.ts tuples --out <dir> --config <yaml>
 *
 *   `tuples` reads `places.parquet` and a base corpus's `scan` from `--out` and writes
 *   `prominent-tuples.jsonl`, the `prominent-places` recipe's input (`tuples.ts`), with counts
 *   set in the training config's expected epoch draws over the base corpus `SCAN.json` names.
 *
 *   `places`, `scan` and `coverage` write parquet into `--out`.
 *   `report` prints the prominence distribution and the coverage tables as markdown.
 *
 *   `inputs` draws the geocode sample and writes one `inputs-<locale>.txt` per locale
 *   for `mailwoman geocode --stdin --json --locale <locale>`, whose output `grade`
 *   reads back from `geocoded-<locale>.jsonl` beside it.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { mtfNode } from "@mailwoman/mtf/tools/sampler/native"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { PathBuilder, resolvePath } from "path-ts"

import {
	buildProminentPlaces,
	measureCoverage,
	scanShortAdminRows,
	type ShortAdminScanRecord,
} from "#tools/dev-tools/corpus/prominent/places"
import { drawGeocodeInputs, gradeGeocodes, renderProminenceReport } from "#tools/dev-tools/corpus/prominent/probe"
import { writeProminentTuples } from "#tools/dev-tools/corpus/prominent/tuples"
import { readEpochMeasure } from "#tools/training/audits/prominent/coverage"
import { loadTrainingConfig } from "#tools/training/config"

const { values, positionals } = parseArguments({
	allowPositionals: true,
	options: {
		out: { type: "string" },
		manifest: { type: "string" },
		config: { type: "string" },
		"candidate-db": { type: "string" },
		"geonames-glob": { type: "string" },
		"geonames-postal": { type: "string" },
		"geonames-admin1": { type: "string" },
		"geonames-postal-dir": { type: "string" },
		"limit-files": { type: "string" },
		"per-band": { type: "string" },
		include: { type: "string" },
		"memory-gb": { type: "string" },
		threads: { type: "string" },
	},
})

const [command] = positionals

if (!values.out) throw new Error("--out <dir> names the census directory")

const out = resolvePath(values.out).toString()

const limits = {
	memoryLimitBytes: Number(values["memory-gb"] ?? 6) * 1024 ** 3,
	threads: Number(values.threads ?? 4),
}

const log = (line: string) => console.error(line)

if (command === "places") {
	await buildProminentPlaces({
		candidateDB: values["candidate-db"] ?? wofDatabasePath("candidate.db").toString(),
		geonamesGlob: values["geonames-glob"] ?? dataRootPath("geonames", "[A-Z][A-Z].txt").toString(),
		geonamesPostal: values["geonames-postal"] ?? dataRootPath("geonames", "allCountries-postal.txt").toString(),
		geonamesAdmin1: values["geonames-admin1"] ?? dataRootPath("geonames", "admin1CodesASCII.txt").toString(),
		geonamesPostalDirectory: values["geonames-postal-dir"] ?? dataRootPath("geonames-postal").toString(),
		out,
		limits,
		log,
	})
} else if (command === "scan") {
	if (!values.manifest) throw new Error("scan needs --manifest <MANIFEST.json>")

	const record = await scanShortAdminRows({
		manifest: resolvePath(values.manifest).toString(),
		out,
		...(values["limit-files"] ? { limitFiles: Number(values["limit-files"]) } : {}),
		limits,
		log,
	})

	await writeLocalJSONFile(record, resolvePath(out, "SCAN.json"))

	console.log(stringifyJSON(record))
} else if (command === "coverage") {
	await measureCoverage({ out, limits })
} else if (command === "report") {
	console.log(await renderProminenceReport({ out, limits }))
} else if (command === "inputs") {
	const include = (values.include ?? "")
		.split(",")
		.filter((id) => id.length > 0)
		.map(Number)

	console.log(
		stringifyJSON(await drawGeocodeInputs({ out, perBand: Number(values["per-band"] ?? 3), include, limits }))
	)
} else if (command === "grade") {
	console.log(await gradeGeocodes({ out }))
} else if (command === "tuples") {
	if (!values.config) throw new Error("tuples needs --config <training config>, whose epoch the counts are set in")

	const scan = await readLocalJSONFile<ShortAdminScanRecord>(resolvePath(out, "SCAN.json"))
	const config = await loadTrainingConfig(values.config)

	// The epoch over the base corpus the scan read.
	// The recipe's rows join that corpus.
	const epoch = await readEpochMeasure(await mtfNode(), config, {
		corpusDir: PathBuilder.from(scan.manifest).dirname().toString(),
		limits,
	})

	console.log(stringifyJSON(await writeProminentTuples({ out, epoch, limits })))
} else {
	throw new Error("expected one of places, scan, coverage, report, inputs, grade, tuples")
}
