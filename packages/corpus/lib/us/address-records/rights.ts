// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Which sources the US address layer may serve, by each source's register decisions.
 *
 *   The layer copies a source's rows and redistributes them.
 *   A source is fully admitted when the decision tree answers `go` for the
 *   `serve-address-layer` action on every register row its data comes from.
 *
 *   The corpus build applies the same rule to `transform` and `train`.
 *   A refused source is always excluded, and {@linkcode EXCLUDE_UNREAD_SOURCES}
 *   decides an unread or unmapped one.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { LicenseAction } from "@mailwoman/license/actions"
import {
	createSourceAdmitter,
	LayerExclusionReason,
	type LayerSourceExclusion,
	type SourceAdmission,
} from "@mailwoman/license/admission"
import { DecisionNode, evaluateLicense, DecisionVerdict } from "@mailwoman/license/tree"
import type { PathBuilderLike } from "path-ts"

import type { RegisterDecisions } from "#source-register/corpus-inputs"
import { readAddressSourceRegister } from "#source-register/register"

/**
 * The table mapping each US address source id to the register rows its data comes from.
 *
 * It keys Overture datasets as `overture:<dataset>`, OpenAddresses runs as `openaddresses:<member>`
 * and NAD as `usgov-nad`, the ids the situs databases and the address layer write.
 */
export function usSitusSourcesPath() {
	return resolvePackagePath("@mailwoman/corpus", "data", "us-situs-sources.json")
}

/**
 * The source table's `sources` map.
 *
 * @throws When the table doesn't exist, naming it.
 */
export async function readUSSitusSources(
	path: PathBuilderLike = usSitusSourcesPath()
): Promise<Readonly<Record<string, readonly string[]>>> {
	if (!(await pathExists(path))) throw new Error(`No US situs source table at ${path.toString()}`)

	return (await readLocalJSONFile<{ sources: Record<string, readonly string[]> }>(path)).sources
}

const firstSentence = (text: string): string => text.split(/(?<=[.!?])\s/u, 1)[0]!

/**
 * One register row's standing for the layer's operations, or null when it permits them all.
 */
function rowExclusion(
	register: RegisterDecisions,
	registerSource: string
): { reason: LayerExclusionReason; because: string } | null {
	const row = register.sources.find((entry) => entry.sourceID === registerSource)

	if (!row) {
		return {
			reason: LayerExclusionReason.NoRegisterRow,
			because: `the source table names register row ${registerSource}, which the register lacks.`,
		}
	}

	const { verdict, path } = evaluateLicense(
		{
			action: LicenseAction.ServeAddressLayer,
			offering: null,
			sources: [{ source: registerSource, licenseID: row.license }],
		},
		register
	)

	if (verdict === DecisionVerdict.Go) return null

	const stopped = path.at(-1)!

	if (stopped.node === DecisionNode.Registered) {
		return {
			reason: LayerExclusionReason.Unread,
			because: `register row ${registerSource} points at license ${row.license}, which has no decision.`,
		}
	}

	if (stopped.node === DecisionNode.ReviewState) {
		const reason = verdict === DecisionVerdict.NoGo ? LayerExclusionReason.Refused : LayerExclusionReason.Unread

		return { reason, because: firstSentence(stopped.because) }
	}

	const readings = path.filter((step) => step.node === DecisionNode.Operations)
	const refused = readings.find((step) => step.outcome === DecisionVerdict.NoGo)

	if (refused) {
		return {
			reason: LayerExclusionReason.Refused,
			because: `${refused.operation} is refused: ${firstSentence(refused.because)}`,
		}
	}

	const unread = readings.find((step) => step.outcome === DecisionVerdict.Unknown)!

	return { reason: LayerExclusionReason.Unread, because: firstSentence(unread.because) }
}

/**
 * Admits a source only when every register row the table maps it to permits each
 * operation the `serve-address-layer` action performs.
 *
 * A source whose rows include a refusal is excluded as refused.
 * One whose rows are otherwise unread is excluded as unread.
 *
 * One the table doesn't map, or maps to a row the register lacks, is excluded as having no register row.
 *
 * @param register The committed register when absent.
 * @param table The committed source table when absent.
 */
export async function readUSAddressSourceAdmission(
	register?: RegisterDecisions,
	table?: Readonly<Record<string, readonly string[]>>
): Promise<SourceAdmission> {
	const [decisions, sourceTable] = await Promise.all([
		register ?? readAddressSourceRegister(),
		table ?? readUSSitusSources(),
	])

	return (source) => {
		const registerSources = sourceTable[source] ?? []

		if (!registerSources.length) {
			return {
				source,
				reason: LayerExclusionReason.NoRegisterRow,
				registerSources,
				because: "the source table maps this source to no register row.",
			}
		}

		const standings = registerSources.map((row) => rowExclusion(decisions, row)).filter((entry) => entry != null)

		const deciding =
			standings.find(({ reason }) => reason === LayerExclusionReason.Refused) ??
			standings.find(({ reason }) => reason === LayerExclusionReason.Unread) ??
			standings[0]

		return deciding ? { source, registerSources, ...deciding } : null
	}
}

/**
 * Whether a US address layer build excludes a source whose register terms are unread
 * or that maps to no register row.
 *
 * A source the register refuses is excluded whatever this constant holds.
 * The build reads it as the default of its `excludeUnreadSources` option.
 */
export const EXCLUDE_UNREAD_SOURCES = true

/**
 * The sources one state's build reads, and those the register excludes.
 */
export interface USStateSources<Entry> {
	hasNAD: boolean
	/**
	 * The admitted Overture datasets other than NAD.
	 */
	datasets: string[]
	/**
	 * The admitted plan runs for the state, before the cache is checked for them.
	 */
	runs: Entry[]
	excluded: LayerSourceExclusion[]
	/**
	 * Sources admitted with unread terms or no register row, because the build doesn't exclude them.
	 */
	admittedUnread: LayerSourceExclusion[]
}

/**
 * Keeps the state's sources that `admission` admits.
 *
 * NAD is read as `usgov-nad`, each Overture dataset as `overture:<dataset>`
 * and each plan run for the state as `openaddresses:<member>`.
 * A run the plan marks `skip` is dropped without an exclusion.
 *
 * A refused source is always excluded.
 * A source with unread terms or no register row is excluded when `excludeUnread` holds,
 * and admitted and listed in `admittedUnread` otherwise.
 */
export function admitUSStateSources<Entry extends { member: string; skip?: boolean }>(
	state: string,
	candidates: { hasNAD: boolean; datasets: readonly string[]; plan: readonly Entry[] },
	admission: SourceAdmission,
	excludeUnread: boolean = EXCLUDE_UNREAD_SOURCES
): USStateSources<Entry> {
	const { admits, excluded, admittedUnread } = createSourceAdmitter(admission, excludeUnread)
	const prefix = `us/${state.toLowerCase()}/`

	return {
		hasNAD: candidates.hasNAD && admits("usgov-nad"),
		datasets: candidates.datasets.filter((dataset) => admits(`overture:${dataset}`)),
		runs: candidates.plan.filter(
			(entry) => entry.member.startsWith(prefix) && !entry.skip && admits(`openaddresses:${entry.member}`)
		),
		excluded,
		admittedUnread,
	}
}
