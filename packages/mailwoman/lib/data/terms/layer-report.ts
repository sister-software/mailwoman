// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The license, obligations and sources of every database an inventory found,
 *   and where a user obtains each source.
 *
 *   A database whose `layer_manifest` was read reports what the manifest records.
 *   A database without the table, or one that couldn't be opened, is unread and reports why.
 *
 *   An unread database states no license, and the report never reads that as a database without obligations.
 */

import { type LayerTerms, resolveLayerTerms, type SourceLocator } from "@mailwoman/core/layers/provenance"
import { licenseTextURL } from "@mailwoman/core/license/text-url"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { licenseIdentifiers, summarizeLicense } from "@mailwoman/license/obligations"

import { type InventoryEntry, type InventoryReport, type LayerManifest, Provenance } from "#data/catalog/inventory"

/**
 * Whether a database's `layer_manifest` was read.
 */
const ManifestRead = {
	Read: "read",
	/**
	 * The database opened and has no `layer_manifest` table, as `probeLayerManifest` reports it.
	 */
	Absent: "absent",
	/**
	 * The table exists and `probeLayerManifest` refuses its contents: no row,
	 * several rows, or a row that fails validation.
	 */
	Invalid: "invalid",
	/**
	 * The database couldn't be opened.
	 */
	Unopenable: "unopenable",
} as const

export type ManifestRead = (typeof ManifestRead)[keyof typeof ManifestRead]

/**
 * One source a database records, with where a user obtains it.
 */
export interface LayerReportSource {
	name: string
	/**
	 * The source's title, or null when no owner's table locates it.
	 */
	title: string | null
	url: string | null
	/**
	 * The other layer the name matched, when the source is a layer under the same data root.
	 */
	upstream: string | null
}

/**
 * The terms a read manifest records.
 */
export interface LayerReportTerms {
	/**
	 * The layer's name as its manifest records it.
	 */
	layer: string
	version: string
	tier: string
	/**
	 * The SPDX expression, or null when the row predates the `license` column.
	 */
	license: string | null
	/**
	 * The union of the obligations of each recognized identifier.
	 */
	obligations: string[]
	/**
	 * Identifiers whose obligations this repository hasn't recorded.
	 */
	unknownIdentifiers: string[]
	attribution: string | null
	/**
	 * The manifest's `source` as recorded.
	 */
	source: string
	sources: LayerReportSource[]
	sourceVintage: string
	createdAt: string
}

/**
 * One database in the report.
 */
export interface LayerReportEntry {
	/**
	 * The path relative to the data root.
	 */
	path: string
	/**
	 * `db/<layer>` for a database in the database group, else the first directory under the data root.
	 */
	family: string
	manifest: ManifestRead
	/**
	 * Why the manifest wasn't read, present when it wasn't.
	 */
	reason?: string
	/**
	 * `active` or `inactive` when the active selection holds the database.
	 */
	selection?: "active" | "inactive"
	/**
	 * Present when the manifest was read.
	 */
	terms?: LayerReportTerms
}

/**
 * One layer family's counts.
 */
export interface LayerFamilyCount {
	family: string
	read: number
	unread: number
}

/**
 * One license identifier and the read databases whose expression includes it.
 */
export interface LayerLicenseCount {
	identifier: string
	obligations: string[]
	recognized: boolean
	textURL: string | null
	databases: number
}

/**
 * One source name and the read databases that record it.
 */
export interface LayerSourceCount extends LayerReportSource {
	databases: number
}

/**
 * The report over every database an inventory found, foreign roots excluded.
 */
export interface LayerReport {
	read: number
	unread: number
	families: LayerFamilyCount[]
	licenses: LayerLicenseCount[]
	/**
	 * The count of read databases whose manifest row records no license.
	 */
	withoutLicense: number
	sources: LayerSourceCount[]
	entries: LayerReportEntry[]
	/**
	 * Packages whose source table this installation lacks.
	 * A source they own reads as unlocated.
	 */
	unavailableSourceTables: string[]
}

/**
 * The family a database belongs to: `db/<layer>` inside the database group, else its first directory.
 */
export function layerFamily(path: string): string {
	const segments = path.split("/")

	if (segments.length === 1) return "."

	return segments[0] === "db" && segments.length > 2 ? `db/${segments[1]}` : segments[0]!
}

function termsOf(manifest: LayerManifest): LayerTerms {
	return {
		name: manifest.name,
		license: manifest.license ?? null,
		attribution: manifest.attribution ?? null,
		source: manifest.source ?? null,
	}
}

function manifestRead(entry: InventoryEntry): ManifestRead {
	if (entry.manifestError) return ManifestRead.Invalid

	if (entry.provenance === Provenance.Manifested) return ManifestRead.Read

	return entry.provenance === Provenance.Unreadable ? ManifestRead.Unopenable : ManifestRead.Absent
}

/**
 * The report over `inventory`'s databases.
 *
 * @param locations Where each source is obtained, joined from the owners' tables.
 */
export function buildLayerReport(
	inventory: InventoryReport,
	locations: { locate: SourceLocator; unavailable: readonly string[] }
): LayerReport {
	const ours = inventory.entries.filter((entry) => entry.provenance !== Provenance.Foreign)
	const knownLayers = ours.flatMap((entry) => (entry.manifest && !entry.manifestError ? [termsOf(entry.manifest)] : []))
	const families = new Map<string, LayerFamilyCount>()
	const licenses = new Map<string, LayerLicenseCount>()
	const sources = new Map<string, LayerSourceCount>()
	let withoutLicense = 0

	const entries = ours.map((entry): LayerReportEntry => {
		const family = layerFamily(entry.path)
		const read = manifestRead(entry)
		const count = families.get(family) ?? { family, read: 0, unread: 0 }

		families.set(family, count)

		const base: LayerReportEntry = {
			path: entry.path,
			family,
			manifest: read,
			...(entry.selection ? { selection: entry.selection } : {}),
		}

		if (read !== ManifestRead.Read) {
			count.unread++

			return { ...base, reason: entry.manifestError ?? entry.note ?? "the inventory recorded no reason" }
		}

		count.read++

		const manifest = entry.manifest!
		const terms = termsOf(manifest)
		const provenance = resolveLayerTerms([terms], { knownLayers, locate: locations.locate })
		const summary = manifest.license ? summarizeLicense(manifest.license) : null

		if (manifest.license) {
			for (const identifier of new Set(licenseIdentifiers(manifest.license))) {
				const known = licenses.get(identifier)

				if (known) {
					known.databases++

					continue
				}

				const identifierSummary = summarizeLicense(identifier)

				licenses.set(identifier, {
					identifier,
					obligations: identifierSummary.obligations,
					recognized: identifierSummary.recognized,
					textURL: licenseTextURL(identifier),
					databases: 1,
				})
			}
		} else {
			withoutLicense++
		}

		const reportSources = provenance.sources.map((source): LayerReportSource => ({
			name: source.name,
			title: source.location?.title ?? null,
			url: source.location?.url ?? null,
			upstream: source.upstream,
		}))

		for (const source of reportSources) {
			const known = sources.get(source.name)

			if (known) {
				known.databases++
			} else {
				sources.set(source.name, { ...source, databases: 1 })
			}
		}

		return {
			...base,
			terms: {
				layer: manifest.name,
				version: manifest.version,
				tier: manifest.tier,
				license: manifest.license ?? null,
				obligations: summary?.obligations ?? [],
				unknownIdentifiers: summary?.unrecognized ?? [],
				attribution: manifest.attribution ?? null,
				source: manifest.source,
				sources: reportSources,
				sourceVintage: manifest.source_vintage,
				createdAt: manifest.created_at,
			},
		}
	})

	const read = entries.filter((entry) => entry.manifest === ManifestRead.Read).length

	return {
		read,
		unread: entries.length - read,
		families: [...families.values()].toSorted((a, b) => a.family.localeCompare(b.family)),
		licenses: [...licenses.values()].toSorted(
			(a, b) => b.databases - a.databases || a.identifier.localeCompare(b.identifier)
		),
		withoutLicense,
		sources: [...sources.values()].toSorted((a, b) => b.databases - a.databases || a.name.localeCompare(b.name)),
		entries,
		unavailableSourceTables: [...locations.unavailable],
	}
}

/**
 * An obligations list as one phrase, with `unknown` for identifiers without recorded obligations.
 */
export function obligationsPhrase(obligations: readonly string[], unknown: readonly string[]): string {
	const parts = [
		...obligations.map((obligation) => obligation.replaceAll("_", "-")),
		...(unknown.length ? ["unknown"] : []),
	]

	return parts.length ? parts.join(", ") : "none"
}

/**
 * The summary lines of a report: families, licenses, sources and unread databases.
 */
export function layerReportSummaryLines(report: LayerReport): string[] {
	const count = (state: ManifestRead) => report.entries.filter((entry) => entry.manifest === state).length
	const invalid = count(ManifestRead.Invalid)

	const lines = [
		`layer manifests: ${report.read} read + ${invalid} invalid + ${count(ManifestRead.Absent)} absent + ` +
			`${count(ManifestRead.Unopenable)} unopenable = ${report.entries.length} databases`,
		`  The ${report.read + invalid} that carry a layer_manifest table are the ${report.read} read and the ` +
			`${invalid} whose row the reader refuses.`,
		``,
		`by layer family (read / unread):`,
		...report.families.map(
			(family) => `  ${String(family.read).padStart(4)} / ${String(family.unread).padEnd(4)}  ${family.family}`
		),
		``,
		`licenses the read manifests record (identifier, obligations, databases):`,
		...report.licenses.map(
			(license) =>
				`  ${license.identifier}  ${obligationsPhrase(license.obligations, license.recognized ? [] : [license.identifier])}  ${license.databases}${license.textURL ? `  ${license.textURL}` : "  (no published text linked)"}`
		),
	]

	if (report.withoutLicense) {
		lines.push(`  ${report.withoutLicense} read manifest(s) predate the license column and record no license`)
	}

	lines.push(
		``,
		`sources the read manifests record (name, databases, where to obtain it):`,
		...report.sources.map((source) => `  ${source.name}  ${source.databases}  ${sourceLocationPhrase(source)}`)
	)

	if (report.unavailableSourceTables.length) {
		lines.push(
			`  The source tables of ${report.unavailableSourceTables.join(", ")} are not installed, so their sources read as unlocated.`
		)
	}

	const unread = report.entries.filter((entry) => entry.manifest !== ManifestRead.Read)

	if (unread.length) {
		lines.push(
			``,
			`databases without a readable layer_manifest (${unread.length}), which state no license (family, databases, state: reason):`
		)

		const groups = Map.groupBy(unread, (entry) => stringifyJSON([entry.family, entry.manifest, entry.reason ?? ""]))
		const width = Math.max(...unread.map((entry) => entry.family.length))

		for (const members of groups.values()) {
			const { family, manifest, reason } = members[0]!

			lines.push(`  ${family.padEnd(width)}  ${String(members.length).padStart(4)}  ${manifest}: ${reason}`)

			// An invalid or unopenable database is one an operator must repair, so its path is listed here.
			if (manifest !== ManifestRead.Absent) {
				lines.push(...members.map((entry) => `      ${entry.path}`))
			}
		}

		lines.push(`Pass --all to list the path of every database, absent ones included, with its state and reason.`)
	}

	return lines
}

/**
 * Where a source is obtained, as one phrase.
 */
export function sourceLocationPhrase(source: LayerReportSource): string {
	if (source.url) return `${source.title} — ${source.url}`

	if (source.upstream) return `the layer ${source.upstream} under this data root`

	return "no location known"
}

/**
 * The lines `--all` adds beneath one database.
 */
export function layerReportEntryLines(entry: LayerReportEntry): string[] {
	if (!entry.terms) return [`manifest ${entry.manifest}: ${entry.reason ?? "unknown reason"}`]

	const terms = entry.terms

	return [
		`layer ${terms.layer}@${terms.version}, tier ${terms.tier}, vintage ${terms.sourceVintage}, built ${terms.createdAt}`,
		`license ${terms.license ?? "unrecorded in layer_manifest"}; obligations: ${terms.license ? obligationsPhrase(terms.obligations, terms.unknownIdentifiers) : "unknown"}`,
		...terms.sources.map((source) => `source ${source.name}: ${sourceLocationPhrase(source)}`),
	]
}
