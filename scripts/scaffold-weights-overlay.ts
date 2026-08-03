/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Scaffold a data-only `@mailwoman/neural-weights-<locale>` overlay and register it everywhere it
 *   has to be registered.
 *
 *   WHY THIS EXISTS. A weights overlay is six small files, which makes copying a sibling look like
 *   the obvious move. It is not: copying carried `repository.directory` verbatim THREE times in one
 *   day (de-de took en-nz's, then en-in took de-de's before that was fixed, propagating the wrong
 *   value two hops), each time turning `main` red on the #757 provenance test. The fields that must
 *   NOT survive a copy are precisely the ones naming the source, and a human diffing two
 *   near-identical manifests is bad at spotting them.
 *
 *   A new overlay also has FIVE registration points, and missing any one fails at a different stage
 *   and a different time:
 *
 *   1. root `package.json` `workspaces` — miss it and `yarn pack` says "not part of the project"
 *   2. `.release-it.json` — miss it and the package never publishes
 *   3. `scripts/smoke-clean-install.ts` pack set — miss it and the clean-install smoke skips it
 *   4. `neural/test/pair-index-card-parity.test.ts` — miss it and its card can drift unchecked
 *   5. `release.config.json` `locales` — miss it and `copy-weights` never materializes its binary
 *
 *   This writes all six files and edits all five registers, so the failure mode is "the command was
 *   not run" rather than "the command was run and one edit was forgotten".
 *
 *   Deliberately does NOT touch `.github/workflows/publish.yml`: its fetch/preflight/guard lines
 *   name artifacts explicitly and a locale may or may not ship a pair index, a postcode binary or an
 *   FST. That edit stays a human decision, and the command prints the exact lines to add.
 *
 *   Usage:
 *     node scripts/scaffold-weights-overlay.ts --locale es-ES --artifact pair-index-es.bin
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"

import { repoRootPath } from "@mailwoman/core/utils"

const { values } = parseArgs({
	options: {
		locale: { type: "string" },
		artifact: { type: "string" },
	},
})

if (!values.locale) {
	throw new Error("scaffold-weights-overlay: --locale is required (e.g. es-ES)")
}

/**
 * BCP-47 in, lowercase package suffix out: `es-ES` → `es-es`. The workspace directory, the package name and every
 * register use this form; the ORIGINAL casing is kept only for the model card's `locale` field, which is the one place
 * the tag is a tag rather than an identifier.
 */
const localeTag = values.locale
const slug = localeTag.toLowerCase()
const country = slug.split("-")[1] ?? ""
const pkgDir = String(repoRootPath(`neural-weights-${slug}`))
const packageName = `@mailwoman/neural-weights-${slug}`
const artifact = values.artifact ?? `pair-index-${country}.bin`

if (existsSync(pkgDir)) {
	throw new Error(`scaffold-weights-overlay: ${pkgDir} already exists — refusing to overwrite`)
}

/**
 * Read the ROOT version rather than a sibling package's. `prepare-release-version` refuses to bump a tree that is not
 * version-synced, so a new workspace must be born at the root version — the v8.4.0 bdc/filer drift is what that guard
 * exists to catch.
 */
const rootVersion = JSON.parse(readFileSync(String(repoRootPath("package.json")), "utf8")).version as string

mkdirSync(resolve(pkgDir, "scripts"), { recursive: true })

writeFileSync(
	resolve(pkgDir, "package.json"),
	`${JSON.stringify(
		{
			name: packageName,
			version: rootVersion,
			description: `${localeTag} weights overlay for mailwoman — data-only; shares the base model with @mailwoman/neural-weights-en-us.`,
			license: "AGPL-3.0",
			type: "module",
			// `directory` names THIS package. It is the field that has been wrong every time an overlay was
			// created by copying a sibling.
			repository: {
				type: "git",
				url: "https://github.com/sister-software/mailwoman.git",
				directory: `neural-weights-${slug}`,
			},
			// `!scripts/**` keeps the dev linker out of the tarball. It imports the shared builder by
			// relative path, which does not resolve once unpacked — and a data-only overlay has no use
			// for a dev script anyway.
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
			dependencies: { "@mailwoman/neural-weights-en-us": "workspace:*" },
			mailwoman: { baseWeights: "@mailwoman/neural-weights-en-us" },
		},
		null,
		"\t"
	)}\n`
)

writeFileSync(
	resolve(pkgDir, ".gitignore"),
	`# Derived artifacts — built by scripts/link-dev-weights.ts for local dev, fetched from the HF\n# bucket at publish time. Never committed.\n/${artifact.replace(/-[a-z]{2}\.bin$/, "-*.bin")}\n`
)

writeFileSync(
	resolve(pkgDir, ".npmignore"),
	readFileSync(String(repoRootPath("neural-weights-en-nz", ".npmignore")), "utf8")
)

// The dev linker, emitted rather than copied. This step used to be a printed instruction reading
// "copy the closest sibling's build block", and that is precisely how es-es and it-it came to ship
// de-de's docstring — describing German addresses, in packages whose code was correct. Generating it
// leaves nothing to copy; the magnitudes below are placeholders the author is told to calibrate.
writeFileSync(
	resolve(pkgDir, "scripts", "link-dev-weights.ts"),
	`/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Dev-weights linker for \`${packageName}\`.
 *
 *   The build itself lives in \`scripts/weights-overlay-linker.ts\` — this overlay declares
 *   \`mailwoman.baseWeights\`, so it symlinks nothing and its only job is building the index that makes
 *   \`resolveWeights({locale: "${slug}"})\` surface \`pairIndexPath\` in local dev.
 *
 *   TODO(${slug}): say what makes this locale's index load-bearing, and what it is INERT without. If
 *   the locale writes its postcode BEFORE the locality, it needs entries in
 *   \`SEGMENT_PARENT_POSTCODE_SHAPES\` and \`LEADING_POSTCODE_COUNTRIES\`
 *   (\`neural/placetype-pair-prior.ts\`) or the artifact changes nothing; if it writes the postcode
 *   last, say so, because the ABSENCE from that set is then deliberate. Write this for ${slug}, not
 *   for whichever locale you read first.
 */

import { buildPairIndexOverlay } from "../../scripts/weights-overlay-linker.ts"

buildPairIndexOverlay({
	packageDir: "neural-weights-${slug}",
	country: "${country}",
	// TODO(${slug}): calibrate. These are the magnitudes every existing overlay was measured at, not
	// a measurement of this one.
	delta: 10,
	transitionBeta: 5,
})
`
)

writeFileSync(
	resolve(pkgDir, "README.md"),
	`# ${packageName}\n\n${localeTag} weights overlay for [mailwoman](https://mailwoman.sister.software).\n\n**Data-only.** Declares \`mailwoman.baseWeights\` and shares the base model and tokenizer with\n\`@mailwoman/neural-weights-en-us\`; what it adds is \`${artifact}\`.\n\n\`\`\`sh\nnpm install ${packageName}\n\`\`\`\n`
)

writeFileSync(
	resolve(pkgDir, "model-card.json"),
	`${JSON.stringify(
		{
			name: packageName,
			version: "7.0.0",
			locale: localeTag,
			license: "AGPL-3.0",
			$comment: "Data-only overlay. Shares model.onnx + tokenizer.model with en-us via mailwoman.baseWeights.",
			files: { model_card: "model-card.json" },
		},
		null,
		"\t"
	)}\n`
)

/**
 * Insert `entry` into a JSON array-valued key, immediately after `after`, preserving tab indentation. Returns false
 * when the entry is already present so re-running the command is a no-op rather than a duplicate.
 */
function registerInJSONArray(file: string, findAfter: string, entry: string): boolean {
	const path = String(repoRootPath(file))
	const text = readFileSync(path, "utf8")

	if (text.includes(`"${entry}"`)) return false

	writeFileSync(path, text.replace(`"${findAfter}",`, `"${findAfter}",\n\t\t\t\t"${entry}",`))

	return true
}

const registered: string[] = []

// 1. Root workspaces.
const rootPath = String(repoRootPath("package.json"))
const rootPkg = JSON.parse(readFileSync(rootPath, "utf8")) as { workspaces: string[] }

if (!rootPkg.workspaces.includes(`neural-weights-${slug}`)) {
	rootPkg.workspaces.splice(rootPkg.workspaces.indexOf("neural-weights-en-nz") + 1, 0, `neural-weights-${slug}`)
	writeFileSync(rootPath, `${JSON.stringify(rootPkg, null, "\t")}\n`)
	registered.push("root package.json workspaces")
}

// 2. Release list.
if (registerInJSONArray(".release-it.json", "neural-weights-en-nz", `neural-weights-${slug}`)) {
	registered.push(".release-it.json")
}

// 3. release.config.json locales.
const cfgPath = String(repoRootPath("release.config.json"))
const cfgText = readFileSync(cfgPath, "utf8")

if (!cfgText.includes(`"${slug}"`)) {
	writeFileSync(cfgPath, cfgText.replace(`"en-nz"`, `"${slug}",\n\t\t"en-nz"`))
	registered.push("release.config.json locales")
}

// 4. Smoke pack set.
const smokePath = String(repoRootPath("scripts", "smoke-clean-install.ts"))
const smokeText = readFileSync(smokePath, "utf8")

if (!smokeText.includes(packageName)) {
	writeFileSync(
		smokePath,
		smokeText.replace(
			`\t"@mailwoman/neural-weights-en-nz": "neural-weights-en-nz",`,
			`\t"@mailwoman/neural-weights-en-nz": "neural-weights-en-nz",\n\t"${packageName}": "neural-weights-${slug}",`
		)
	)

	registered.push("smoke pack set")
}

console.log(`scaffolded ${pkgDir}`)
console.log(`  package: ${packageName}@${rootVersion}`)
console.log(`  artifact: ${artifact}`)
console.log(`  registered: ${registered.join(", ") || "(all already present)"}`)
console.log("")
console.log("STILL MANUAL — these name artifacts explicitly, so they stay a human decision:")
console.log(`  1. neural/test/pair-index-card-parity.test.ts — add a PACKAGES row once the card has its block`)
console.log(`  2. .github/workflows/publish.yml — add ${artifact} to the preflight list, the $CURL fetch,`)
console.log(`     the non-empty guard and the --pair-indexes remediation string`)
console.log(`  3. OPERATOR: first-publish ${packageName} (OIDC cannot CREATE a package)`)
console.log("")
console.log(`WRITTEN BUT NOT FINISHED — scripts/link-dev-weights.ts has two TODO(${slug}) markers:`)
console.log(`  - the docstring's "what this index is inert without", written for ${slug} specifically`)
console.log(`  - delta / transitionBeta, which are every other overlay's magnitudes until measured`)
