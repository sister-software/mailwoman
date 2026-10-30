/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reads every committed training config through the Python loader and through this resolver, and requires
 *   the two to agree field by field (#2874, F7). A subset is also compared one config at a time, so a failure there
 *   prints its difference.
 *
 *   The Python side is `python -m mailwoman_train.config.dump`, run under uv with PyYAML 6.0.3 and no project build.
 *   Each scalar carries its Python type, so an int read as a float, a float repr, a mapping's key order and a key's
 *   type are all compared. The subset is the two shipped configs, configs that exercise each held-out floor list,
 *   the character path and a corpus judged by its recorded inputs, plus fixtures for PyYAML's scalar resolution
 *   and for every refusal the loader raises. The suite skips where `uv` is not installed. The `python` CI job
 *   installs it and runs this file.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { repoRootPath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { Globerator } from "spliterator/node/fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { readCorpusSourceInputs, SourceRightsError } from "#source-register/corpus-inputs"
import { readAddressSourceRegister } from "#source-register/register"
import {
	admitTrainingConfig,
	admittedTrainingSources,
	readTrainingConfigText,
	trainingCorpusVersion,
	trainingCSVLogPath,
	TrainingConfigError,
	typedTrainingConfig,
	type ConfigValue,
	type TrainingAdmissionInputs,
} from "#training/config/load"
import { pythonRepr } from "#training/config/python-yaml"

const CONFIG_DIR = repoRootPath("corpus-python", "src", "mailwoman_train", "configs")
const FIXTURE_DIR = resolvePackagePath("@mailwoman/corpus", "fixtures", "training-config")

/**
 * Committed configs, each chosen for a path through the loader.
 */
const CONFIG_SUBSET = [
	// The two configs `scope.config.json` names for shipped graphs. v7.2.0 is refused on rendered-gb.
	"v7.2.0-address-systems-60k.yaml",
	"v8-cjk-regs.yaml",
	// A corpus whose `fragment-assay` rows are judged by the inputs recorded for it.
	"v7.7.0-no-ppd-60k.yaml",
	// No `source_weights`, so the admission has no source list to check.
	"stage1-smoke.yaml",
	// `required_corpus_receipts`, `required_validation_coverage` and `required_validation_label_support`.
	"v4.15.0-ru-exposure-d100-2k.yaml",
	"v7.10.0-gb-county-60k-s43.yaml",
	"v8.3.0-probe-c4-split-digits-2k.yaml",
	// The character path.
	"v8-jp-full-2k.yaml",
]

/**
 * Fixtures the resolver refuses at typing although the Python loader admits them, as a deliberate change.
 */
const TYPED_REFUSALS = new Set(["strings-under-numeric-fields.yaml"])

/**
 * Marks each scalar's Python type and each mapping's key order, as `mailwoman_train.config.dump` does.
 */
function typed(value: ConfigValue): unknown {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value

	if (typeof value === "bigint") return { $int: value.toString() }

	if (typeof value === "number") return { $float: pythonRepr(value) }

	if (Array.isArray(value)) return value.map(typed)

	if (value instanceof Map) return { $map: [...value].map(([key, entry]) => [typed(key), typed(entry)]) }

	return { $map: [...value.values].map(([key, entry]) => [key, typed(entry)]) }
}

/**
 * The Python dump's admission record with each gap's keys spelled as `SourceRightsGap` spells them.
 */
function camelGaps(record: unknown): unknown {
	if (!record || typeof record !== "object") return record

	const renamed: Record<string, string> = { register_source: "registerSource", license_id: "licenseID" }
	const { gaps, ...rest } = record as { gaps: Array<Record<string, unknown>> }

	return {
		...rest,
		gaps: gaps.map((gap) =>
			Object.fromEntries(Object.entries(gap).map(([key, value]) => [renamed[key] ?? key, value]))
		),
	}
}

interface Dump {
	name: string
	config?: unknown
	admitted_sources?: string[]
	corpus_version?: string
	csv_log_path?: string
	load_error?: { type: string; message: string }
	admission?: unknown
	admission_error?: { type: string; message: string }
	admission_log?: string[]
}

async function dumpTypeScript(text: string, name: string, rights: TrainingAdmissionInputs): Promise<Dump> {
	const out: Dump = { name }

	try {
		const loaded = readTrainingConfigText(text, name)
		const config = typedTrainingConfig(loaded, name)

		out.config = typed(loaded)
		out.admitted_sources = admittedTrainingSources(config)
		out.corpus_version = trainingCorpusVersion(config)
		out.csv_log_path = trainingCSVLogPath(config)
	} catch (error) {
		if (!(error instanceof TrainingConfigError)) throw error

		if (TYPED_REFUSALS.has(name)) {
			out.config = typed(readTrainingConfigText(text, name))
			out.load_error = { type: "typed", message: error.message }

			return out
		}

		out.load_error = { type: error.kind, message: error.message }

		return out
	}

	const log: string[] = []

	try {
		out.admission = await admitTrainingConfig(typedTrainingConfig(readTrainingConfigText(text, name), name), {
			context: `training config ${name}`,
			rights,
			log: (line) => log.push(line),
		})
	} catch (error) {
		if (!(error instanceof SourceRightsError)) throw error

		out.admission_error = { type: "SourceRightsError", message: error.message }
	}

	out.admission_log = log

	return out
}

async function hasUV(): Promise<boolean> {
	try {
		await runFile("uv", ["--version"])

		return true
	} catch {
		return false
	}
}

/**
 * Runs the Python dumper over `names` relative to `cwd`, so each message spells
 * a file path as the TypeScript side spells it.
 */
async function dumpPython(cwd: string, names: readonly string[]): Promise<Map<string, Dump>> {
	const { stdout } = await runFile(
		"uv",
		[
			"run",
			"--no-project",
			"--with",
			"pyyaml==6.0.3",
			"--with",
			"platformdirs",
			"python",
			"-m",
			"mailwoman_train.config.dump",
			...names,
		],
		{
			cwd,
			env: childEnv({ PYTHONPATH: repoRootPath("corpus-python", "src") }),
			maxBuffer: 64 * 1024 * 1024,
		}
	)

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- one line per config of a fixed subset
	const lines = stdout.trim().split("\n")

	return new Map(lines.map((line) => parseJSONStrict<Dump>(line)).map((dump) => [dump.name, dump]))
}

describe.skipIf(!(await hasUV()))("the training config resolver against the Python loader", () => {
	let scratch: TemporaryDirectory
	let rights: TrainingAdmissionInputs
	const refusals: string[] = []

	beforeAll(async () => {
		scratch = await temporaryDirectory("mailwoman-config-parity-")
		const register = await readAddressSourceRegister()

		rights = { register, inputs: await readCorpusSourceInputs(register) }

		const documents = (await readLocalTextFile(FIXTURE_DIR, "refusals.yaml")).split(/^---\n/m)

		for (const [index, document] of documents.entries()) {
			const name = `refusal-${String(index).padStart(2, "0")}.yaml`

			await writeLocalTextFile(document, scratch.path(name))
			refusals.push(name)
		}
	})

	afterAll(async () => {
		await scratch[Symbol.asyncDispose]()
	})

	it("reads every committed config in the subset as the Python loader does, admission included", async () => {
		const python = await dumpPython(CONFIG_DIR, CONFIG_SUBSET)

		for (const name of CONFIG_SUBSET) {
			const ours = await dumpTypeScript(await readLocalTextFile(CONFIG_DIR, name), name, rights)
			const theirs = python.get(name)!

			expect(ours.load_error, name).toBeUndefined()

			expect({ ...ours, admission: ours.admission }, name).toEqual({
				...theirs,
				admission: camelGaps(theirs.admission),
			})
		}
	}, 60_000)

	it("reads every committed config as the Python loader does, a refusal included", async () => {
		const names = (await Globerator.from("*.yaml", { cwd: CONFIG_DIR.toString() }).toArray()).toSorted()
		const python = await dumpPython(CONFIG_DIR, names)
		const differing: string[] = []

		for (const name of names) {
			const ours = await dumpTypeScript(await readLocalTextFile(CONFIG_DIR, name), name, rights)
			const theirs = python.get(name)

			try {
				expect(ours).toEqual({ ...theirs, admission: camelGaps(theirs?.admission) })
			} catch {
				differing.push(name)
			}
		}

		expect(names.length).toBeGreaterThan(CONFIG_SUBSET.length)
		expect(differing).toEqual([])
	}, 600_000)

	it("resolves PyYAML's scalars as PyYAML does", async () => {
		const names = ["pyyaml-scalars.yaml", "strings-under-numeric-fields.yaml"]
		const python = await dumpPython(FIXTURE_DIR, names)

		for (const name of names) {
			const ours = await dumpTypeScript(await readLocalTextFile(FIXTURE_DIR, name), name, rights)
			const theirs = python.get(name)!

			expect(ours.config, name).toEqual(theirs.config)

			if (TYPED_REFUSALS.has(name)) {
				expect(ours.load_error?.type, name).toBe("typed")
				expect(theirs.load_error, name).toBeUndefined()

				continue
			}

			expect({ ...ours, admission: ours.admission }, name).toEqual({
				...theirs,
				admission: camelGaps(theirs.admission),
			})
		}
	}, 60_000)

	it("refuses each malformed config with the Python loader's exception class and message", async () => {
		const python = await dumpPython(scratch.path.toString(), refusals)

		for (const name of refusals) {
			const ours = await dumpTypeScript(await readLocalTextFile(scratch.path(name)), name, rights)
			const theirs = python.get(name)!

			expect(theirs.load_error, `${name} should be refused by the Python loader`).toBeDefined()
			expect(ours.load_error, name).toEqual(theirs.load_error)
		}
	}, 60_000)
})
