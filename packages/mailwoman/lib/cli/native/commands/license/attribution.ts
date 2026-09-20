/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What this installation is obliged to, read off the artifacts it actually has.
 *
 *   An operator asking what they owe upstream had three places to look and no way to combine them. The repository's
 *   `THIRD_PARTY_NOTICES.md` is one, and a consumer who installed one weights package was never sent to it. Each
 *   package's own `PROVENANCE.json` is another, inside `node_modules`. The commercial agreement is the third, and it
 *   states what it does not cover rather than what does.
 *
 *   This reads the installed packages rather than a catalog. The source register lists sources research has resolved,
 *   which is a different set from the ones an installation carries, and reporting the register here would tell an
 *   operator they owe attribution to publishers whose rows they do not have.
 *
 *   It reports obligations rather than clearing them. Every unresolved question a package records travels through, and
 *   a commercial key changes nothing here: that grant covers first-party code and model artifacts, and an upstream
 *   attribution or share-alike condition survives it.
 */

import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { resolvePath } from "path-ts"

/**
 * The `PROVENANCE.json` fields this reads. Written by `mwops release write-rights-files` and shipped in every published
 * weights package.
 */
interface PackageProvenance {
	package: string
	package_version: string
	license: string
	model_card_version: string | null
	version_series: string
	base_weights: string | null
	inherited_lineage: {
		package: string
		package_version: string
		attribution: Array<{ text: string; license_named: string | null }>
		unresolved: string | null
	} | null
	training_attribution: {
		status: string
		entries: Array<{ text: string; license_named: string | null }>
	}
	attribution_recorded_in_another_package: Array<{ artifact: string; recorded_in: string }>
	unresolved: string[]
}

export interface InstalledPackageReport {
	package: string
	version: string
	license: string
	versionSeries: string
	modelCardVersion: string | null
	/**
	 * Attribution entries for artifacts this package itself ships.
	 */
	own: Array<{ text: string; licenseNamed: string | null }>
	/**
	 * Attribution entries belonging to the package whose graph this one decodes through, labeled as that package's.
	 */
	inherited: { package: string; version: string; entries: Array<{ text: string; licenseNamed: string | null }> } | null
	unresolved: string[]
}

export interface AttributionReport {
	/**
	 * The expression governing the first-party code and model artifacts.
	 */
	engineLicense: string
	packages: InstalledPackageReport[]
	/**
	 * Packages named on the command line or discovered, that are not installed here.
	 */
	notInstalled: string[]
	/**
	 * What this report does not cover, stated rather than left to be inferred from its absence.
	 */
	notCovered: string[]
}

/**
 * The published weights packages this repository knows how to look for.
 *
 * A fixed list rather than a scan of `node_modules`, so a package absent from an installation is reported as absent by
 * name. A scan would report a shorter list and say nothing about what was missing.
 */
export const KNOWN_WEIGHTS_PACKAGES: readonly string[] = [
	"@mailwoman/neural-weights-cjk",
	"@mailwoman/neural-weights-de-de",
	"@mailwoman/neural-weights-en-au",
	"@mailwoman/neural-weights-en-gb",
	"@mailwoman/neural-weights-en-in",
	"@mailwoman/neural-weights-en-nz",
	"@mailwoman/neural-weights-en-us",
	"@mailwoman/neural-weights-es-es",
	"@mailwoman/neural-weights-fr-fr",
	"@mailwoman/neural-weights-it-it",
	"@mailwoman/neural-weights-ja-jp",
	"@mailwoman/neural-weights-zh-cn",
]

/**
 * Read one installed package's provenance record, or `null` when the package is not installed.
 *
 * A package that resolves but carries no `PROVENANCE.json` is reported as not installed for this purpose rather than as
 * installed with nothing to declare. The second reading would present a package published before these records existed
 * as one with no obligations.
 */
async function readInstalled(packageName: string): Promise<PackageProvenance | null> {
	let directory: string

	try {
		directory = String(resolvePackageDirectory(packageName))
	} catch {
		return null
	}

	const provenance = resolvePath(directory, "PROVENANCE.json")

	if (!(await pathExists(provenance))) return null

	return readLocalJSONFile<PackageProvenance>(provenance)
}

/**
 * Build the report for the packages this installation carries.
 */
export async function attributionReport(
	engineLicense: string,
	packageNames: readonly string[] = KNOWN_WEIGHTS_PACKAGES
): Promise<AttributionReport> {
	const packages: InstalledPackageReport[] = []
	const notInstalled: string[] = []

	for (const packageName of packageNames) {
		const provenance = await readInstalled(packageName)

		if (!provenance) {
			notInstalled.push(packageName)

			continue
		}

		packages.push({
			package: provenance.package,
			version: provenance.package_version,
			license: provenance.license,
			versionSeries: provenance.version_series,
			modelCardVersion: provenance.model_card_version,
			own: provenance.training_attribution.entries.map((entry) => ({
				text: entry.text,
				licenseNamed: entry.license_named,
			})),
			inherited: provenance.inherited_lineage
				? {
						package: provenance.inherited_lineage.package,
						version: provenance.inherited_lineage.package_version,
						entries: provenance.inherited_lineage.attribution.map((entry) => ({
							text: entry.text,
							licenseNamed: entry.license_named,
						})),
					}
				: null,
			unresolved: provenance.unresolved,
		})
	}

	return {
		engineLicense,
		packages,
		notInstalled,
		notCovered: [
			"Reference data downloaded separately at runtime. This reads installed npm packages, and a database fetched into $MAILWOMAN_DATA_ROOT carries the terms of whoever published it.",
			"Whether the entries below are the whole of what each source requires. They are what the package records, and a package recording none is not a package with none.",
		],
	}
}

/**
 * The report as lines for a terminal.
 */
export function renderAttributionReport(report: AttributionReport): string[] {
	const lines: string[] = [
		`Engine license: ${report.engineLicense}`,
		"  A commercial agreement covers the code and model artifacts Sister Software authors. It does not reach the",
		"  sources below, whose attribution and share-alike conditions survive it.",
		"",
	]

	if (!report.packages.length) {
		lines.push("No weights package with a provenance record is installed.")
	}

	for (const entry of report.packages) {
		lines.push(`${entry.package} ${entry.version} (${entry.versionSeries}, card ${entry.modelCardVersion ?? "none"})`)

		if (entry.own.length) {
			lines.push("  Sources for the artifacts this package ships:")

			for (const attribution of entry.own) {
				lines.push(`    - ${attribution.text}`)
			}
		} else {
			lines.push("  This package records no attribution of its own.")
		}

		if (entry.inherited) {
			lines.push(
				`  Inherited from ${entry.inherited.package} ${entry.inherited.version}, whose graph it decodes through:`
			)

			for (const attribution of entry.inherited.entries) {
				lines.push(`    - ${attribution.text}`)
			}
		}

		for (const unresolved of entry.unresolved) {
			lines.push(`  Unresolved: ${unresolved}`)
		}

		lines.push("")
	}

	if (report.notInstalled.length) {
		lines.push(`Not installed here: ${report.notInstalled.join(", ")}`, "")
	}

	lines.push("This report does not cover:")

	for (const gap of report.notCovered) {
		lines.push(`  - ${gap}`)
	}

	return lines
}
