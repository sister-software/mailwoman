/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure verdict logic for `mailwoman doctor`. The runner gathers observations and this module classifies them as
 *   `ok`, `missing`, or `degraded`. Optional-layer gaps include fix hints but do not affect the exit code.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { stringifyJSON } from "@mailwoman/core/json"
import {
	docsSiteURL,
	isSelfServicePayload,
	appliedLicenseBranch,
	summarizeLicense,
	type LicenseKeyVerification,
	type LicenseObligation,
} from "@mailwoman/core/license"
import type { LicenseKeyPublication } from "@mailwoman/core/license/publication"
import type { LicenseStatusAnswer } from "@mailwoman/core/license/status"

/**
 * Check outcomes: working, absent but fixable, or present but impaired.
 */
export const CheckStatus = {
	OK: "ok",
	Missing: "missing",
	Degraded: "degraded",
} as const

export type CheckStatus = (typeof CheckStatus)[keyof typeof CheckStatus]

/**
 * One diagnostic result with status, details, and optional fix guidance.
 */
export interface DoctorCheck {
	id: string
	/**
	 * Checklist label.
	 */
	label: string
	status: CheckStatus
	detail: string
	/**
	 * User-facing consequence when the check is not `ok`.
	 */
	consequence?: string
	/**
	 * Command or URL to address the issue.
	 */
	fix?: string
	/**
	 * Whether a non-`ok` result affects the process exit code.
	 */
	core: boolean
	/**
	 * Structured license details, when this is a license check.
	 */
	license?: LicensePosture
}

/**
 * License posture reported by the doctor.
 */
export interface LicensePosture {
	/**
	 * Licensed package or data layer.
	 */
	subject: string
	/**
	 * Recorded SPDX expression.
	 */
	expression: string
	/**
	 * Applicable branch of a dual license, or the expression itself.
	 */
	applied: string
	/**
	 * Known obligations of the applicable branch.
	 */
	obligations: LicenseObligation[]
	recognized: boolean
	/**
	 * Recorded attribution requirement.
	 */
	attribution?: string
	/**
	 * Licensee, key ID, and key status for Mailwoman's own license.
	 */
	licensee?: string
	keyID?: string
	keyStatus?: "valid" | "expired" | "unknown_key" | "invalid" | "retired"
	/**
	 * Self-service license ID and worker-reported status.
	 */
	lid?: string
	lidStatus?: LicenseStatusAnswer
}

/**
 * Diagnostic checks and derived exit code.
 */
export interface DoctorReport {
	checks: DoctorCheck[]
	exitCode: number
}

/**
 * Parsed major, minor, and patch version.
 */
export interface SemverTriple {
	major: number
	minor: number
	patch: number
}

/**
 * Parse the minimum version from an `engines.node` range; missing minor and patch default to zero.
 */
export function parseVersionFloor(engines: string): SemverTriple | undefined {
	const match = engines.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/u)

	if (!match) return undefined

	return { major: Number(match[1]), minor: Number(match[2] ?? 0), patch: Number(match[3] ?? 0) }
}

/**
 * Parse a runtime version in `major.minor.patch` form.
 */
export function parseVersion(version: string): SemverTriple | undefined {
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)/u)

	if (!match) return undefined

	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * Check whether a version meets a minimum major/minor/patch floor.
 */
export function versionMeetsFloor(version: string, floor: string): boolean {
	const v = parseVersion(version)
	const f = parseVersionFloor(floor)

	if (!v || !f) return false

	if (v.major !== f.major) return v.major > f.major

	if (v.minor !== f.minor) return v.minor > f.minor

	return v.patch >= f.patch
}

//#region Observations (facts the runner gathers) → checks (verdicts)

/**
 * Observation of `@mailwoman/neural-weights-en-us` resolution.
 */
export interface WeightsObservation {
	/**
	 * Resolved paths and source, or absent on failure.
	 */
	resolved?: { source: string; modelPath: string; tokenizerPath: string }
	/**
	 * Model file size, if available.
	 */
	modelSize?: number
	/**
	 * Tokenizer file size.
	 */
	tokenizerSize?: number
	/**
	 * Resolution error, if any.
	 */
	error?: string
}

const WEIGHTS_FIX = "npm install @mailwoman/neural-weights-en-us   (or: mailwoman parse --download-weights)"

const WEIGHTS_CONSEQUENCE =
	"The trained model is what reads an address. Without it every parse falls back to the structural " +
	"pipeline, which can only recognise shapes it is certain of (a bare postcode, a bare locality) and " +
	"leaves the rest of the address unlabelled."

/**
 * Check the required trained model bundle.
 */
export function weightsCheck(o: WeightsObservation): DoctorCheck {
	const base = { id: "weights", label: "Model weights (en-us)", core: true }

	if (!o.resolved) {
		return {
			...base,
			status: CheckStatus.Missing,
			detail: o.error ? firstLine(o.error) : "@mailwoman/neural-weights-en-us is not resolvable",
			consequence: WEIGHTS_CONSEQUENCE,
			fix: WEIGHTS_FIX,
		}
	}

	if (!o.modelSize || !o.tokenizerSize) {
		return {
			...base,
			status: CheckStatus.Degraded,
			detail: `resolved (${o.resolved.source}) but a weight file is empty — model.onnx ${ByteFormatter.formatSI(o.modelSize ?? 0)}, tokenizer.model ${ByteFormatter.formatSI(o.tokenizerSize ?? 0)}`,
			consequence: WEIGHTS_CONSEQUENCE,
			fix: WEIGHTS_FIX,
		}
	}

	return {
		...base,
		status: CheckStatus.OK,
		detail: `${o.resolved.source} · model.onnx ${ByteFormatter.formatSI(o.modelSize)}, tokenizer.model ${ByteFormatter.formatSI(o.tokenizerSize)}`,
	}
}

/**
 * Observation of an optional locale weights overlay.
 */
export interface LocaleOverlayObservation {
	locale: string
	packageName: string
	resolved: boolean
	source?: string
}

/**
 * Check an optional locale overlay.
 */
export function localeOverlayCheck(o: LocaleOverlayObservation): DoctorCheck {
	const base = { id: `locale-overlay-${o.locale}`, label: `Locale overlay (${o.locale})`, core: false }

	if (o.resolved) {
		return { ...base, status: CheckStatus.OK, detail: `${o.packageName} resolvable${o.source ? ` (${o.source})` : ""}` }
	}

	return {
		...base,
		status: CheckStatus.Missing,
		detail: `${o.packageName} not installed (optional — only needed for ${o.locale} parsing)`,
		consequence:
			`Passing --locale ${o.locale} will not change how an address is read: the en-us model handles it, ` +
			`and the country-specific conventions that overlay carries (postcode shape, house-number placement) ` +
			`are not applied.`,
		fix: `npm install ${o.packageName}`,
	}
}

/**
 * Observation of the configured data root.
 */
export interface DataRootObservation {
	/**
	 * Resolved data-root path.
	 */
	path: string
	exists: boolean
	writable: boolean
	/**
	 * Whether the path came from `$MAILWOMAN_DATA_ROOT`.
	 */
	fromEnv: boolean
}

const DATA_ROOT_CONSEQUENCE =
	"This is where every downloadable layer lands. `mailwoman data pull` has nowhere to write, and any " +
	"database already installed elsewhere will not be found unless you point $MAILWOMAN_DATA_ROOT at it."

/**
 * Check the data root used by data commands.
 */
export function dataRootCheck(o: DataRootObservation): DoctorCheck {
	const base = { id: "data-root", label: "Data root", core: false }
	const source = o.fromEnv ? "$MAILWOMAN_DATA_ROOT" : "default"

	if (!o.exists) {
		return {
			...base,
			status: CheckStatus.Missing,
			detail: `${o.path} (${source}) does not exist`,
			consequence: DATA_ROOT_CONSEQUENCE,
			fix: `mkdir -p ${o.path}   (or set $MAILWOMAN_DATA_ROOT to an existing dir)`,
		}
	}

	if (!o.writable) {
		return {
			...base,
			status: CheckStatus.Degraded,
			detail: `${o.path} (${source}) exists but is not writable`,
			consequence: DATA_ROOT_CONSEQUENCE,
			fix: `chmod u+w ${o.path}   (or set $MAILWOMAN_DATA_ROOT to a writable dir)`,
		}
	}

	return { ...base, status: CheckStatus.OK, detail: `${o.path} (${source}) — exists, writable` }
}

/**
 * Observation of the admin gazetteer paths used by the resolver.
 */
export interface GazetteerObservation {
	/**
	 * Candidate database selected explicitly or through the environment.
	 */
	envCandidate?: { path: string; sizeBytes?: number }
	/**
	 * Candidate database at the default path.
	 */
	conventionCandidate?: string
	/**
	 * WOF admin database used when no candidate database is available.
	 */
	wofDatabase?: { path: string; sizeBytes?: number }
	/**
	 * Paths checked when no database is found.
	 */
	probed: string[]
}

/**
 * Check whether a gazetteer is available for geocoding.
 */
export function gazetteerCheck(o: GazetteerObservation): DoctorCheck {
	const base = { id: "gazetteer", label: "Admin gazetteer", core: false }

	if (o.envCandidate) {
		const size = o.envCandidate.sizeBytes ? ` (${ByteFormatter.formatSI(o.envCandidate.sizeBytes)})` : ""

		return { ...base, status: CheckStatus.OK, detail: `candidate.db · ${o.envCandidate.path}${size}` }
	}

	// Check the convention candidate path before WOF fallback databases.
	if (o.conventionCandidate) {
		return { ...base, status: CheckStatus.OK, detail: `candidate.db · ${o.conventionCandidate} (convention path)` }
	}

	if (o.wofDatabase) {
		const size = o.wofDatabase.sizeBytes ? ` (${ByteFormatter.formatSI(o.wofDatabase.sizeBytes)})` : ""

		return { ...base, status: CheckStatus.OK, detail: `WOF admin database · ${o.wofDatabase.path}${size}` }
	}

	return {
		...base,
		status: CheckStatus.Missing,
		detail: `no candidate.db or WOF database found (probed ${o.probed.length} path${o.probed.length === 1 ? "" : "s"})`,
		consequence:
			"Nothing can be turned into a coordinate. `mailwoman parse` still labels an address, but " +
			"`mailwoman geocode` has no gazetteer to look a place up in, so it errors instead of answering.",
		fix: `mailwoman data pull candidate`,
	}
}

/**
 * Layer identity and rights fields read from its manifest.
 */
export interface LayerIdentity {
	name: string
	version: string
	sourceVintage: string
	license: string
	attribution: string | null
}

export interface POIObservation {
	path: string
	exists: boolean
	/**
	 * Parsed manifest, when available.
	 */
	manifest?: LayerIdentity
	/**
	 * Manifest read error.
	 */
	error?: string
}

/**
 * Check whether the POI layer is available and readable.
 */
export function checkPOI(o: POIObservation): DoctorCheck {
	const base = { id: "poi-layer", label: "POI layer", core: false }
	const fix = "mailwoman gazetteer build poi   (or: mailwoman data pull poi)"

	const consequence =
		"A Point of Interest (POI) database is necessary to geocode businesses and landmarks. Without it a query " +
		"like 'blue bottle coffee, oakland' can only reach the locality, never the storefront."

	if (!o.exists) {
		return { ...base, status: CheckStatus.Missing, detail: `${o.path} not found`, consequence, fix }
	}

	if (!o.manifest) {
		return {
			...base,
			status: CheckStatus.Degraded,
			detail: `${o.path} present but the layer manifest is unreadable${o.error ? `: ${firstLine(o.error)}` : ""}`,
			consequence,
			fix,
		}
	}

	return {
		...base,
		status: CheckStatus.OK,
		detail: `${o.manifest.name} v${o.manifest.version} · vintage ${o.manifest.sourceVintage} · ${o.path}`,
	}
}

/**
 * Node runtime and package engine floor.
 */
export interface NodeRuntimeObservation {
	nodeVersion: string
	enginesFloor: string
}

/**
 * Check the Node version requirement.
 */
export function nodeVersionCheck(o: NodeRuntimeObservation): DoctorCheck {
	const base = { id: "node-version", label: "Node runtime", core: true }

	if (versionMeetsFloor(o.nodeVersion, o.enginesFloor)) {
		return { ...base, status: CheckStatus.OK, detail: `node v${o.nodeVersion} (engines: ${o.enginesFloor})` }
	}

	return {
		...base,
		status: CheckStatus.Degraded,
		detail: `node v${o.nodeVersion} is below the required ${o.enginesFloor}`,
		consequence:
			"Mailwoman ships TypeScript that node type-strips at run time. On an older runtime the CLI can fail " +
			"to start at all, and the failure reads as a syntax error in our source rather than as a version gap.",
		fix: `upgrade Node to satisfy ${o.enginesFloor}`,
	}
}

/**
 * ONNX runtime load status.
 */
export interface ONNXRuntimeObservation {
	loadable: boolean
	error?: string
}

/**
 * Check whether `onnxruntime-node` can load.
 */
export function onnxRuntimeCheck(o: ONNXRuntimeObservation): DoctorCheck {
	const base = { id: "onnxruntime", label: "ONNX runtime", core: true }

	if (o.loadable) {
		return { ...base, status: CheckStatus.OK, detail: "onnxruntime-node loadable" }
	}

	return {
		...base,
		status: CheckStatus.Degraded,
		detail: `onnxruntime-node failed to load${o.error ? `: ${firstLine(o.error)}` : ""}`,
		consequence:
			"This is the native binding that runs the model. Installed weights are unusable without it, so every " +
			"parse degrades to the structural pipeline no matter what else this report says is green.",
		fix: "npm install onnxruntime-node   (or reinstall @mailwoman/neural)",
	}
}

//#endregion

//#region License posture

export interface RuntimeLicenseObservation {
	/**
	 * Mailwoman license expression from the package manifest.
	 */
	expression: string
	/**
	 * Offline key verification, if a key is configured.
	 */
	key?: LicenseKeyVerification
	/**
	 * Publication status of the key ID, when available.
	 */
	publication?: LicenseKeyPublication
	/**
	 * Worker status for a self-service license, when available.
	 * This does not change the offline license branch.
	 */
	lidStatus?: LicenseStatusAnswer
}

/**
 * Report the applicable license branch and known obligations.
 * This informational check does not affect runtime behavior.
 */
export function runtimeLicenseCheck(o: RuntimeLicenseObservation): DoctorCheck {
	const base = { id: "license-mailwoman", label: "License (mailwoman)", core: false }
	const key = o.key
	const retired = o.publication === "retired" || o.publication === "unlisted"
	const commercial = key?.status === "valid" && !retired
	const applied = appliedLicenseBranch(o.expression, key, o.publication)
	const summary = summarizeLicense(applied)
	const obligations = `obligations: ${describeObligations(summary.obligations, summary.recognized)}`
	const lid = key && "payload" in key && isSelfServicePayload(key.payload) ? key.payload.lid : undefined

	const license: LicensePosture = {
		subject: "mailwoman",
		expression: o.expression,
		applied,
		obligations: summary.obligations,
		recognized: summary.recognized,
		...(key && "payload" in key ? { licensee: key.payload.licensee } : {}),
		...(key && "kid" in key ? { keyID: key.kid } : {}),
		...(key ? { keyStatus: retired && key.status === "valid" ? "retired" : key.status } : {}),
		...(lid ? { lid } : {}),
		...(o.lidStatus ? { lidStatus: o.lidStatus } : {}),
	}

	if (!key) {
		return {
			...base,
			status: CheckStatus.OK,
			detail: `${applied} — no license key configured, so the open-source branch applies · ${obligations}`,
			license,
		}
	}

	if (commercial && key.status === "valid") {
		const freshness =
			o.publication === "listed"
				? "key id confirmed by mailwoman.ai"
				: o.publication === "unreachable"
					? "mailwoman.ai unreachable, offline verification only"
					: o.publication === "unpublished"
						? "mailwoman.ai answers without a key register, offline verification only"
						: "verified offline"

		const expiry = key.payload.expires ? `expires ${key.payload.expires}` : "no expiry"

		// The worker's word about the license itself.
		// Revoked or lapsed is a degraded posture the offline token cannot see.
		// Unknown and unreachable are reported as what they are and change nothing.
		if (o.lidStatus === "revoked" || o.lidStatus === "lapsed") {
			return {
				...base,
				status: CheckStatus.Degraded,
				detail: `${applied} — license key for ${key.payload.licensee} (${key.kid}; ${expiry}); online this license is ${o.lidStatus} · ${obligations}`,
				consequence:
					`The key verifies offline until its date, so the runtime still applies the commercial branch; online, the license it names is ${o.lidStatus}. ` +
					`Manage billing at ${docsSiteURL()}/license.`,
				fix: "mailwoman license refresh",
				license,
			}
		}

		const standing =
			o.lidStatus === undefined
				? ""
				: o.lidStatus === "unreachable"
					? "; license status unreachable"
					: `; license ${o.lidStatus}`

		return {
			...base,
			status: CheckStatus.OK,
			detail: `${applied} — license key for ${key.payload.licensee} (${key.kid}; ${expiry}; ${freshness}${standing}) · ${obligations}`,
			license,
		}
	}

	const reason =
		key.status === "valid"
			? `key id ${key.kid} is no longer listed as active at mailwoman.ai, so it is treated as retired`
			: key.status === "expired"
				? `license key for ${key.payload.licensee} expired on ${key.payload.expires}`
				: key.reason

	return {
		...base,
		status: CheckStatus.Degraded,
		detail: `${applied} — ${reason}; the open-source branch applies · ${obligations}`,
		consequence:
			"A configured license key that does not verify leaves this installation under AGPL-3.0-only terms: attribution, share-alike on modifications, and a source offer to network users.",
		fix: "mailwoman license verify   (then request a current key from Sister Software)",
		license,
	}
}

export interface LayerLicenseObservation {
	id: string
	label: string
	path: string
	/**
	 * The manifest fields the doctor reads, or absent when the manifest could not be read.
	 */
	manifest?: LayerIdentity
	error?: string
	/**
	 * Other `.db` files in the layer's directory when the attached file itself is absent.
	 *
	 * The artifact built under a name the session does not look for.
	 */
	alternates?: string[]
}

/**
 * What one attached layer database's recorded license asks of the operator.
 *
 * The expression comes from the layer's own `layer_manifest`, never from a table in code,
 * so a layer that records `noassertion` or a vendor-suffixed identifier is
 * reported as unrecognized rather than guessed at.
 * Informational, never core.
 */
export function layerLicenseCheck(o: LayerLicenseObservation): DoctorCheck {
	const base = { id: `license-${o.id}`, label: `License (${o.label})`, core: false }

	if (o.alternates?.length) {
		return {
			...base,
			status: CheckStatus.Degraded,
			detail: `${o.path} is absent, but ${o.alternates.join(", ")} sits beside where it would be — a build under another name`,
			consequence:
				"The session attaches nothing for this layer, so every answer reads as if no such data existed. Rename or rebuild the artifact to the attached filename, or point the build's --out at it.",
		}
	}

	if (!o.manifest) {
		return {
			...base,
			status: CheckStatus.Degraded,
			detail: `${o.path} present but its layer manifest is unreadable${o.error ? `: ${firstLine(o.error)}` : ""}`,
			consequence: "Without the manifest the doctor cannot say which license this data carries or what it asks of you.",
		}
	}

	const summary = summarizeLicense(o.manifest.license)

	const license: LicensePosture = {
		subject: o.id,
		expression: o.manifest.license,
		applied: o.manifest.license,
		obligations: summary.obligations,
		recognized: summary.recognized,
		...(o.manifest.attribution ? { attribution: o.manifest.attribution } : {}),
	}

	if (!summary.recognized) {
		return {
			...base,
			status: CheckStatus.Degraded,
			detail: `${o.manifest.name} records license ${stringifyJSON(o.manifest.license)}, which the doctor does not recognize`,
			consequence:
				"An unrecognized license expression carries obligations the doctor cannot summarize. Read the source's own terms before redistributing results derived from this layer.",
			license,
		}
	}

	return {
		...base,
		status: CheckStatus.OK,
		detail: `${o.manifest.name} · ${o.manifest.license} · obligations: ${describeObligations(summary.obligations, true)}`,
		license,
	}
}

function describeObligations(obligations: readonly LicenseObligation[], recognized: boolean): string {
	if (!recognized) return "unrecognized license"

	return obligations.length ? obligations.join(", ") : "none"
}

//#endregion

//#region Aggregate

/**
 * Derive the process exit code: `0` when every core check is `ok`, else `1`.
 *
 * Optional data-layer checks report their gaps but never fail the process.
 * The meaning-of-zero rule (a missing optional layer is not a hard error).
 */
export function computeExitCode(checks: readonly DoctorCheck[]): number {
	return checks.some((c) => c.core && c.status !== CheckStatus.OK) ? 1 : 0
}

/**
 * Assemble the report + exit code from the ordered checks.
 */
export function assembleReport(checks: DoctorCheck[]): DoctorReport {
	return { checks, exitCode: computeExitCode(checks) }
}

/**
 * First line of a possibly-multiline error/stack, trimmed — keeps the checklist to one line per check.
 */
function firstLine(message: string): string {
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- An in-memory error message, and the limit argument stops after the first segment.
	return message.split("\n", 1)[0]!.trim()
}

//#endregion
