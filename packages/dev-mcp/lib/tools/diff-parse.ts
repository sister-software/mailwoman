/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_diff_parse` tool definition. The diff itself is `@mailwoman/core/decoder/parse-diff`; this file is the
 *   interface, and its job is to make the address the unit a reader sees.
 */

import { diffParse, isChange, renderParseDiff } from "@mailwoman/core/decoder/parse-diff"
import { z } from "zod"

import { acquireTwoArms, type DevTool, type DevToolDeps, RENDERED_DIFF_LIMIT } from "#tool-kit"

export const diffParseTool = (deps: DevToolDeps): DevTool => ({
	name: "mwdev_diff_parse",
	description:
		"Diff two arms' PARSES of the same inputs, span by span, with the address in view. Unlike a component-map " +
		"comparison this tells the four events apart: a span RETAGGED onto its own text, a span that MOVED its " +
		"boundary, a span added or removed outright, and a same-answer CONFIDENCE slide. That distinction is not " +
		"cosmetic — `Ye Three Lords, 27 Minories, London EC3N 1DE` losing its venue reads as 'the locality changed' in " +
		"a map diff, when two spans were destroyed and a third was retagged onto the text of one. Carries per-span " +
		"confidence deltas, the locale-country call and its confidence, and each span's SOURCE, so a span that kept " +
		"its tag while losing its resolver backing is visible. Use this instead of eyeballing two component dumps.",
	inputSchema: z.object({
		inputs: z.array(z.string().min(1)).min(1).max(200).describe("Address strings to parse on both arms."),
		weights_cache: z
			.string()
			.optional()
			.describe(
				"Package-shaped candidate weights directory for arm B. Omit to compare two CONFIGS of the shipped model " +
					"instead; supplying neither this nor a config difference makes both arms identical, which is a useful " +
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

			// `tree` hangs off the RUN rather than the result: `GeocodeResult` carries a flat
			// component map and drops the spans, which is the lossy shape this tool exists to avoid.
			// `localeCountry` is a property of the tree.
			diffs.push(
				diffParse(input, a.tree, b.tree, {
					...(a.tree?.localeCountry ? { before: a.tree.localeCountry } : {}),
					...(b.tree?.localeCountry ? { after: b.tree.localeCountry } : {}),
				})
			)
		}

		const shown = changesOnly ? diffs.filter((d) => !d.identical) : diffs
		const rendered = shown.slice(0, RENDERED_DIFF_LIMIT).map((d) => renderParseDiff(d))

		// Which event dominates is the diagnosis.
		// A run whose changes are mostly `retagged` is mislabelling.
		// One whose changes are mostly `moved` has a boundary problem.
		// One that is mostly `confidence` has not decided anything yet.
		const events: Record<string, number> = {}

		for (const d of shown) {
			for (const s of d.spans.filter(isChange)) {
				events[s.kind] = (events[s.kind] ?? 0) + 1
			}
		}

		return {
			n_inputs: inputs.length,
			n_differing: diffs.filter((d) => !d.identical).length,
			arm_b: weightsCache ?? "(same weights as arm A)",
			events,
			rendered,
			...(shown.length > RENDERED_DIFF_LIMIT
				? {
						not_rendered: shown.length - RENDERED_DIFF_LIMIT,
						note: "Narrow the input set — past 40 you are comparing models, not reading addresses.",
					}
				: {}),
			diffs: shown,
			summary:
				`${diffs.filter((d) => !d.identical).length} of ${inputs.length} inputs parse differently. ` +
				(Object.keys(events).length
					? `Span events: ${Object.entries(events)
							.map(([k, v]) => `${k} ${v}`)
							.join(", ")}. `
					: "") +
				"A `retagged` majority is mislabelling; a `moved` majority is a boundary problem; a `confidence` " +
				"majority means the arms have not actually decided differently yet, and the row is one nudge from flipping.",
		}
	},
})
