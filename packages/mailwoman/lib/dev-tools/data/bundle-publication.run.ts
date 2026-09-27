/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ask every bundle's own artifacts whether they may be published, and report each refusal.
 *
 *   `BUNDLES` says what `mailwoman data pull` fetches. Each artifact is a sealed database carrying a
 *   `layer_manifest` whose `tier` states whether this project publishes it, and until now no reader
 *   compared the two. `candidate.db` ships as the `candidate` bundle while its manifest records
 *   `tier = build-local`, which `LayerTier` defines as the tier a share-alike source requires.
 *
 *   The decision lives in `refusalsForPublication`, which reads manifests and holds no opinion about
 *   where they came from. This supplies them from the databases on disk and prints what it read,
 *   including the artifacts it could not read: an absent database is an unanswered question rather than
 *   a pass, and it says so.
 *
 *   Usage:
 *   node packages/mailwoman/lib/dev-tools/data/bundle-publication.run.ts [--bundle <name>]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { refusalsForPublication, type PublicationSubject } from "@mailwoman/core/layers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { BUNDLES, bundleArtifactPath, probeManifest } from "mailwoman/data"

const { values } = parseArguments({
	options: {
		bundle: { type: "string", description: "Only this bundle, rather than every one" },
	},
})

const dataRoot = dataRootPath()
const names = values.bundle ? [values.bundle] : Object.keys(BUNDLES).toSorted()

const subjects: PublicationSubject[] = []
const unreadable: Array<{ bundle: string; path: string; why: string }> = []
const unmanifested: Array<{ bundle: string; path: string }> = []

for (const name of names) {
	const bundle = BUNDLES[name]

	if (!bundle) {
		console.log(`no bundle named ${name}; BUNDLES holds ${Object.keys(BUNDLES).length} entries`)

		process.exitCode = 1

		continue
	}

	for (const artifact of bundle.artifacts) {
		const path = bundleArtifactPath(dataRoot, artifact)
		const { manifest, error } = probeManifest(path)

		if (error) {
			unreadable.push({ bundle: name, path, why: error })

			continue
		}

		if (!manifest) {
			unmanifested.push({ bundle: name, path })

			continue
		}

		subjects.push({
			name: manifest.name,
			tier: manifest.tier,
			// An absent expression reaches `refusalsForPublication` as the empty string, which it
			// reports as an identifier with no recorded obligations rather than reading as permissive.
			license: manifest.license ?? "",
			publishedAs: `bundle ${name} -> ${artifact.remotePath}`,
		})
	}
}

const refusals = refusalsForPublication(subjects)

console.log(`bundles examined      ${names.length}`)
console.log(`artifacts read        ${subjects.length}`)
console.log(`artifacts unreadable  ${unreadable.length}`)
console.log(`artifacts unmanifested ${unmanifested.length}`)
console.log()

for (const subject of subjects) {
	const verdict = refusals.some((refusal) => refusal.publishedAs === subject.publishedAs) ? "REFUSED " : "admitted"

	console.log(`${verdict}  ${subject.tier.padEnd(12)} ${subject.name.padEnd(22)} ${subject.license}`)
}

if (refusals.length) {
	console.log()
	console.log(`${refusals.length} refusal(s):`)

	for (const refusal of refusals) {
		console.log(`  ${refusal.publishedAs}`)
		console.log(`    ${refusal.field}: ${refusal.reason}`)
	}

	process.exitCode = 1
}

if (unmanifested.length) {
	console.log()
	console.log(`${unmanifested.length} artifact(s) hold no layer_manifest, so their tier is unstated:`)

	for (const entry of unmanifested) {
		console.log(`  ${entry.bundle}: ${entry.path}`)
	}

	// An artifact that states no tier cannot be said to permit publication.
	process.exitCode = 1
}

if (unreadable.length) {
	console.log()
	console.log(`${unreadable.length} artifact(s) could not be read, so this pass says nothing about them:`)

	for (const entry of unreadable) {
		console.log(`  ${entry.bundle}: ${entry.path}`)
		console.log(`    ${entry.why}`)
	}
}
