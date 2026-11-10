/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes the OpenAddresses plan the US address layer reads: every US source the batch API holds an addresses job
 *   for, with the license its latest job states.
 *
 *   Usage: node --env-file=.env packages/mailwoman/tools/dev-tools/us/address-coverage/plan.run.ts --out <plan.json>
 *   [--previous <plan.json>]
 *
 *   `situs layer --plan <plan.json>` reads the output. With `--previous`, a member of the earlier plan that the batch
 *   API holds no addresses job for is kept with its recorded license and a null job, and the members the new plan
 *   adds are counted.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { buildOpenAddressesPlan, createOpenAddressesClient } from "@mailwoman/corpus/tools/fetch/openaddresses"
import { cachedRun, type OpenAddressesPlanEntry } from "@mailwoman/corpus/us/address-records/layer"

const { values } = parseArguments({ options: { out: { type: "string" }, previous: { type: "string" } } })

if (!values.out) throw new Error("--out <plan.json> is required")

await using client = createOpenAddressesClient()

const plan = await buildOpenAddressesPlan(client, "us/", (done, total) => {
	if (done % 250 === 0 || done === total) {
		console.error(`  ${done} of ${total} job records read`)
	}
})

const previous = values.previous ? await readLocalJSONFile<OpenAddressesPlanEntry[]>(values.previous) : []
const current = new Set(plan.map((entry) => entry.member))
const previousMembers = new Set(previous.map((entry) => entry.member))

// A member the earlier plan listed and the batch API holds no job for keeps its place,
// because the cache can still hold its run from the anonymous results endpoint,
// and a plan that dropped it would drop its records from the layer.
const kept = previous.filter((entry) => !current.has(entry.member))

const merged = [
	...plan,
	...kept.map((entry) => ({
		member: entry.member,
		license: entry.license,
		job: null,
		updated: null,
		features: null,
		bytes: null,
	})),
].toSorted((a, b) => a.member.localeCompare(b.member))

await writeLocalJSONFile(merged, values.out)

console.log(
	`${merged.length} US sources → ${values.out}: ${plan.length} with a batch job, ${kept.length} kept from the earlier plan without one`
)

if (values.previous) {
	const added = plan.filter((entry) => !previousMembers.has(entry.member))
	const cache = dataRootPath("oa-cache")
	const uncached: typeof added = []

	for (const entry of added) {
		if (!(await cachedRun(cache, entry.member))) {
			uncached.push(entry)
		}
	}

	const uncachedBytes = uncached.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)

	console.log(
		`against ${values.previous}: ${added.length} added; ${uncached.length} of them not cached, ` +
			`${(uncachedBytes / 1024 ** 3).toFixed(2)} GiB of batch job output`
	)

	for (const entry of kept) {
		console.log(`  kept without a batch job: ${entry.member}`)
	}
}
