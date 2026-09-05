/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate Software Bill of Materials (SBOM) artifacts for the published `mailwoman` package in
 *   BOTH open standards — SPDX 2.3 and CycloneDX 1.5 — using the zero-dependency `npm sbom` builtin
 *   (npm >= 9.5). The files land in `docs/static/sbom/` so Docusaurus serves them at
 *   `https://mailwoman.ai/sbom/mailwoman-<version>.{spdx,cdx}.json`.
 *
 *   Why generate from the PUBLISHED tarball rather than the working tree: the monorepo uses yarn's
 *   `workspace:*` protocol, which `npm sbom` cannot resolve, and an SBOM's job is to document what a
 *   consumer actually installs — concrete versions, the production dependency closure. So the
 *   operation `npm pack`s the released version, then installs and inspects THAT.
 *
 *   One wrinkle: the published `mailwoman` package.json carries a single devDependency,
 *   `@mailwoman/osm`, an internal dev-only workspace that is never published (a clean install would
 *   404 on it). Consumers never install a dependency's devDependencies, and a production SBOM excludes
 *   them by definition, so devDependencies are stripped before installing. The extracted tarball
 *   directory is renamed to `mailwoman` so the CycloneDX root component's display name (which npm
 *   derives from the directory basename) reads `mailwoman` rather than `package`.
 *
 *   Two npm-SPDX-output quirks are normalized so the document passes the SPDX reference validator
 *   (pyspdxtools): the `created` timestamp is truncated to whole seconds (SPDX forbids fractional
 *   seconds) and any `_` in an SPDXID is rewritten to `-` (the SPDX SPDXID charset is letters,
 *   numbers, `.`, and `-` only — e.g. `string_decoder`). The rewrite is applied consistently across
 *   every SPDXID cross-reference (documentDescribes, relationships, hasFiles) so the graph stays
 *   internally consistent. CycloneDX output validates as-is and is only re-serialized for a tidy diff.
 *
 *   Usage:  yarn mwops release sbom [--version <x.y.z>] [--out <dir>]
 *     --version  the published `mailwoman` version to document (default: the `mailwoman` workspace's
 *                package.json version — i.e. the version this repo would publish).
 *     --out      output directory (default: docs/static/sbom).
 *
 *   Validate the output (the DPG demonstrable-adherence evidence — see docs/articles/licensing/sbom.md):
 *     SPDX:       uvx --from spdx-tools pyspdxtools -i docs/static/sbom/mailwoman-<version>.spdx.json
 *     CycloneDX:  cyclonedx-cli validate --input-file docs/static/sbom/mailwoman-<version>.cdx.json
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, movePath, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/json"
import { runFileSync } from "@mailwoman/core/process"
import { dirname, join, resolvePath, type PathBuilderLike } from "path-ts"

/**
 * SPDX restricts the SPDXID charset to letters, numbers, `.` and `-`; npm emits `_` from package names.
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
 * Rewrite npm's SPDX output into a form the SPDX 2.3 reference validator accepts (see file header).
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
	 * SPDX packages minus the root component.
	 */
	dependencies: number
}

export async function generateSBOM(options: GenerateSBOMOptions): Promise<GenerateSBOMReport> {
	const { repoRoot, log } = options

	const version =
		options.version ??
		(await readLocalJSONFile<{ version: string }>(join(repoRoot, "packages", "mailwoman", "package.json"))).version

	const outDir = options.out ? resolvePath(repoRoot, options.out) : join(repoRoot, "docs", "static", "sbom")

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
	const pkgDir = tmp.resolve("mailwoman")
	await movePath(tmp.resolve("package"), pkgDir)

	// Strip devDependencies (the unpublished, dev-only `@mailwoman/osm`) — never part of the consumer closure.
	const manifestPath = join(pkgDir, "package.json")
	const manifest = await readLocalJSONFile<Record<string, unknown>>(manifestPath)
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

	const spdxPath = join(outDir, `mailwoman-${version}.spdx.json`)
	await writeLocalJSONFile(spdx, spdxPath)

	log("[sbom] generating CycloneDX 1.5…")

	const cdx = parseJSONStrict(
		run("npm", ["sbom", "--sbom-format", "cyclonedx", "--omit=dev", "--sbom-type", "application"], pkgDir)
	)

	const cdxPath = join(outDir, `mailwoman-${version}.cdx.json`)
	await writeLocalJSONFile(cdx, cdxPath)

	// minus the root component
	const dependencies = (spdx.packages?.length ?? 0) - 1

	log(
		`\n[sbom] ✅ wrote SBOMs for mailwoman@${version} (${dependencies} dependencies)\n` +
			`         ${spdxPath.replace(`${repoRoot}/`, "")}\n` +
			`         ${cdxPath.replace(`${repoRoot}/`, "")}`
	)

	log(
		"\n[sbom] validate:\n" +
			`         uvx --from spdx-tools pyspdxtools -i ${dirname(spdxPath).replace(`${repoRoot}/`, "")}/mailwoman-${version}.spdx.json\n` +
			`         cyclonedx-cli validate --input-file ${dirname(cdxPath).replace(`${repoRoot}/`, "")}/mailwoman-${version}.cdx.json`
	)

	return { version, spdxPath, cdxPath, dependencies }
}
