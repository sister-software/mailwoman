/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The `mwdev_diff_geocode` tool definition; the diff itself is `mailwoman/geocode`'s `diffGeocode`, and this file's
 * job is to put the attribution in front of the distance.
 */

import { diffGeocode, type GeocodeArm, type GeocodeRun, renderGeocodeDiff } from "mailwoman/geocode"
import { z } from "zod"

import { acquireTwoArms, type DevTool, type DevToolDeps, RENDERED_DIFF_LIMIT } from "#tool-kit"

/**
 * One arm of the comparison, read off a run; `tree` hangs off the run rather than the result
 * because `GeocodeResult` drops the spans the per-span resolution deltas need.
 */
function arm(run: GeocodeRun): GeocodeArm {
	return {
		tree: run.tree,
		lat: run.result.lat,
		lon: run.result.lon,
		tier: run.result.resolution_tier,
		uncertaintyM: run.result.uncertainty_m,
		...(run.tree?.localeCountry ? { localeCountry: run.tree.localeCountry } : {}),
	}
}

/**
 * Build the `mwdev_diff_geocode` tool definition.
 */
export const diffGeocodeTool = (deps: DevToolDeps): DevTool => ({
	name: "mwdev_diff_geocode",
	description:
		"Diff two arms' GEOCODES of the same inputs and state which of three things moved the answer: " +
		"`parse-changed` (the model was asked a different question), `retrieval-repointed` (the same spans landed " +
		"on a different place), or `tier-changed` (the same components fell through to a coarser rung, which is " +
		"DATA COVERAGE and no model change touches it). A distance delta alone cannot choose between them, which " +
		"is why grading a tier fall-through against a model wastes a run. Also reports `unchanged` and " +
		"`coordinate-appeared-or-vanished`, the latter kept separate because an arm returning no coordinate is a " +
		"different event from moving zero kilometres. Carries the per-span resolution deltas, so a span that kept " +
		"its tag and text while landing on another place is visible.",
	inputSchema: z.object({
		inputs: z.array(z.string().min(1)).min(1).max(200).describe("Address strings to geocode on both arms."),
		weights_cache: z
			.string()
			.optional()
			.describe(
				"Package-shaped candidate weights directory for arm B. Omit to compare two CONFIGS of the shipped model " +
					"instead; supplying neither this nor a config difference makes both arms identical, which is a " +
					"self-check and nothing else."
			),
		locale: z.string().optional().describe("Locale for both arms, e.g. `en-GB`. Defaults to the production default."),
		changes_only: z
			.boolean()
			.optional()
			.describe("Omit inputs whose arms agree. Default true — an identical row is not a finding."),
	}),
	handler: async (args) => {
		const inputs = args["inputs"] as string[]
		const weightsCache = args["weights_cache"] as string | undefined
		const locale = args["locale"] as string | undefined
		const changesOnly = args["changes_only"] !== false

		const arms = await acquireTwoArms(deps.registry, { locale, weightsCache })

		if (arms.error) return arms.error

		const { base, candidate } = arms
		const diffs = []

		for (const input of inputs) {
			const a = await base.session.geocode(input)
			const b = await candidate.session.geocode(input)

			diffs.push(diffGeocode(input, arm(a), arm(b)))
		}

		const shown = changesOnly ? diffs.filter((d) => !d.identical) : diffs
		const rendered = shown.slice(0, RENDERED_DIFF_LIMIT).map((d) => renderGeocodeDiff(d))

		// Which attribution dominates is the diagnosis, and it decides whether a run was worth
		// grading; a `tier-changed` majority means the arms differ on data the model never saw.
		const attributions: Record<string, number> = {}

		for (const d of shown) {
			attributions[d.attribution] = (attributions[d.attribution] ?? 0) + 1
		}

		const differing = diffs.filter((d) => !d.identical).length

		return {
			n_inputs: inputs.length,
			n_differing: differing,
			arm_b: weightsCache ?? "(same weights as arm A)",
			attributions,
			rendered,
			...(shown.length > RENDERED_DIFF_LIMIT
				? {
						not_rendered: shown.length - RENDERED_DIFF_LIMIT,
						note: "Narrow the input set — past 40 you are comparing models, not reading addresses.",
					}
				: {}),
			diffs: shown,
			summary:
				`${differing} of ${inputs.length} inputs geocode differently. ` +
				(Object.keys(attributions).length
					? `Attributions: ${Object.entries(attributions)
							.map(([kind, count]) => `${kind} ${count}`)
							.join(", ")}. `
					: "") +
				"A `tier-changed` majority is data coverage rather than the model, and grading it against a " +
				"candidate wastes the run. A `retrieval-repointed` majority puts the cause in the ranking or the " +
				"gazetteer. Only `parse-changed` rows are the model's.",
		}
	},
})
