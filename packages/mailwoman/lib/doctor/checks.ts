/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure decision logic for `mailwoman doctor` — the out-of-box diagnostic. Each `*Check` function
 *   takes a plain OBSERVATION object (facts already gathered from the filesystem/runtime by
 *   {@link ../doctor/runner.ts}) and returns a {@link DoctorCheck}. Keeping the verdict logic pure —
 *   no IO, no env — is what makes it unit-testable without rendering Ink or standing up
 *   a data root: the runner injects the IO dependencies, this module owns only the ok/missing/degraded call.
 *
 *   Meaning-of-zero discipline (memory: feedback-meaning-of-zero): a missing OPTIONAL layer reports as
 *   `missing`/`degraded` with a fix hint, never as a hard error. Only the CORE checks (weights +
 *   runtime) drive the process exit code — parse works without a data root, gazetteer, or POI layer.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import {
	chooseLicenseBranch,
	summarizeLicense,
	type LicenseKeyPublication,
	type LicenseKeyVerification,
	type LicenseObligation,
} from "@mailwoman/core/license"

/**
 * A check's outcome. `ok` = works; `missing` = absent but fixable; `degraded` = present but impaired.
 */
export const CheckStatus = {
	OK: "ok",
	Missing: "missing",
	Degraded: "degraded",
} as const

export type CheckStatus = (typeof CheckStatus)[keyof typeof CheckStatus]

/**
 * One diagnostic line: a stable `id`, its `status`, a human `detail`, and (when not ok) the one command that fixes it.
 */
export interface DoctorCheck {
	id: string
	/**
	 * Human-facing label for the check (rendered in the checklist).
	 */
	label: string
	status: CheckStatus
	detail: string
	/**
	 * What the reader LOSES while this check is not ok, in product terms ("geocode can only place you in the city, not on
	 * the street"), not implementation terms. Present whenever `status !== "ok"` (#1577).
	 *
	 * A red line and a fix command say what to type; they never say whether typing it matters to the thing the reader was
	 * actually trying to do. Every optional layer here is genuinely optional for SOMEONE, so a bare ✗ next to "POI layer"
	 * is unreadable without knowing that the POI layer is what makes "coffee near me" resolve at all.
	 */
	consequence?: string
	/**
	 * The single command/URL that closes the gap. Present whenever `status !== "ok"`.
	 */
	fix?: string
	/**
	 * Whether this check checks the exit code. Core checks (weights + runtime) must be `ok` for a `0` exit; optional
	 * data-layer checks report their gap but never fail the process (parse runs without them).
	 */
	core: boolean
	/**
	 * The license posture this check reports, when it is a license check: the expression as recorded, the branch that
	 * applies, and the responsibility classes it is known to carry. Structured so a JSON consumer reads the array rather
	 * than the sentence.
	 */
	license?: LicensePosture
}

/**
 * A license summary as the doctor reports it.
 */
export interface LicensePosture {
	/**
	 * What the posture describes: `mailwoman` itself, or a layer database by its layer id.
	 */
	subject: string
	/**
	 * The SPDX expression as recorded (a package's `license` field, or a layer manifest's `license` column).
	 */
	expression: string
	/**
	 * The branch of a dual license that applies here; equal to `expression` when there is one branch.
	 */
	applied: string
	/**
	 * The responsibility classes `applied` is known to carry. Empty with `recognized: true` means the license asks
	 * nothing of the operator; empty with `recognized: false` means the doctor does not know this identifier.
	 */
	obligations: LicenseObligation[]
	recognized: boolean
	/**
	 * The attribution line the source asks for, when the manifest records one.
	 */
	attribution?: string
	/**
	 * For mailwoman's own posture: the licensee a valid key names, its key id, and how the key read.
	 */
	licensee?: string
	keyID?: string
	keyStatus?: "valid" | "expired" | "unknown_key" | "invalid" | "retired"
}

/**
 * The full diagnostic report — the checklist plus the derived exit code.
 */
export interface DoctorReport {
	checks: DoctorCheck[]
	exitCode: number
}

/**
 * A parsed `<major>.<minor>.<patch>` triple.
 */
export interface SemverTriple {
	major: number
	minor: number
	patch: number
}

/**
 * Parse the minimum version out of a package.json `engines.node` range (`">=24.18.0"`, `"24.18.0"`, `">= 24"`). Returns
 * `undefined` when no `<major>[.<minor>[.<patch>]]` is findable. Only the floor matters for the doctor — a
 * caret/tilde/comparator prefix is stripped and missing minor/patch default to 0.
 */
export function parseVersionFloor(engines: string): SemverTriple | undefined {
	const match = engines.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/u)

	if (!match) return undefined

	return { major: Number(match[1]), minor: Number(match[2] ?? 0), patch: Number(match[3] ?? 0) }
}

/**
 * Parse a bare `<major>.<minor>.<patch>` runtime version (e.g. `process.versions.node`). `undefined` if unparseable.
 */
export function parseVersion(version: string): SemverTriple | undefined {
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)/u)

	if (!match) return undefined

	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * `true` when `version` is at least `floor` under lexicographic major→minor→patch comparison.
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
 * Facts about the `@mailwoman/neural-weights-en-us` resolution.
 */
export interface WeightsObservation {
	/**
	 * Resolved paths + source tag, or absent when resolution threw.
	 */
	resolved?: { source: string; modelPath: string; tokenizerPath: string }
	/**
	 * Byte size of the resolved `model.onnx` (undefined if unresolved/unstattable).
	 */
	modelSize?: number
	/**
	 * Byte size of the resolved `tokenizer.model`.
	 */
	tokenizerSize?: number
	/**
	 * The resolution error message, when resolution failed.
	 */
	error?: string
}

const WEIGHTS_FIX = "npm install @mailwoman/neural-weights-en-us   (or: mailwoman parse --download-weights)"

const WEIGHTS_CONSEQUENCE =
	"The trained model is what reads an address. Without it every parse falls back to the structural " +
	"pipeline, which can only recognise shapes it is certain of (a bare postcode, a bare locality) and " +
	"leaves the rest of the address unlabelled."

/**
 * Check #1 — the trained model bundle. CORE: parse cannot run without it.
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
 * Facts about an optional locale-overlay weights package (e.g. fr-fr).
 */
export interface LocaleOverlayObservation {
	locale: string
	packageName: string
	resolved: boolean
	source?: string
}

/**
 * Check #2 — a locale overlay (fr-fr). Informational (never core): its absence is expected on an en-us-only install.
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
 * Facts about the resolved data root.
 */
export interface DataRootObservation {
	/**
	 * The path from the blessed `@mailwoman/core/utils` helper — never re-derived here.
	 */
	path: string
	exists: boolean
	writable: boolean
	/**
	 * Whether `$MAILWOMAN_DATA_ROOT` was set (vs. the built-in default).
	 */
	fromEnv: boolean
}

const DATA_ROOT_CONSEQUENCE =
	"This is where every downloadable layer lands. `mailwoman data pull` has nowhere to write, and any " +
	"database already installed elsewhere will not be found unless you point $MAILWOMAN_DATA_ROOT at it."

/**
 * Check #3 — the data root. Optional: an unwritable/absent root only blocks build tooling, not parse.
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
 * Facts about the admin gazetteer discovery, mirroring exactly what the TOOLS pick up. `resolveCandidateDBPath` reads
 * an explicit option, then `$MAILWOMAN_CANDIDATE_DB`, then the `<data-root>/wof/candidate.db` convention path, and
 * falls back to the WOF FTS databases only when none of the three is on disk.
 */
export interface GazetteerObservation {
	/**
	 * A candidate.db the tools would use, from the explicit option or `$MAILWOMAN_CANDIDATE_DB`. Green.
	 */
	envCandidate?: { path: string; sizeBytes?: number }
	/**
	 * A candidate.db at the convention path, which the tools now pick up with nothing exported. Green.
	 *
	 * Reporting this as degraded would tell a reader to export a variable that changes nothing — `resolveCandidateDBPath`
	 * reaches the convention path on its own.
	 */
	conventionCandidate?: string
	/**
	 * A WOF admin database on disk — the FTS backend the tools fall back to when no candidate.db is reachable. Green.
	 */
	wofDatabase?: { path: string; sizeBytes?: number }
	/**
	 * The paths probed, for the not-found detail.
	 */
	probed: string[]
}

/**
 * Check #4 — the admin gazetteer. Optional: parse runs without it; only geocode/resolve need it.
 */
export function gazetteerCheck(o: GazetteerObservation): DoctorCheck {
	const base = { id: "gazetteer", label: "Admin gazetteer", core: false }

	if (o.envCandidate) {
		const size = o.envCandidate.sizeBytes ? ` (${ByteFormatter.formatSI(o.envCandidate.sizeBytes)})` : ""

		return { ...base, status: CheckStatus.OK, detail: `candidate.db · ${o.envCandidate.path}${size}` }
	}

	// Ahead of the WOF database, because that is the precedence `resolveCandidateDBPath` applies: a convention-path
	// candidate.db wins over the FTS fallback, so reporting the database here would name a backend the tools won't use.
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
 * Facts about the POI layer (mirrors `gazetteer build poi`'s default output path).
 */
export interface POIObservation {
	path: string
	exists: boolean
	/**
	 * The parsed layer manifest, when the db opened and validated.
	 */
	manifest?: { name: string; version: string; sourceVintage: string }
	/**
	 * A read error, when the db exists but the manifest couldn't be read.
	 */
	error?: string
}

/**
 * Check #5 — the POI layer. Optional: only POI-query execution needs it.
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
 * Facts about the Node runtime version vs. the package `engines` floor.
 */
export interface NodeRuntimeObservation {
	nodeVersion: string
	enginesFloor: string
}

/**
 * Check #6a — the Node version floor. CORE.
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
 * Facts about the ONNX runtime binding.
 */
export interface ONNXRuntimeObservation {
	loadable: boolean
	error?: string
}

/**
 * Check #6b — onnxruntime-node loadability. CORE: the neural runtime cannot infer without it.
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
	 * Mailwoman's own `license` expression, read from its package manifest.
	 */
	expression: string
	/**
	 * The configured license key as verified offline, or absent when none is configured.
	 */
	key?: LicenseKeyVerification
	/**
	 * What mailwoman.ai's well-known register said about the key id, when the doctor could ask.
	 */
	publication?: LicenseKeyPublication
}

/**
 * The license that governs THIS installation of mailwoman, and what it asks of the operator. Without a valid key the
 * AGPL-3.0-only branch applies, and the summary says so in the responsibility vocabulary: attribution, share-alike on
 * modifications, and a source offer to network users (section 13). A valid key selects the commercial branch; an
 * expired, unknown, invalid or retired key is reported with its reason and the open-source branch applies. The runtime
 * behaves the same either way — this check changes what is reported, never what runs. Informational, never core.
 */
export function runtimeLicenseCheck(o: RuntimeLicenseObservation): DoctorCheck {
	const base = { id: "license-mailwoman", label: "License (mailwoman)", core: false }
	const key = o.key
	const retired = o.publication === "retired" || o.publication === "unlisted"
	const commercial = key?.status === "valid" && !retired
	const applied = chooseLicenseBranch(o.expression, { commercialAgreement: commercial })
	const summary = summarizeLicense(applied)
	const obligations = `obligations: ${describeObligations(summary.obligations, summary.recognized)}`

	const license: LicensePosture = {
		subject: "mailwoman",
		expression: o.expression,
		applied,
		obligations: summary.obligations,
		recognized: summary.recognized,
		...(key && "payload" in key ? { licensee: key.payload.licensee } : {}),
		...(key && "kid" in key ? { keyID: key.kid } : {}),
		...(key ? { keyStatus: retired && key.status === "valid" ? "retired" : key.status } : {}),
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
					: "verified offline"

		const expiry = key.payload.expires ? `expires ${key.payload.expires}` : "no expiry"

		return {
			...base,
			status: CheckStatus.OK,
			detail: `${applied} — license key for ${key.payload.licensee} (${key.kid}; ${expiry}; ${freshness}) · ${obligations}`,
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
	manifest?: { name: string; license: string; attribution: string | null }
	error?: string
}

/**
 * What one attached layer database's recorded license asks of the operator. The expression comes from the layer's own
 * `layer_manifest`, never from a table in code, so a layer that records `NOASSERTION` or a vendor-suffixed identifier
 * is reported as unrecognized rather than guessed at. Informational, never core.
 */
export function layerLicenseCheck(o: LayerLicenseObservation): DoctorCheck {
	const base = { id: `license-${o.id}`, label: `License (${o.label})`, core: false }

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
			detail: `${o.manifest.name} records license ${JSON.stringify(o.manifest.license)}, which the doctor does not recognize`,
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
 * Derive the process exit code: `0` when every CORE check is `ok`, else `1`. Optional data-layer checks report their
 * gaps but never fail the process — the meaning-of-zero rule (a missing optional layer is not a hard error).
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
