/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate Software Bill of Materials (sbom) artifacts for the published `mailwoman` package in
 *   both open standards — spdx 2.3 and CycloneDX 1.5 — using the zero-dependency `npm sbom` builtin
 *   (npm >= 9.5). The files land in `docs/static/sbom/` so Docusaurus serves them at
 *   `https://mailwoman.ai/sbom/mailwoman-<version>.{spdx,cdx}.json`.
 *
 *   The monorepo uses Yarn's `workspace:*` protocol. `npm sbom` cannot resolve that protocol.
 *   An SBOM documents what a consumer installs: concrete versions and the production dependency
 *   closure. The operation runs `npm pack` on the released version, then installs and inspects its tarball.
 *
 *   The published `mailwoman` package.json carries one devDependency: `@mailwoman/osm`.
 *   This internal dev-only workspace is never published, so a clean install would return 404.
 *   Consumers do not install a dependency's devDependencies. A production SBOM excludes them by
 *   definition, so the operation strips devDependencies before installation. It renames the extracted
 *   tarball directory to `mailwoman`. npm derives the CycloneDX root display name from the directory
 *   basename, so the renamed directory gives the component the display name `mailwoman`.
 *
 *   The operation normalizes two npm-spdx-output quirks so the document passes the SPDX reference validator
 *   (pyspdxtools). It truncates the `created` timestamp to whole seconds because SPDX forbids fractional
 *   seconds. It rewrites each `_` in an SPDX ID to `-` because the SPDX ID character set allows letters,
 *   numbers, `.`, and `-` only — e.g. `string_decoder`). The rewrite is applied consistently across
 *   every spdxid cross-reference (documentDescribes, relationships, hasFiles) so the graph stays
 *   internally consistent. CycloneDX output validates as-is and is only re-serialized for a tidy diff.
 *
 *   Usage:  yarn mwops release sbom [--version <x.y.z>] [--out <dir>]
 *     --version  the published `mailwoman` version to document (default: the `mailwoman` workspace's
 *                package.json version — i.e. the version this repo would publish).
 *     --out      output directory (default: docs/static/sbom).
 *
 *   Validate the output (the DPG demonstrable-adherence evidence — see docs/articles/licensing/sbom.md):
 *     spdx:       uvx --from spdx-tools pyspdxtools -i docs/static/sbom/mailwoman-<version>.spdx.json
 *     CycloneDX:  cyclonedx-cli validate --input-file docs/static/sbom/mailwoman-<version>.cdx.json
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, movePath, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/json"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { runFileSync } from "@mailwoman/core/process"
import { PathBuilder, type PathBuilderLike, relative, resolvePathBuilder } from "path-ts"

/**
 * Spdx restricts the spdxid charset to letters, numbers, `.` and `-`; npm emits `_` from package names.
 */
const sanitizeSPDXID = (id: string): string => (typeof id === "string" ? id.replaceAll(/[^a-zA-Z0-9.-]/g, "-") : id)

interface SPDXDocument {
	creationInfo: { created: string }
	documentDescribes?: string[]
	packages?: Array<{ SPDXID: string; hasFiles?: string[] }>
	files?: Array<{ SPDXID: string }>
	relationships?: Array<{ spdxElementId: string; relatedSpdxElement: string }>
}

/**
 * Rewrite npm's spdx output into a form the spdx 2.3 reference validator accepts (see file header).
 */
function normalizeSPDX(doc: SPDXDocument): SPDXDocument {
	doc.creationInfo.created = doc.creationInfo.created.replace(/\.\d{3}Z$/, "Z")

	if (Array.isArray(doc.documentDescribes)) {
		doc.documentDescribes = doc.documentDescribes.map(sanitizeSPDXID)
	}

	for (const pkg of doc.packages ?? []) {
		pkg.SPDXID = sanitizeSPDXID(pkg.SPDXID)

		if (Array.isArray(pkg.hasFiles)) {
			pkg.hasFiles = pkg.hasFiles.map(sanitizeSPDXID)
		}
	}

	for (const file of doc.files ?? []) {
		file.SPDXID = sanitizeSPDXID(file.SPDXID)
	}

	for (const rel of doc.relationships ?? []) {
		rel.spdxElementId = sanitizeSPDXID(rel.spdxElementId)
		rel.relatedSpdxElement = sanitizeSPDXID(rel.relatedSpdxElement)
	}

	return doc
}

export interface GenerateSBOMOptions {
	repoRoot: string
	version?: string
	out?: string
	log: (line: string) => void
}

export interface GenerateSBOMReport {
	version: string
	spdxPath: string
	cdxPath: string
	/**
	 * Spdx packages minus the root component.
	 */
	dependencies: number
}

export async function generateSBOM(options: GenerateSBOMOptions): Promise<GenerateSBOMReport> {
	const { log } = options
	const repoRoot = PathBuilder.from(options.repoRoot)

	const version =
		options.version ??
		(await readPackageJSON<{ version: string }>(repoRoot("packages", "mailwoman", "package.json"))).version

	const outDir = options.out ? resolvePathBuilder(repoRoot, options.out) : repoRoot("docs", "static", "sbom")

	const run = (cmd: string, args: string[], cwd: PathBuilderLike): string =>
		runFileSync(cmd, args, {
			maxBuffer: 64 * 1024 * 1024,
			cwd: cwd.toString(),
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
		})

	await using tmp = await temporaryDirectory("mw-sbom-")

	log(`[sbom] packing mailwoman@${version} from the registry…`)

	run("npm", ["pack", `mailwoman@${version}`, "--silent"], tmp.path)
	run("tar", ["xzf", `mailwoman-${version}.tgz`], tmp.path)

	// npm always extracts to `package/`; rename so CycloneDX's basename-derived root name reads `mailwoman`.
	const pkgDir = tmp.path("mailwoman")
	await movePath(tmp.path("package"), pkgDir)

	// Strip devDependencies (the unpublished, dev-only `@mailwoman/osm`), never part of the consumer closure.
	const manifestPath = pkgDir("package.json")
	const manifest = await readPackageJSON(manifestPath)
	delete manifest.devDependencies

	await writeLocalJSONFile(manifest, manifestPath)

	log("[sbom] installing the production dependency closure…")

	run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], pkgDir)

	await makeDirectories(outDir)

	log("[sbom] generating SPDX 2.3…")

	const spdx = normalizeSPDX(
		parseJSONStrict<SPDXDocument>(
			run("npm", ["sbom", "--sbom-format", "spdx", "--omit=dev", "--sbom-type", "application"], pkgDir)
		)
	)

	const spdxPath = outDir(`mailwoman-${version}.spdx.json`)
	await writeLocalJSONFile(spdx, spdxPath)

	log("[sbom] generating CycloneDX 1.5…")

	const cdx = parseJSONStrict(
		run("npm", ["sbom", "--sbom-format", "cyclonedx", "--omit=dev", "--sbom-type", "application"], pkgDir)
	)

	const cdxPath = outDir(`mailwoman-${version}.cdx.json`)
	await writeLocalJSONFile(cdx, cdxPath)

	// minus the root component
	const dependencies = (spdx.packages?.length ?? 0) - 1
	const spdxShown = relative(repoRoot, spdxPath)
	const cdxShown = relative(repoRoot, cdxPath)

	log(
		`\n[sbom] ✅ wrote SBOMs for mailwoman@${version} (${dependencies} dependencies)\n` +
			`         ${spdxShown}\n` +
			`         ${cdxShown}`
	)

	log(
		"\n[sbom] validate:\n" +
			`         uvx --from spdx-tools pyspdxtools -i ${spdxShown}\n` +
			`         cyclonedx-cli validate --input-file ${cdxShown}`
	)

	return { version, spdxPath: spdxPath.toString(), cdxPath: cdxPath.toString(), dependencies }
}
