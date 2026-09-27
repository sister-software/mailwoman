/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Whether a layer may cross the boundary from built to published.
 *
 *   `LayerTier` already states the answer. `shipped` is defined as a permissive-license artifact this
 *   project publishes, `build-local` as one whose sources carry share-alike so the builder ships and
 *   the user builds, and `private` as the user's own data. Every reader of the field consulted it for
 *   something other than publication, so `candidate.db` shipped as a bundle while its own manifest
 *   recorded `tier = build-local` and `license = ODbL-1.0 AND CDLA-Permissive-2.0 AND CC-BY-4.0`.
 *
 *   The tier is the assertion and the license expression is the evidence for it, so this reads both and
 *   reports every way they disagree with publishing. A layer whose tier permits publication while its
 *   license carries share-alike is as much a finding as a `build-local` layer in a bundle: one of the
 *   two fields is wrong and the artifact cannot say which.
 *
 *   This takes manifests a caller has already read, so it holds no opinion about where they came from
 *   and needs no database to exercise. The caller reading them decides what to do with a refusal.
 */

import { stringifyJSON } from "#json"
import { LayerTier } from "#layers/schema"
import { LicenseObligation, summarizeLicense } from "#license/obligations"
import { carriesShareAlike, LicenseResolution, readLicenseRecord } from "#license/record"

/**
 * Throws when a manifest's tier contradicts what its license expression establishes.
 *
 * `shipped` requires a resolved expression that carries no share-alike obligation.
 * `build-local` is the tier for a source that cannot be published, so it refuses a resolved
 * expression whose obligations stop at attribution, because such a layer is publishable.
 *
 * An unresolved expression is accepted at `build-local`, because unknown obligations
 * are a reason to withhold publication.
 * `private` makes no claim about the license.
 *
 * @param subject The tier and license expression about to be stamped.
 * @param context Names the build in the error message.
 * @param detail Appended to the message where the caller knows why the license reads as it does.
 * @throws When the tier and the license disagree.
 */
export function assertTierMatchesLicense(
	subject: { tier: string; license: string },
	context: string,
	detail?: string
): void {
	const record = readLicenseRecord(subject.license)
	const suffix = detail ? ` ${detail}` : ""

	if (subject.tier === LayerTier.Shipped) {
		if (record.resolution === LicenseResolution.Unresolved) {
			throw new Error(
				`${context}: tier "shipped" was asked for while the license reads ${stringifyJSON(subject.license)}, ` +
					`whose obligations are not recorded. An unrecognized license carries unknown obligations rather than none.${suffix}`
			)
		}

		if (carriesShareAlike(record)) {
			throw new Error(
				`${context}: license ${subject.license} carries share-alike, so the layer cannot be tier "shipped".${suffix}`
			)
		}

		return
	}

	if (
		subject.tier === LayerTier.BuildLocal &&
		record.resolution === LicenseResolution.Resolved &&
		!carriesShareAlike(record)
	) {
		throw new Error(
			`${context}: tier "build-local" was asked for while license ${subject.license} carries no share-alike ` +
				`obligation. The tier is reserved for a source that cannot be published, and this one can be.${suffix}`
		)
	}
}

/**
 * One reason a layer may not be published, naming the field that says so.
 */
export interface PublicationRefusal {
	/**
	 * The layer's name as its manifest records it.
	 */
	layer: string
	/**
	 * What the caller was about to publish it as, for a message a reader can act on.
	 */
	publishedAs: string
	/**
	 * The manifest field this refusal rests on.
	 */
	field: "tier" | "license"
	reason: string
}

/**
 * The manifest fields a publication decision reads.
 *
 * A subset of `LayerManifest` rather than the whole of it, so a caller holding
 * a partial read can still ask the question.
 */
export interface PublicationSubject {
	name: string
	tier: string
	license: string
	/**
	 * What the caller publishes this layer as, such as a bundle name or a remote path.
	 */
	publishedAs: string
}

/**
 * Every reason the given layers may not be published, in the order they were given.
 *
 * An empty array means each layer's tier permits publication and no license expression contradicts it.
 * It does not mean the expression was verified against the upstream terms,
 * which no code in this repository can decide.
 */
export function refusalsForPublication(subjects: readonly PublicationSubject[]): PublicationRefusal[] {
	const refusals: PublicationRefusal[] = []

	for (const subject of subjects) {
		if (subject.tier !== LayerTier.Shipped) {
			refusals.push({
				layer: subject.name,
				publishedAs: subject.publishedAs,
				field: "tier",
				reason:
					`tier is ${subject.tier || "absent"}, and only ${LayerTier.Shipped} permits publication. ` +
					`${LayerTier.BuildLocal} means the builder ships and the user builds, which is what a ` +
					`share-alike source requires.`,
			})

			continue
		}

		const summary = summarizeLicense(subject.license)

		if (summary.obligations.includes(LicenseObligation.ShareAlike)) {
			refusals.push({
				layer: subject.name,
				publishedAs: subject.publishedAs,
				field: "license",
				reason:
					`tier is ${LayerTier.Shipped} while license ${subject.license} carries share-alike. ` +
					`One of the two fields is wrong and the manifest cannot say which.`,
			})
		}

		if (summary.unrecognized.length) {
			refusals.push({
				layer: subject.name,
				publishedAs: subject.publishedAs,
				field: "license",
				reason:
					`license ${subject.license} holds ${summary.unrecognized.length} identifier(s) with no ` +
					`recorded obligations: ${summary.unrecognized.join(", ")}. An unrecognized identifier carries ` +
					`unknown obligations rather than none, so publication cannot rest on it.`,
			})
		}
	}

	return refusals
}

/**
 * Throws when any layer may not be published, naming every reason rather than the first.
 *
 * @throws When {@link refusalsForPublication} returns any refusal.
 */
export function assertPublishable(subjects: readonly PublicationSubject[]): void {
	const refusals = refusalsForPublication(subjects)

	if (!refusals.length) return

	const lines = refusals.map(
		(refusal) => `  ${refusal.publishedAs} (layer ${refusal.layer}, ${refusal.field}): ${refusal.reason}`
	)

	throw new Error(`${refusals.length} layer(s) may not be published:\n${lines.join("\n")}`)
}
