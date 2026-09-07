/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_symbol` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The search itself lives in `../symbol-index.ts`; this file is the CONTRACT.
 *
 *   The pull half of the duplicate-avoidance pair. `../hooks/symbol-precheck.ts` pushes the same answer at write time
 *   without being asked; this is for deciding BEFORE writing, when the question is "does this already exist" and the
 *   answer changes what gets written.
 *
 *   TWO WAYS TO ASK, because a name search only helps someone who guessed the name. `query` matches an identifier
 *   fragment; `describes` matches what each declaration's docstring says it does, which is the half that answers when
 *   the intended name shares no substring with the existing one.
 */

import { repoRootPath } from "@mailwoman/core/paths"
import { z } from "zod"

import { searchDeclarations } from "#symbol-index"
import { loadPurposeIndex, searchPurpose } from "#symbol-purpose"
import type { DevTool, DevToolDeps } from "#tool-kit"

/**
 * What the sweep does not read. Stated on every result, including the empty ones: a zero here means "no declaration in
 * the covered set", never "this symbol does not exist".
 */
const NOT_COVERED = [
	".tsx files — a component is a different reuse question",
	"scratchpad/ — throwaway by construction",
	"node_modules/ and out/ — dependencies and build output, not authored source",
	"types, interfaces and non-function constants — only declarations that can carry logic",
	"nested declarations — a symbol inside a function body is not reachable to reuse",
] as const

/**
 * What the `describes` half does not read, on top of the list above.
 */
const DESCRIBES_NOT_COVERED = [
	"a declaration with no docstring — there is no sentence to match",
	"anything outside packages/*/lib — the described set is the shipped surface",
] as const

export const symbolTool = (_deps: DevToolDeps): DevTool => ({
	name: "mwdev_symbol",
	description:
		"Where a symbol name is already declared in this monorepo, with each site's signature and whether it is " +
		"exported. Ask before writing a helper, a comparator, a formatter, a percentile, a distance — anything that " +
		"sounds like it might already have a home. The repo has thousands of exported names and AGENTS.md lists a few " +
		"dozen of them by hand, so the prose is not the index and this is. It reports and does not prescribe: an " +
		"existing implementation may be the wrong one to reuse (packages/api-kit/lib/metrics.ts keeps its own percentile " +
		"on purpose, taking a FRACTION where core takes [0, 100], because depending on core would cost that workspace " +
		"an 11 MB data dependency). Read the signature and price the dependency before collapsing two copies.",
	inputSchema: z.object({
		query: z
			.string()
			.min(2)
			.optional()
			.describe("An identifier fragment, matched case-insensitively against declared names. Letters, digits, `_`."),
		describes: z
			.string()
			.min(3)
			.optional()
			.describe(
				"What the thing DOES, in words — `reads a package.json`, `distance between two coordinates`. Matched " +
					"against the first sentence of each exported declaration's docstring, which is how to ask when the name " +
					"you would have written shares no substring with the one that exists. Give this or `query`, or both."
			),
		limit: z.number().int().positive().max(200).default(25),
	}),
	handler: async (args) => {
		const query = args["query"] as string | undefined
		const describes = args["describes"] as string | undefined
		const limit = (args["limit"] as number | undefined) ?? 25
		const repoRoot = String(repoRootPath())

		if (!query && !describes) {
			return { error: "Give `query` (an identifier fragment) or `describes` (what the thing does), or both." }
		}

		const described = describes
			? searchPurpose(describes, await loadPurposeIndex(repoRoot), limit).map((finding) => ({
					name: finding.name,
					file: finding.file,
					line: finding.line,
					says: finding.sentence,
					matched: finding.matched,
				}))
			: []

		if (!query) {
			return {
				describes,
				n_described: described.length,
				described,
				not_covered: [...NOT_COVERED, ...DESCRIBES_NOT_COVERED],
				summary: described.length
					? `${described.length} declaration(s) whose stated purpose matches ${JSON.stringify(describes)}. Read ` +
						"the sentence and the signature before reusing one."
					: `No declaration describes ${JSON.stringify(describes)} in the covered set. See not_covered — a ` +
						"declaration with no docstring is invisible to this half, so try `query` with a name fragment too.",
			}
		}

		const all = searchDeclarations(query, { cwd: repoRoot })
		const findings = all.slice(0, limit)
		const nSites = findings.reduce((total, finding) => total + finding.sites.length, 0)
		const withHome = findings.filter((finding) => finding.sites.some((site) => site.exported))

		return {
			query,
			n_names: findings.length,
			n_sites: nSites,
			n_names_truncated: all.length - findings.length,
			findings: findings.map((finding) => ({
				name: finding.name,
				has_exported_home: finding.sites.some((site) => site.exported),
				sites: finding.sites,
			})),
			...(describes ? { describes, n_described: described.length, described } : {}),
			not_covered: describes ? [...NOT_COVERED, ...DESCRIBES_NOT_COVERED] : [...NOT_COVERED],
			summary: findings.length
				? `${findings.length} name(s) matching ${JSON.stringify(query)} across ${nSites} declaration site(s); ` +
					`${withHome.length} have at least one exported declaration you could import. ` +
					`${all.length - findings.length} further name(s) not listed.`
				: `No declaration matching ${JSON.stringify(query)} in the covered set. See not_covered — this is not ` +
					"proof the symbol is absent from the repository.",
		}
	},
})
