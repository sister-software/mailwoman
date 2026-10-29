/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The United States' house-venue tuples, sampled from the admitted rows of the per-state situs databases.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { compareByCodePoint } from "@mailwoman/core/strings/compare"
import { pythonCapitalize, pythonSplitWhitespace } from "@mailwoman/core/strings/python-text"
import { basename, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { sampleAddressPoints } from "#recipes/address-points"
import type { HouseVenueTuple } from "#recipes/house-venue-tuples"
import { type RegisterDecisions, registerSourcePermitsTraining } from "#source-register/corpus-inputs"
import { readAddressSourceRegister } from "#source-register/register"
import type { PyRandom } from "#training/pyrandom"

/**
 * The directory holding one database per state, `address-points-us-<state>.db`.
 */
export function usSitusDirectory() {
	return dataRootPath("db", "address-points")
}

const SITUS_PREFIX = "address-points-us-"

/**
 * The table mapping each situs `source` value to the register rows its data comes from.
 *
 * `overture:NAD` maps to NAD and Overture, and each `overture:OpenAddresses/<state>/<body>` to
 * that body's own row and Overture, because OpenAddresses does not relicense what it collects.
 */
export function usSitusSourcesPath() {
	return resolvePackagePath("@mailwoman/corpus", "data", "us-situs-sources.json")
}

/**
 * Probes per requested row.
 *
 * A state whose admitted rows are a few percent of its table needs dozens of probes per kept row.
 */
export const US_SITUS_PROBE_BUDGET = 512

interface SitusSourcesFile {
	sources: Record<string, readonly string[]>
}

/**
 * The situs `source` values whose every register row holds a decision permitting transform and train.
 *
 * A value the table does not map, such as the bare `openaddresses` of the Hawaii database, is not admitted.
 *
 * @throws When the table does not exist, naming it.
 */
export async function admittedSitusSources(
	register?: RegisterDecisions,
	path: PathBuilderLike = usSitusSourcesPath()
): Promise<Set<string>> {
	if (!(await pathExists(path))) throw new Error(`No US situs source table at ${path.toString()}`)

	const table = await readLocalJSONFile<SitusSourcesFile>(path)
	const registerFile = register ?? (await readAddressSourceRegister())

	return new Set(
		Object.entries(table.sources)
			.filter(([, rows]) => rows.length > 0 && rows.every((row) => registerSourcePermitsTraining(registerFile, row)))
			.map(([source]) => source)
	)
}

/**
 * The state code after `address-points-us-`, ignoring a county suffix such as `il-cook`.
 */
export function situsStateCode(path: string): string {
	return basename(path).replace(/\.db$/u, "").slice(SITUS_PREFIX.length).split("-", 1)[0]!.toUpperCase()
}

const titleCase = (text: string): string => pythonSplitWhitespace(text).map(pythonCapitalize).join(" ")

/**
 * The state databases in `directory`, in code-point order of their paths.
 *
 * @throws When `directory` holds none, naming it, because an empty sample
 * would read as a country with no rows.
 */
export async function listSitusDatabases(directory: PathBuilderLike = usSitusDirectory()): Promise<string[]> {
	const found = await Globerator.from(`${SITUS_PREFIX}*.db`, { cwd: directory.toString(), absolute: true }).toArray()

	if (!found.length) throw new Error(`No ${SITUS_PREFIX}*.db database in ${directory.toString()}`)

	return found.map(String).toSorted(compareByCodePoint)
}

/**
 * Up to `count` tuples across states rather than from one.
 *
 * The state databases differ by orders of magnitude in size, so the budget is
 * split evenly and the state order is shuffled.
 * A state holding fewer admitted rows than its share passes the shortfall to the states after it.
 */
export async function sampleUSHouseVenueTuples(
	count: number,
	rng: PyRandom,
	directory: PathBuilderLike = usSitusDirectory()
): Promise<HouseVenueTuple[]> {
	const stateDatabases = await listSitusDatabases(directory)
	const admitted = await admittedSitusSources()

	rng.shuffle(stateDatabases)

	const tuples: HouseVenueTuple[] = []

	for (const [index, path] of stateDatabases.entries()) {
		if (tuples.length >= count) break

		const remaining = count - tuples.length
		const perState = Math.max(1, Math.ceil(remaining / (stateDatabases.length - index)))
		const state = situsStateCode(path)

		const sampled = await sampleAddressPoints(path, perState, rng, {
			sources: admitted,
			probeBudget: US_SITUS_PROBE_BUDGET,
		})

		for (const [street, number, postcode, locality] of sampled) {
			if (tuples.length >= count) break

			tuples.push({
				locality: titleCase(locality),
				region: state,
				postcode,
				country: "US",
				street: titleCase(street),
				houseNumber: number,
			})
		}
	}

	return tuples
}
