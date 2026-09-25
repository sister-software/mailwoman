/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Classifies the observations that `mailwoman doctor` gathers into check verdicts.
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
 * Enumerates check outcomes: working, absent but fixable, or present but impaired.
 */
export const CheckStatus = {
	OK: "ok",
	Missing: "missing",
	Degraded: "degraded",
} as const

/**
 * Enumerates check outcomes: working, absent but fixable, or present but impaired.
 */
export type CheckStatus = (typeof CheckStatus)[keyof typeof CheckStatus]

/**
 * Holds one diagnostic result with its status, detail and optional fix.
 */
export interface DoctorCheck {
	id: string
	/**
	 * Holds the checklist label.
	 */
	label: string
	status: CheckStatus
	detail: string
	/**
	 * Explains the user-facing effect when the check is not `ok`.
	 */
	consequence?: string
	/**
	 * Holds a command or URL that fixes the problem.
	 */
	fix?: string
	/**
	 * Controls whether a non-`ok` result fails the process exit code.
	 */
	core: boolean
	/**
	 * Holds structured license details for a license check.
	 */
	license?: LicensePosture
}

/**
 * Describes the license terms that apply to Mailwoman or to one data layer.
 */
export interface LicensePosture {
	/**
	 * Identifies the licensed package or data layer.
	 */
	subject: string
	/**
	 * Holds the recorded SPDX expression.
	 */
	expression: string
	/**
	 * Holds the applicable branch of a dual license, or the expression itself.
	 */
	applied: string
	/**
	 * Lists the known obligations of the applicable branch.
	 */
	obligations: LicenseObligation[]
	recognized: boolean
	/**
	 * Holds the recorded attribution requirement.
	 */
	attribution?: string
	/**
	 * `licensee`, `keyID` and `keyStatus` describe the key for Mailwoman's own license.
	 */
	licensee?: string
	keyID?: string
	keyStatus?: "valid" | "expired" | "unknown_key" | "invalid" | "retired"
	/**
	 * `lid` and `lidStatus` hold the self-service license ID and its status from the license worker.
	 */
	lid?: string
	lidStatus?: LicenseStatusAnswer
}

/**
 * Holds the ordered checks and the exit code derived from them.
 */
export interface DoctorReport {
	checks: DoctorCheck[]
	exitCode: number
}

/**
 * Holds a parsed major, minor and patch version.
 */
export interface SemverTriple {
	major: number
	minor: number
	patch: number
}

/**
 * Parses the minimum version from an `engines.node` range.
 * A missing minor or patch defaults to zero.
 */
export function parseVersionFloor(engines: string): SemverTriple | undefined {
	const match = engines.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/u)

	if (!match) return undefined

	return { major: Number(match[1]), minor: Number(match[2] ?? 0), patch: Number(match[3] ?? 0) }
}

/**
 * Parses a runtime version in `major.minor.patch` form.
 */
export function parseVersion(version: string): SemverTriple | undefined {
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)/u)

	if (!match) return undefined

	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * Reports whether a version meets the floor of an `engines.node` range.
 */
export function versionMeetsFloor(version: string, floor: string): boolean {
	const v = parseVersion(version)
	const f = parseVersionFloor(floor)

	if (!v || !f) return false

	if (v.major !== f.major) return v.major > f.major

	if (v.minor !== f.minor) return v.minor > f.minor

	return v.patch >= f.patch
}

// #region Observations to checks

/**
 * Records how `@mailwoman/neural-weights-en-us` resolved.
 */
export interface WeightsObservation {
	/**
	 * Holds the resolved paths and source.
	 * It is absent when resolution failed.
	 */
	resolved?: { source: string; modelPath: string; tokenizerPath: string }
	/**
	 * Holds the model file size in bytes.
	 */
	modelSize?: number
	/**
	 * Holds the tokenizer file size in bytes.
	 */
	tokenizerSize?: number
	/**
	 * Holds the resolution error.
	 */
	error?: string
}

const WEIGHTS_FIX = "npm install @mailwoman/neural-weights-en-us   (or: mailwoman parse --download-weights)"

const WEIGHTS_CONSEQUENCE =
	"The trained model is what reads an address. Without it every parse falls back to the structural " +
	"pipeline, which can only recognise shapes it is certain of (a bare postcode, a bare locality) and " +
	"leaves the rest of the address unlabelled."

/**
 * Checks that the required en-us model weights resolve and are not empty.
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
 * Records whether an optional locale overlay package resolved.
 */
export interface LocaleOverlayObservation {
	locale: string
	packageName: string
	resolved: boolean
	source?: string
}

/**
 * Checks an optional locale overlay.
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
 * Records the state of the configured data root.
 */
export interface DataRootObservation {
	/**
	 * Holds the resolved data-root path.
	 */
	path: string
	exists: boolean
	writable: boolean
	/**
	 * Reports whether the path came from `$MAILWOMAN_DATA_ROOT`.
	 */
	fromEnv: boolean
}

const DATA_ROOT_CONSEQUENCE =
	"This is where every downloadable layer lands. `mailwoman data pull` has nowhere to write, and any " +
	"database already installed elsewhere will not be found unless you point $MAILWOMAN_DATA_ROOT at it."

/**
 * Checks that the data root exists and is writable.
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
 * Records which admin gazetteer databases the resolver can find.
 */
export interface GazetteerObservation {
	/**
	 * Holds the candidate database selected explicitly or through the environment.
	 */
	envCandidate?: { path: string; sizeBytes?: number }
	/**
	 * Holds the candidate database found at the default path.
	 */
	conventionCandidate?: string
	/**
	 * Holds the WOF admin database used when no candidate database exists.
	 */
	wofDatabase?: { path: string; sizeBytes?: number }
	/**
	 * Lists the paths probed, for the report when no database is found.
	 */
	probed: string[]
}

/**
 * Checks whether a gazetteer is available for geocoding, in the resolver's order of preference.
 */
export function gazetteerCheck(o: GazetteerObservation): DoctorCheck {
	const base = { id: "gazetteer", label: "Admin gazetteer", core: false }

	if (o.envCandidate) {
		const size = o.envCandidate.sizeBytes ? ` (${ByteFormatter.formatSI(o.envCandidate.sizeBytes)})` : ""

		return { ...base, status: CheckStatus.OK, detail: `candidate.db · ${o.envCandidate.path}${size}` }
	}

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
 * Holds the identity and rights fields read from a layer manifest.
 */
export interface LayerIdentity {
	name: string
	version: string
	sourceVintage: string
	license: string
	attribution: string | null
}

/**
 * Records whether the POI layer exists and whether its manifest could be read.
 */
export interface POIObservation {
	path: string
	exists: boolean
	/**
	 * Holds the parsed manifest when it could be read.
	 */
	manifest?: LayerIdentity
	/**
	 * Holds the manifest read error.
	 */
	error?: string
}

/**
 * Checks whether the POI layer is present and its manifest is readable.
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
 * Records the running Node version and the package's `engines.node` range.
 */
export interface NodeRuntimeObservation {
	nodeVersion: string
	enginesFloor: string
}

/**
 * Checks that the running Node version meets the `engines.node` floor.
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
 * Records whether `onnxruntime-node` loaded.
 */
export interface ONNXRuntimeObservation {
	loadable: boolean
	error?: string
}

/**
 * Checks whether `onnxruntime-node` can load.
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

// #endregion

// #region License posture

/**
 * Records the inputs that decide which branch of Mailwoman's own license applies.
 */
export interface RuntimeLicenseObservation {
	/**
	 * Holds the license expression from the package manifest.
	 */
	expression: string
	/**
	 * Holds the offline key verification when a key is configured.
	 */
	key?: LicenseKeyVerification
	/**
	 * Holds the key ID's publication status when it is known.
	 */
	publication?: LicenseKeyPublication
	/**
	 * Holds the license worker's status for a self-service license.
	 *
	 * This status does not change the offline license branch.
	 */
	lidStatus?: LicenseStatusAnswer
}

/**
 * Reports which branch of Mailwoman's license applies and its known obligations.
 *
 * The check is informational and does not change runtime behavior.
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

		// The offline token cannot show a revoked or lapsed license, so the worker's status degrades the check.
		// Any other worker status is reported without changing the verdict.
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

/**
 * Records one attached layer database and its manifest.
 */
export interface LayerLicenseObservation {
	id: string
	label: string
	path: string
	/**
	 * Holds the manifest fields, or is absent when the manifest could not be read.
	 */
	manifest?: LayerIdentity
	error?: string
	/**
	 * Lists other `.db` files in the layer's directory when the expected file is absent.
	 *
	 * These usually come from a build written under a name the session does not attach.
	 */
	alternates?: string[]
}

/**
 * Reports the license an attached layer database records and its known obligations.
 *
 * The expression comes from the layer's own `layer_manifest`, so an unfamiliar
 * identifier is reported as unrecognized instead of guessed.
 * The check is informational and never core.
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

/**
 * Formats obligations as a comma-separated list for a check detail.
 */
function describeObligations(obligations: readonly LicenseObligation[], recognized: boolean): string {
	if (!recognized) return "unrecognized license"

	return obligations.length ? obligations.join(", ") : "none"
}

// #endregion

// #region Aggregate

/**
 * Returns `0` when every core check is `ok`, and `1` otherwise.
 *
 * Non-core checks, such as optional data layers, report gaps without failing the process.
 */
export function computeExitCode(checks: readonly DoctorCheck[]): number {
	return checks.some((c) => c.core && c.status !== CheckStatus.OK) ? 1 : 0
}

/**
 * Builds the report and its exit code from the ordered checks.
 */
export function assembleReport(checks: DoctorCheck[]): DoctorReport {
	return { checks, exitCode: computeExitCode(checks) }
}

/**
 * Returns the trimmed first line of an error message so each check stays on one line.
 */
function firstLine(message: string): string {
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- An in-memory error message, and the limit argument stops after the first segment.
	return message.split("\n", 1)[0]!.trim()
}

// #endregion
