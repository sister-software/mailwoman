/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_symbol` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The search itself lives in `../symbol-index.ts`; this file is the CONTRACT.
 *
 *   The pull half of the duplicate-avoidance pair. `scripts/hooks/symbol-precheck.ts` pushes the same answer at write
 *   time without being asked; this is for deciding BEFORE writing, when the question is "does this already exist" and
 *   the answer changes what gets written.
 */

import { repoRootPath } from "@mailwoman/core/paths"
import { z } from "zod"

import { searchDeclarations } from "#symbol-index"
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
			.describe("An identifier fragment, matched case-insensitively against declared names. Letters, digits, `_`."),
		limit: z.number().int().positive().max(200).default(25),
	}),
	handler: async (args) => {
		const query = args["query"] as string
		const limit = (args["limit"] as number | undefined) ?? 25
		const all = searchDeclarations(query, { cwd: String(repoRootPath()) })
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
			not_covered: [...NOT_COVERED],
			summary: findings.length
				? `${findings.length} name(s) matching ${JSON.stringify(query)} across ${nSites} declaration site(s); ` +
					`${withHome.length} have at least one exported declaration you could import. ` +
					`${all.length - findings.length} further name(s) not listed.`
				: `No declaration matching ${JSON.stringify(query)} in the covered set. See not_covered — this is not ` +
					"proof the symbol is absent from the repository.",
		}
	},
})
