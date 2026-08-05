/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval oa-resolver` — the OpenAddresses real-point resolver eval (the non-circular
 *   accuracy track + the neural-vs-Pelias head-to-head). Markdown report on stdout; self-emits via
 *   `--out-md` (eval figures are never hand-typed into docs). See the eval-harness module docstring
 *   for the two-tier metric and every arm's rationale.
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { oaResolverEval } from "../../eval-harness/oa-resolver-eval.ts"

export const description = "OpenAddresses real-point resolver eval — non-circular, neural vs v0 (Pelias)"

const OptionsSchema = zod.object({
	eval: zod.string().optional().describe("Eval JSONL (default data/eval/external/openaddresses-us-sample.jsonl)"),
	limit: zod.number().optional().describe("Row cap (0/omitted = all rows)"),
	model: zod.string().optional().describe("Candidate ONNX"),
	tokenizer: zod.string().optional().describe("Candidate tokenizer"),
	modelCard: zod.string().optional().describe("Candidate model-card"),
	modelAnchorLookup: zod.string().optional().describe("Pin the anchor lookup source"),
	wof: zod
		.string()
		.optional()
		.describe("WOF shard list, comma-separated (default admin-global-priority + postcode-locality-intl)"),
	defaultCountry: zod
		.string()
		.optional()
		.describe("Hard country filter for admin lookups; 'none' disables (default US)"),
	// ablations + pins
	ablateToAnchor: zod.boolean().default(false).describe("#722 baseline: gazetteer + conventions OFF"),
	anchorOff: zod.boolean().default(false).describe("#887 declared ablation of the anchor input channel"),
	normalizeCase: zod.boolean().default(false).describe("#690/#895 tri-state pin: force normalizeCase ON"),
	rawCase: zod.boolean().default(false).describe("#690/#895 tri-state pin: force normalizeCase OFF"),
	adminCoherence: zod.boolean().default(false).describe("#895 tri-state pin: force adminCoherence ON"),
	// NOTE(phase5a): the retired script spelled this pin `--no-admin-coherence`, but commander treats a
	// literal `--no-x` flag as the negation of `--x` (same attribute), which would collapse the
	// tri-state — the OFF pin would read as "unset". Renamed here; the eval-harness module (and the
	// scripts/eval shim the probes spawn) keep the original two-key contract.
	adminCoherenceOff: zod.boolean().default(false).describe("#895 tri-state pin: force adminCoherence OFF"),
	postcodeCountryCoherence: zod
		.boolean()
		.default(false)
		.describe("#42 tri-state pin: force postcodeCountryCoherence ON (library default is ON since 2026-08-05)"),
	// Same commander constraint as `adminCoherenceOff` above — a literal `--no-x` flag would negate `--x` on the
	// same attribute and collapse the tri-state.
	postcodeCountryCoherenceOff: zod
		.boolean()
		.default(false)
		.describe("#42 tri-state pin: force postcodeCountryCoherence OFF (the pre-promotion configuration)"),
	hierarchyCompletion: zod.boolean().default(false).describe("#405: recover the dual-role-place locality"),

	// coordinate tiers
	postcodeAnchor: zod.boolean().default(false).describe("Add the neural+anchor row (anchor-centroid coordinate)"),
	postcodeShards: zod.string().optional().describe("Postcode shards for the anchor rows (comma-separated)"),
	anchorMinConf: zod.number().optional().describe("Anchor-coordinate trust floor (default 0.5)"),
	anchorRerank: zod.boolean().default(false).describe("#369 S8: feed the anchor country posterior to the re-rank"),
	addressPoints: zod.string().optional().describe("#476 exact-point shard (single-state)"),
	interpolation: zod.string().optional().describe("#483 interpolation shard (single-state)"),
	cascade: zod.boolean().default(false).describe("#718: grade the production coordinate cascade (per-state shards)"),
	dataRoot: zod.string().optional().describe("Shard root for --cascade (default $MAILWOMAN_DATA_ROOT)"),
	// backends
	candidateDb: zod.string().optional().describe("Swap in the byte-range candidate-table backend (demo parity)"),
	postalCityAliasDb: zod.string().optional().describe("#475 opt-in postal-city alias scorer (FTS path)"),
	// assembled arms
	assembled: zod.boolean().default(false).describe("#478 leg 2: add the assembled (pipeline) arms"),
	// Pastel derives the prop from the kebab flag, so `--admin-fst` binds `adminFst` — a lowercase
	// acronym is REQUIRED here and the house `adminFST` spelling silently never binds (the flag parses,
	// the value lands nowhere, the eval runs without an FST and reports a plausible number).
	// oxlint-disable-next-line sister-software/no-title-case-acronym -- Pastel flag derivation owns this casing.
	adminFst: zod
		.string()
		.optional()
		.describe("#1497: pin the per-locale FST gazetteer for the assembled arms (omit = no FST, the shipped default)"),
	placeCountry: zod.boolean().default(false).describe("#743: production-representative coarse placer"),
	placeCountryHard: zod.boolean().default(false).describe("#194/#743: hard country filter (safelist-gated)"),
	placeCountryHardAll: zod.boolean().default(false).describe("Ungated hard-filter measurement (full safelist)"),
	// dumps
	outMd: zod.string().optional().describe("Also write the markdown report here"),
	outJSON: zod.string().optional().describe("Write the aggregate JSON dump here"),
	errorsJSON: zod.string().optional().describe("Write the per-row failure dump here"),
	outResolved: zod.string().optional().describe("Per-row resolved-locality dump (PIP-containment metric)"),
	outRows: zod.string().optional().describe("Per-row neural-vs-v0 outcome dump (every row)"),
})

export { OptionsSchema as options }

const EvalOAResolver: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const { adminCoherenceOff, adminFst, postcodeCountryCoherenceOff, ...rest } = options

	const state = useCommandTask(() =>
		oaResolverEval({
			...rest,
			noAdminCoherence: adminCoherenceOff,
			noPostcodeCountryCoherence: postcodeCountryCoherenceOff,
			// Pastel's kebab derivation forces the lowercase-acronym prop above; the harness option keeps
			// the house spelling, so the rename happens here rather than in the eval's own contract.
			...(adminFst ? { adminFST: adminFst } : {}),
		})
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The eval prints its own markdown report on stdout.
	return null
}

export default EvalOAResolver
