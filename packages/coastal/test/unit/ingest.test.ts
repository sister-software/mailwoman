/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The ingest's schema handling — the part the fixture rung structurally cannot reach, because a fixture is
 *   a feature list rather than a geodatabase.
 *
 *   THE FOURTEEN PUBLISHED LAYERS DO NOT SHARE ONE SCHEMA, AND THE EXCEPTION IS ONE COLUMN ON ONE LAYER.
 *   `NCERM_SMP_2105_0CC` carries no `smp_name`; the other thirteen do. A builder that read the schema off a
 *   sibling — the survey read `NCERM_SMP_2105_95CC` — fails on the twelfth layer with
 *   `ERROR 1: Unrecognized field name smp_name`, 66,000 features into a run. Loud, and only because ogr2ogr
 *   refuses an unknown column; a source that answered NULL instead would have shipped. So the `SELECT` is
 *   built from the layer's OWN field list, and the tests below pin which columns may be absent and which may
 *   not.
 *
 *   THE POLICY ASYMMETRY IS THE OTHER SHAPE, AND IT IS REGULAR RATHER THAN IRREGULAR. The six NFI layers omit
 *   all four Shoreline Management Plan columns because under a no-intervention scenario there is no policy to
 *   record. That is a documented property of the product, so a layer disagreeing with its own scenario throws
 *   rather than being absorbed into a NULL.
 */

import { readCoastalScenarioFeatures, type CoastalLayerIdentity } from "@mailwoman/coastal/sdk/ingest"
import { NCERM_SCENARIOS_BY_KEY } from "@mailwoman/coastal/vocabulary"
import { describe, expect, it } from "vitest"

/**
 * The field list `NCERM_SMP_2105_95CC` publishes — every optional column present.
 */
const FULL_SMP_FIELDS = [
	"frontageid",
	"shape_leng",
	"smp_no",
	"smp_name",
	"smp_pu",
	"mt_smp",
	"mt_smp_int",
	"lt_smp",
	"lt_smp_int",
	"smp2105_95",
	"maxoverlap",
	"def_type",
	"published",
	"shape_length",
	"shape_area",
]

function identityFor(layer: string, fields: readonly string[]): CoastalLayerIdentity {
	return { epsg: 27_700, featureCount: 1, layer, fields: new Set(fields) }
}

/**
 * Drive the generator far enough to build and issue its `SELECT`, and report what it threw — or `null` where `ogr2ogr`
 * was reached, which on a machine with no geodatabase at the given path is a different failure.
 */
async function selectFailure(scenarioKey: string, identity: CoastalLayerIdentity): Promise<string | null> {
	const scenario = NCERM_SCENARIOS_BY_KEY.get(scenarioKey)!

	try {
		await readCoastalScenarioFeatures(scenario, { geodatabasePath: "/nonexistent.gdb" }, identity).next()
	} catch (error) {
		return (error as Error).message
	}

	return null
}

describe("the per-layer SELECT", () => {
	it("refuses a scenario layer missing its own distance column", async () => {
		const fields = FULL_SMP_FIELDS.filter((field) => field !== "smp2105_95")

		await expect(selectFailure("SMP_2105_95CC", identityFor("NCERM_SMP_2105_95CC", fields))).resolves.toMatch(
			/carries no smp2105_95 column/u
		)
	})

	it("refuses a scenario layer missing frontageid", async () => {
		const fields = FULL_SMP_FIELDS.filter((field) => field !== "frontageid")

		await expect(selectFailure("SMP_2105_95CC", identityFor("NCERM_SMP_2105_95CC", fields))).resolves.toMatch(
			/carries no frontageid column/u
		)
	})

	it("refuses an SMP layer that carries no policy columns, because that asymmetry is regular", async () => {
		const fields = FULL_SMP_FIELDS.filter((field) => !field.startsWith("mt_smp") && !field.startsWith("lt_smp"))

		await expect(selectFailure("SMP_2105_95CC", identityFor("NCERM_SMP_2105_95CC", fields))).resolves.toMatch(
			/policy asymmetry follows the management scenario/u
		)
	})

	it("refuses an NFI layer that DOES carry policy columns, for the same reason in the other direction", async () => {
		const fields = [...FULL_SMP_FIELDS.filter((field) => field !== "smp2105_95"), "nfi2055_0"]

		await expect(selectFailure("NFI_2055_0CC", identityFor("NCERM_NFI_2055_0CC", fields))).resolves.toMatch(
			/policy asymmetry follows the management scenario/u
		)
	})

	it("tolerates the one layer that publishes no smp_name, rather than refusing it", async () => {
		// `NCERM_SMP_2105_0CC` is the real case. The `SELECT` substitutes `NULL AS smp_name` and the ingest proceeds; the
		// failure that reaches the caller here is ogr2ogr failing to open a path that does not exist, which is the proof
		// that the query itself was built.
		const fields = FULL_SMP_FIELDS.filter((field) => field !== "smp_name").map((field) =>
			field === "smp2105_95" ? "smp2105_0" : field
		)

		const failure = await selectFailure("SMP_2105_0CC", identityFor("NCERM_SMP_2105_0CC", fields))

		expect(failure).toMatch(/ogr2ogr/u)
		expect(failure).not.toMatch(/smp_name/u)
	})
})
