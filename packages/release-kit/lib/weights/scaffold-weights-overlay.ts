/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Create a data-only `@mailwoman/neural-weights-<locale>` overlay package.
 *
 *   It writes the overlay files and updates the required registration lists so
 *   setup is consistent and less error-prone.
 *
 *   It intentionally does not edit `.github/workflows/publish.yml` because
 *   artifact lines there are explicit and should stay a manual choice.
 *
 *   Usage:
 *     yarn mwops release scaffold-weights-overlay --locale es-ES --artifact pair-index-es.bin
 */

import { readLocalJSONFile, readLocalTextFile, tryStat } from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { isRegisteredWorkspace } from "@mailwoman/core/workspaces"
import { resolvePath } from "path-ts"

/**
 * Relative path to the clean-install smoke pack set.
 */
const SMOKE_PACK_SET_PATH = "packages/release-kit/lib/release/smoke/clean-install.ts"

export interface ScaffoldWeightsOverlayOptions {
	repoRoot: string
	/**
	 * BCP-47 tag, e.g. `es-ES`.
	 */
	locale: string
	/**
	 * The one artifact the overlay adds.
	 *
	 * Defaults to `pair-index-<cc>.bin`, or `fst-<locale>.bin` under `base`.
	 */
	artifact?: string
	/**
	 * Optional character-path family (for example `cjk`) to inherit from.
	 *
	 * When set, the overlay uses `@mailwoman/neural-weights-<base>` and is registered
	 * under `charWeights.<base>.overlays` instead of `locales`.
	 */
	base?: string
	log: (line: string) => void
}

export interface ScaffoldWeightsOverlayReport {
	packageDir: string
	packageName: string
	version: string
	artifact: string
	registered: string[]
}

export async function scaffoldWeightsOverlay(
	options: ScaffoldWeightsOverlayOptions
): Promise<ScaffoldWeightsOverlayReport> {
	const { repoRoot, log } = options

	if (!options.locale) {
		throw new Error("scaffold-weights-overlay: --locale is required (e.g. es-ES)")
	}

	const repoPath = (...segments: string[]) => resolvePath(repoRoot, ...segments)

	/**
	 * BCP-47 in, lowercase slug out: `es-ES` → `es-es`.
	 *
	 * The slug is used for directories, package names, and registrations.
	 * Original casing is kept only in `model-card.json` (`locale`).
	 */
	const localeTag = options.locale
	const slug = localeTag.toLowerCase()
	const country = slug.split("-")[1] ?? ""
	const pkgDir = repoPath("packages", `neural-weights-${slug}`)
	const packageName = `@mailwoman/neural-weights-${slug}`
	const base = options.base
	const basePackage = base ? `@mailwoman/neural-weights-${base}` : "@mailwoman/neural-weights-en-us"
	const artifact = options.artifact ?? (base ? `fst-${slug}.bin` : `pair-index-${country}.bin`)

	if (await tryStat(pkgDir)) {
		throw new Error(`scaffold-weights-overlay: ${pkgDir} already exists — refusing to overwrite`)
	}

	/**
	 * Use the root version so new workspaces stay version-synced.
	 */
	const rootVersion = await readPackageJSON<{ version: string }>(repoPath("package.json")).then((res) => res.version)

	await makeDirectories(resolvePath(pkgDir, "scripts"))

	await writeLocalJSONFile(
		{
			name: packageName,
			version: rootVersion,
			description: `${localeTag} weights overlay for mailwoman — data-only; shares the base model with ${basePackage}.`,
			license: "AGPL-3.0",
			type: "module",
			// `directory` names this package.
			// It is the field that has been wrong every time an overlay was created by copying a sibling.
			repository: {
				type: "git",
				url: "https://github.com/sister-software/mailwoman.git",
				directory: `packages/neural-weights-${slug}`,
			},
			// `!scripts/**` keeps the dev linker out of the tarball.
			// It imports the shared builder by relative path, which fails after unpacking,
			// and a data-only overlay has no use for a dev script anyway.
			files: [
				"model-card.json",
				artifact,
				"README.md",
				"*.ts",
				"**/*.ts",
				"!*.test.ts",
				"!**/*.test.ts",
				"!scripts/**",
			],
			dependencies: { [basePackage]: "workspace:*" },
			// The dev linker imports the shared builder.
			// Knip refuses an import no manifest declares.
			devDependencies: { "@mailwoman/resolver-wof-sqlite": "workspace:*" },
			mailwoman: { baseWeights: basePackage },
		},
		pkgDir,
		"package.json"
	)

	await writeLocalTextFile(
		`# Derived artifacts — built by scripts/link-dev-weights.ts for local dev, fetched from the HF\n# bucket at publish time. Never committed.\n/${base ? artifact : artifact.replace(/-[a-z]{2}\.bin$/, "-*.bin")}\n`,
		pkgDir,
		".gitignore"
	)

	await writeLocalTextFile(
		readLocalTextFile(repoPath("packages/neural-weights-en-nz", ".npmignore")),
		pkgDir,
		".npmignore"
	)

	// Generate the dev linker instead of copying from another locale.
	// Placeholder magnitudes below should be calibrated.
	await writeLocalTextFile(
		base
			? `/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Dev-weights linker for \`${packageName}\`.
 *
 *   The steps live in \`@mailwoman/resolver-wof-sqlite/weights-overlay-linker\` and this file is the manifest — the
 *   overlay declares \`mailwoman.baseWeights\` on \`${basePackage}\`, so the graph and the character vocabulary are the
 *   family's and this links only the per-locale FST (\`${artifact}\`) from the shared build area, so
 *   \`resolveWeights({locale: "${slug}"})\` surfaces \`fstPath\` in local dev.
 */
import { materializeDevOverlay } from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

await materializeDevOverlay({
	locale: "${slug}",
	model: { kind: "inherit" },
	localeFST: true,
})
`
			: `/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Dev-weights linker for \`${packageName}\`.
 *
 *   The steps live in \`@mailwoman/resolver-wof-sqlite/weights-overlay-linker\` and this file is the manifest — the
 *   overlay declares \`mailwoman.baseWeights\`, so it symlinks nothing and its only job is building the index that makes
 *   \`resolveWeights({locale: "${slug}"})\` surface \`pairIndexPath\` in local dev.
 *
 *   TODO(${slug}): say what makes this locale's index required, and what it is inert without. If
 *   the locale writes its postcode before the locality, it needs entries in
 *   \`SEGMENT_PARENT_POSTCODE_SHAPES\` and \`LEADING_POSTCODE_COUNTRIES\`
 *   (\`neural/placetype-pair-prior.ts\`) or the artifact changes nothing; if it writes the postcode
 *   last, say so, because the absence from that set is then deliberate. Write this for ${slug} rather than
 *   for whichever locale you read first.
 */

import { materializeDevOverlay } from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

await materializeDevOverlay({
	locale: "${slug}",
	pairIndex: {
		country: "${country}",
		// TODO(${slug}): calibrate. These are the magnitudes every existing overlay was measured at rather than
		// a measurement of this one.
		delta: 10,
		transitionBeta: 5,
	},
})
`,
		resolvePath(pkgDir, "scripts", "link-dev-weights.ts")
	)

	await writeLocalTextFile(
		`# ${packageName}\n\n${localeTag} weights overlay for [mailwoman](https://mailwoman.ai).\n\n**Data-only.** Declares \`mailwoman.baseWeights\` and shares the base model and tokenizer with\n\`@mailwoman/neural-weights-en-us\`; what it adds is \`${artifact}\`.\n\n\`\`\`sh\nnpm install ${packageName}\n\`\`\`\n`,
		pkgDir,
		"README.md"
	)

	await writeLocalJSONFile(
		{
			name: packageName,
			version: "7.0.0",
			locale: localeTag,
			license: "AGPL-3.0",
			$comment:
				`Data-only overlay. Shares model.onnx + ${base ? "char-vocab.json" : "tokenizer.model"} with ${base ?? "en-us"} via mailwoman.baseWeights. ` +
				"Deliberately carries NO `labels`: the vocabulary belongs to the shared MODEL, so it is inherited " +
				"from the base card at resolve time. Copying it here creates a second copy to go stale on the next " +
				"retrain, and an overlay whose labels disagree with its model throws on the first parse.",
			files: { model_card: "model-card.json" },
		},
		pkgDir,
		"model-card.json"
	)

	/**
	 * Add `entry` to a JSON string array right after `findAfter`.
	 *
	 * @returns `false` if the entry already exists.
	 */
	async function registerInJSONArray(file: string, findAfter: string, entry: string): Promise<boolean> {
		const path = repoPath(file)
		const text = await readLocalTextFile(path)

		if (text.includes(`"${entry}"`)) return false

		await writeLocalTextFile(text.replace(`"${findAfter}",`, `"${findAfter}",\n\t\t\t\t"${entry}",`), path)

		return true
	}

	const registered: string[] = []

	// 1. Root workspaces.
	// Add only if no existing workspace pattern already covers this directory.
	const rootPath = repoPath("package.json")
	const rootPkg = await readLocalJSONFile<{ workspaces: string[] }>(rootPath)

	if (!(await isRegisteredWorkspace(repoPath(), `packages/neural-weights-${slug}`))) {
		rootPkg.workspaces.push(`packages/neural-weights-${slug}`)

		await writeLocalJSONFile(rootPkg, rootPath)
		registered.push("root package.json workspaces")
	}

	// 2. Release list.

	const updatedWeightsEntry = await registerInJSONArray(
		".release-it.json",
		"packages/neural-weights-en-nz",
		`packages/neural-weights-${slug}`
	)

	if (updatedWeightsEntry) {
		registered.push(".release-it.json")
	}

	// 3. release.config.json: update `locales` or `charWeights.<base>.overlays`.
	const cfgPath = repoPath("release.config.json")
	const cfgText = await readLocalTextFile(cfgPath)

	if (base) {
		const cfg = await readLocalJSONFile<{ charWeights?: Record<string, { overlays?: string[] }> }>(cfgPath)
		const family = cfg.charWeights?.[base]

		if (!family) {
			throw new Error(`scaffold-weights-overlay: release.config.json declares no charWeights.${base} to inherit from`)
		}

		if (!(family.overlays ??= []).includes(slug)) {
			family.overlays.push(slug)
			await writeLocalJSONFile(cfg, cfgPath)
			registered.push(`release.config.json charWeights.${base}.overlays`)
		}
	} else if (!cfgText.includes(`"${slug}"`)) {
		await writeLocalTextFile(cfgText.replace(`"en-nz"`, `"${slug}",\n\t\t"en-nz"`), cfgPath)
		registered.push("release.config.json locales")
	}

	// 4. Smoke pack set.
	const smokePath = repoPath(SMOKE_PACK_SET_PATH)
	const smokeText = await readLocalTextFile(smokePath)

	if (!smokeText.includes(packageName)) {
		await writeLocalTextFile(
			smokeText.replace(
				`\t"@mailwoman/neural-weights-en-nz": "packages/neural-weights-en-nz",`,
				`\t"@mailwoman/neural-weights-en-nz": "packages/neural-weights-en-nz",\n\t"${packageName}": "packages/neural-weights-${slug}",`
			),
			smokePath
		)

		registered.push("smoke pack set")
	}

	log(`scaffolded ${pkgDir}`)
	log(`  package: ${packageName}@${rootVersion}`)
	log(`  artifact: ${artifact}`)
	log(`  registered: ${registered.join(", ") || "(all already present)"}`)
	log("")
	log("STILL MANUAL — these name artifacts explicitly, so they stay a human decision:")
	log(`  1. packages/neural/test/pair-index-card-parity.test.ts — add a PACKAGES row once the card has its block`)
	log(`  2. .github/workflows/publish.yml — add ${artifact} to the preflight list, the $CURL fetch,`)
	log(`     the non-empty guard and the --pair-indexes remediation string`)
	log(`  3. OPERATOR: first-publish ${packageName} (OIDC cannot CREATE a package)`)
	log("")
	log(`WRITTEN BUT NOT FINISHED — scripts/link-dev-weights.ts has two TODO(${slug}) markers:`)
	log(`  - the docstring's "what this index is inert without", written for ${slug} specifically`)
	log(`  - delta / transitionBeta, which are every other overlay's magnitudes until measured`)

	return { packageDir: pkgDir, packageName, version: rootVersion, artifact, registered }
}
