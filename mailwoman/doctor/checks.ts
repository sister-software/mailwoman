/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure decision logic for `mailwoman doctor` — the out-of-box diagnostic. Each `*Check` function
 *   takes a plain OBSERVATION object (facts already gathered from the filesystem/runtime by
 *   {@link ../doctor/runner.ts}) and returns a {@link DoctorCheck}. Keeping the verdict logic pure —
 *   no `fs`, no `import`, no env — is what makes it unit-testable without rendering Ink or standing up
 *   a data root: the runner injects the IO seams, this module owns only the ok/missing/degraded call.
 *
 *   Meaning-of-zero discipline (memory: feedback-meaning-of-zero): a missing OPTIONAL layer reports as
 *   `missing`/`degraded` with a fix hint, never as a hard error. Only the CORE checks (weights +
 *   runtime) drive the process exit code — parse works without a data root, gazetteer, or POI layer.
 */

/** A check's outcome. `ok` = works; `missing` = absent but fixable; `degraded` = present but impaired. */
export const CheckStatus = {
	OK: "ok",
	Missing: "missing",
	Degraded: "degraded",
} as const

export type CheckStatus = (typeof CheckStatus)[keyof typeof CheckStatus]

/** One diagnostic line: a stable `id`, its `status`, a human `detail`, and (when not ok) the one command that fixes it. */
export interface DoctorCheck {
	id: string
	/** Human-facing label for the check (rendered in the checklist). */
	label: string
	status: CheckStatus
	detail: string
	/** The single command/URL that closes the gap. Present whenever `status !== "ok"`. */
	fix?: string
	/**
	 * Whether this check gates the exit code. Core checks (weights + runtime) must be `ok` for a `0` exit; optional
	 * data-layer checks report their gap but never fail the process (parse runs without them).
	 */
	core: boolean
}

/** The full diagnostic report — the checklist plus the derived exit code. */
export interface DoctorReport {
	checks: DoctorCheck[]
	exitCode: number
}

/** A parsed `<major>.<minor>.<patch>` triple. */
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

/** Parse a bare `<major>.<minor>.<patch>` runtime version (e.g. `process.versions.node`). `undefined` if unparseable. */
export function parseVersion(version: string): SemverTriple | undefined {
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)/u)

	if (!match) return undefined

	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/** `true` when `version` is at least `floor` under lexicographic major→minor→patch comparison. */
export function versionMeetsFloor(version: string, floor: string): boolean {
	const v = parseVersion(version)
	const f = parseVersionFloor(floor)

	if (!v || !f) return false

	if (v.major !== f.major) return v.major > f.major

	if (v.minor !== f.minor) return v.minor > f.minor

	return v.patch >= f.patch
}

/** Bytes → a compact `12.3 MB` / `640 KB` / `12 B` string. */
export function formatBytes(bytes: number): string {
	if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`

	if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`

	return `${bytes} B`
}

// ---------------------------------------------------------------------------
// Observations (facts the runner gathers) → checks (verdicts)
// ---------------------------------------------------------------------------

/** Facts about the `@mailwoman/neural-weights-en-us` resolution. */
export interface WeightsObservation {
	/** Resolved paths + source tag, or absent when resolution threw. */
	resolved?: { source: string; modelPath: string; tokenizerPath: string }
	/** Byte size of the resolved `model.onnx` (undefined if unresolved/unstattable). */
	modelSize?: number
	/** Byte size of the resolved `tokenizer.model`. */
	tokenizerSize?: number
	/** The resolution error message, when resolution failed. */
	error?: string
}

const WEIGHTS_FIX = "npm install @mailwoman/neural-weights-en-us   (or: mailwoman parse --download-weights)"

/** Check #1 — the trained model bundle. CORE: parse cannot run without it. */
export function weightsCheck(o: WeightsObservation): DoctorCheck {
	const base = { id: "weights", label: "Model weights (en-us)", core: true }

	if (!o.resolved) {
		return {
			...base,
			status: CheckStatus.Missing,
			detail: o.error ? firstLine(o.error) : "@mailwoman/neural-weights-en-us is not resolvable",
			fix: WEIGHTS_FIX,
		}
	}

	if (!o.modelSize || !o.tokenizerSize) {
		return {
			...base,
			status: CheckStatus.Degraded,
			detail: `resolved (${o.resolved.source}) but a weight file is empty — model.onnx ${formatBytes(o.modelSize ?? 0)}, tokenizer.model ${formatBytes(o.tokenizerSize ?? 0)}`,
			fix: WEIGHTS_FIX,
		}
	}

	return {
		...base,
		status: CheckStatus.OK,
		detail: `${o.resolved.source} · model.onnx ${formatBytes(o.modelSize)}, tokenizer.model ${formatBytes(o.tokenizerSize)}`,
	}
}

/** Facts about an optional locale-overlay weights package (e.g. fr-fr). */
export interface LocaleOverlayObservation {
	locale: string
	packageName: string
	resolved: boolean
	source?: string
}

/** Check #2 — a locale overlay (fr-fr). Informational (never core): its absence is expected on an en-us-only install. */
export function localeOverlayCheck(o: LocaleOverlayObservation): DoctorCheck {
	const base = { id: `locale-overlay-${o.locale}`, label: `Locale overlay (${o.locale})`, core: false }

	if (o.resolved) {
		return { ...base, status: CheckStatus.OK, detail: `${o.packageName} resolvable${o.source ? ` (${o.source})` : ""}` }
	}

	return {
		...base,
		status: CheckStatus.Missing,
		detail: `${o.packageName} not installed (optional — only needed for ${o.locale} parsing)`,
		fix: `npm install ${o.packageName}`,
	}
}

/** Facts about the resolved data root. */
export interface DataRootObservation {
	/** The path from the blessed `@mailwoman/core/utils` helper — never re-derived here. */
	path: string
	exists: boolean
	writable: boolean
	/** Whether `$MAILWOMAN_DATA_ROOT` was set (vs. the built-in default). */
	fromEnv: boolean
}

/** Check #3 — the data root. Optional: an unwritable/absent root only blocks build tooling, not parse. */
export function dataRootCheck(o: DataRootObservation): DoctorCheck {
	const base = { id: "data-root", label: "Data root", core: false }
	const source = o.fromEnv ? "$MAILWOMAN_DATA_ROOT" : "default"

	if (!o.exists) {
		return {
			...base,
			status: CheckStatus.Missing,
			detail: `${o.path} (${source}) does not exist`,
			fix: `mkdir -p ${o.path}   (or set $MAILWOMAN_DATA_ROOT to an existing dir)`,
		}
	}

	if (!o.writable) {
		return {
			...base,
			status: CheckStatus.Degraded,
			detail: `${o.path} (${source}) exists but is not writable`,
			fix: `chmod u+w ${o.path}   (or set $MAILWOMAN_DATA_ROOT to a writable dir)`,
		}
	}

	return { ...base, status: CheckStatus.OK, detail: `${o.path} (${source}) — exists, writable` }
}

/**
 * Facts about the admin gazetteer discovery, mirroring exactly what the TOOLS pick up. `mailwoman geocode` / `serve`
 * resolve a candidate.db ONLY through `resolveCandidateDBPath` (explicit ?? `$MAILWOMAN_CANDIDATE_DB`) — there is no
 * convention-path fallback — else they fall back to the WOF FTS shards. So a candidate.db sitting at the
 * `<data-root>/wof/candidate.db` convention path while the env is UNSET is a TRAP: on disk, but the tools won't touch
 * it.
 */
export interface GazetteerObservation {
	/** A candidate.db the tools would actually use — explicit/`$MAILWOMAN_CANDIDATE_DB`, on disk. Green. */
	envCandidate?: { path: string; sizeBytes?: number }
	/** A WOF admin shard on disk — the FTS backend the tools fall back to when no env candidate is set. Green. */
	wofShard?: { path: string; sizeBytes?: number }
	/** A candidate.db at the convention path while `$MAILWOMAN_CANDIDATE_DB` is UNSET — the trap. Degraded, not green. */
	conventionCandidate?: string
	/** The paths probed, for the not-found detail. */
	probed: string[]
}

const CANDIDATE_URL = "https://public.sister.software/mailwoman/gazetteer/2026-07-07a/candidate.db"

/** Check #4 — the admin gazetteer. Optional: parse runs without it; only geocode/resolve need it. */
export function gazetteerCheck(o: GazetteerObservation): DoctorCheck {
	const base = { id: "gazetteer", label: "Admin gazetteer", core: false }

	if (o.envCandidate) {
		const size = o.envCandidate.sizeBytes ? ` (${formatBytes(o.envCandidate.sizeBytes)})` : ""

		return { ...base, status: CheckStatus.OK, detail: `candidate.db · ${o.envCandidate.path}${size}` }
	}

	if (o.wofShard) {
		const size = o.wofShard.sizeBytes ? ` (${formatBytes(o.wofShard.sizeBytes)})` : ""

		return { ...base, status: CheckStatus.OK, detail: `WOF admin shard · ${o.wofShard.path}${size}` }
	}

	// The trap: candidate.db is on disk at the convention path, but the tools resolve candidate only via the env — so
	// they'd report "no gazetteer data found" while doctor could naively show green. Report degraded, not ok.
	if (o.conventionCandidate) {
		return {
			...base,
			status: CheckStatus.Degraded,
			detail: `candidate.db on disk (${o.conventionCandidate}) but $MAILWOMAN_CANDIDATE_DB unset — geocode/serve won't use it`,
			fix: `export MAILWOMAN_CANDIDATE_DB=${o.conventionCandidate}`,
		}
	}

	return {
		...base,
		status: CheckStatus.Missing,
		detail: `no candidate.db or WOF shard found (probed ${o.probed.length} path${o.probed.length === 1 ? "" : "s"})`,
		fix: `curl -fSL ${CANDIDATE_URL} -o <data-root>/wof/candidate.db   (then: export MAILWOMAN_CANDIDATE_DB=<data-root>/wof/candidate.db)`,
	}
}

/** Facts about the POI layer (mirrors `gazetteer build poi`'s default output path). */
export interface POIObservation {
	path: string
	exists: boolean
	/** The parsed layer manifest, when the db opened and validated. */
	manifest?: { name: string; version: string; sourceVintage: string }
	/** A read error, when the db exists but the manifest couldn't be read. */
	error?: string
}

const POI_URL = "https://public.sister.software/mailwoman/poi/2026-07-20a/poi.db"

/** Check #5 — the POI layer. Optional: only POI-query execution needs it. */
export function checkPOI(o: POIObservation): DoctorCheck {
	const base = { id: "poi-layer", label: "POI layer", core: false }
	const fix = `mailwoman gazetteer build poi   (or: curl -fSL ${POI_URL} -o ${o.path})`

	if (!o.exists) {
		return { ...base, status: CheckStatus.Missing, detail: `${o.path} not found`, fix }
	}

	if (!o.manifest) {
		return {
			...base,
			status: CheckStatus.Degraded,
			detail: `${o.path} present but the layer manifest is unreadable${o.error ? `: ${firstLine(o.error)}` : ""}`,
			fix,
		}
	}

	return {
		...base,
		status: CheckStatus.OK,
		detail: `${o.manifest.name} v${o.manifest.version} · vintage ${o.manifest.sourceVintage} · ${o.path}`,
	}
}

/** Facts about the Node runtime version vs. the package `engines` floor. */
export interface NodeRuntimeObservation {
	nodeVersion: string
	enginesFloor: string
}

/** Check #6a — the Node version floor. CORE. */
export function nodeVersionCheck(o: NodeRuntimeObservation): DoctorCheck {
	const base = { id: "node-version", label: "Node runtime", core: true }

	if (versionMeetsFloor(o.nodeVersion, o.enginesFloor)) {
		return { ...base, status: CheckStatus.OK, detail: `node v${o.nodeVersion} (engines: ${o.enginesFloor})` }
	}

	return {
		...base,
		status: CheckStatus.Degraded,
		detail: `node v${o.nodeVersion} is below the required ${o.enginesFloor}`,
		fix: `upgrade Node to satisfy ${o.enginesFloor}`,
	}
}

/** Facts about the ONNX runtime binding. */
export interface OnnxRuntimeObservation {
	loadable: boolean
	error?: string
}

/** Check #6b — onnxruntime-node loadability. CORE: the neural runtime cannot infer without it. */
export function onnxRuntimeCheck(o: OnnxRuntimeObservation): DoctorCheck {
	const base = { id: "onnxruntime", label: "ONNX runtime", core: true }

	if (o.loadable) {
		return { ...base, status: CheckStatus.OK, detail: "onnxruntime-node loadable" }
	}

	return {
		...base,
		status: CheckStatus.Degraded,
		detail: `onnxruntime-node failed to load${o.error ? `: ${firstLine(o.error)}` : ""}`,
		fix: "npm install onnxruntime-node   (or reinstall @mailwoman/neural)",
	}
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

/**
 * Derive the process exit code: `0` when every CORE check is `ok`, else `1`. Optional data-layer checks report their
 * gaps but never fail the process — the meaning-of-zero rule (a missing optional layer is not a hard error).
 */
export function computeExitCode(checks: readonly DoctorCheck[]): number {
	return checks.some((c) => c.core && c.status !== CheckStatus.OK) ? 1 : 0
}

/** Assemble the report + exit code from the ordered checks. */
export function assembleReport(checks: DoctorCheck[]): DoctorReport {
	return { checks, exitCode: computeExitCode(checks) }
}

/** First line of a possibly-multiline error/stack, trimmed — keeps the checklist to one line per check. */
function firstLine(message: string): string {
	return message.split("\n", 1)[0]!.trim()
}
