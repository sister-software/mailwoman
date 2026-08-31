/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Spinner } from "@inkjs/ui"
import type { AddressTree } from "@mailwoman/core/decoder"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { pathExists } from "@mailwoman/core/fs/readers"
import type { PolicyMode } from "@mailwoman/core/policy"
import type { ComponentTag, Section } from "@mailwoman/core/types"
import { percentile } from "@mailwoman/core/utils"
import type { NeuralAddressClassifier } from "@mailwoman/neural"
import { weightsPackageName } from "@mailwoman/neural/weights"
import type { Resolver } from "@mailwoman/resolver"
import type { FSTMatcher } from "@mailwoman/resolver-wof-sqlite/fst-matcher"
import { Text } from "ink"
import type React from "react"

import { CommandError, type CommandSpec, type ParsedCommandComponent, useCommandTask, writeRawStdout } from "#cli-kit"
import { WeightsGuard, type WeightsOutcome } from "#cli-kit/weights-guard"
import { resolverDefaultCountry } from "#country-scope"
import type { createRuntimePipeline } from "#index"

export { localeToCountry, resolverDefaultCountry } from "#country-scope"
export type { CountryScope } from "#country-scope"

/**
 * Bytes per KiB, for human-readable sizes.
 */

const POLICY_MODES: readonly PolicyMode[] = ["rule_only", "neural_only", "both", "neural_preferred", "rule_preferred"]
const POLICY_SPEC_RE = /^([a-z_]+)=([a-z_]+)$/u

/**
 * Shown at the top of `mailwoman parse --help`. The one thing it has to settle is parse-vs-geocode (#1577): the two
 * commands take the same argument and the difference is invisible until you have run both.
 *
 * Keep this short enough to draw the parse/geocode line without swamping command help.
 */
export const description =
	"Label the parts of an address — house number, street, locality, postcode — without looking anything up: the " +
	"output is your input, segmented and tagged. `mailwoman geocode` runs this same parse, then resolves those " +
	"parts against the gazetteer to produce a coordinate."

const boundedInteger =
	(maximum: number) =>
	(value: number): boolean =>
		Number.isInteger(value) && value >= 1 && value <= maximum

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "parse",
	description,
	positionals: [{ name: "address", required: true, multiple: true, description: "Formatted postal address" }],
	options: {
		debug: { type: "boolean", default: false, description: "Enable verbose output" },
		"input-mode": { type: "string", choices: ["fragmented", "formatted"], description: "Input register" },
		locale: {
			type: "string",
			default: "en-US",
			validate: (v: string) => /^[a-z]{2}(-[A-Z]{2})?$/u.test(v),
			description: "BCP-47 locale",
		},
		"default-country": { type: "string", description: "Resolver country scope" },
		"country-scope": {
			type: "string",
			choices: ["auto", "locale", "none"],
			default: "auto",
			description: "Locale country-scoping policy",
		},
		"admin-coherence": { type: "boolean", default: true, description: "Joint admin consistency" },
		"postcode-country-coherence": { type: "boolean", default: true, description: "Postcode country consistency" },
		"postcode-shape-coherence": { type: "boolean", default: false, description: "Postcode shape consistency" },
		"postcode-containment-coherence": {
			type: "boolean",
			default: false,
			description: "Postcode containment reranking",
		},
		neural: { type: "boolean", default: false, description: "Use neural-only path" },
		poi: { type: "boolean", default: true, description: "Enable POI query detection" },
		"download-weights": { type: "boolean", default: false, description: "Download missing weights" },
		degraded: { type: "boolean", default: false, description: "Run structural stages only" },
		format: { type: "string", choices: ["json", "tuple", "xml"], default: "json", description: "Output projection" },
		model: { type: "string", description: "Explicit model path" },
		tokenizer: { type: "string", description: "Explicit tokenizer path" },
		policy: {
			type: "string",
			multiple: true,
			validate: (v: string) => POLICY_SPEC_RE.test(v),
			description: "Repeatable component policy override",
		},
		resolve: { type: "boolean", default: false, description: "Resolve parsed nodes against WOF" },
		"resolve-db": { type: "string", description: "WOF SQLite distribution" },
		"street-evidence-rerank": { type: "boolean", default: true, description: "Rerank street from atlas evidence" },
		candidates: { type: "number", validate: boundedInteger(20), description: "Alternative resolutions per node" },
		benchmark: { type: "number", validate: boundedInteger(10_000), description: "Benchmark iteration count" },
	},
} as const satisfies CommandSpec

interface ParseOptions {
	debug: boolean
	inputMode?: "fragmented" | "formatted"
	locale: string
	defaultCountry?: string
	countryScope: "auto" | "locale" | "none"
	adminCoherence: boolean
	postcodeCountryCoherence: boolean
	postcodeShapeCoherence: boolean
	postcodeContainmentCoherence: boolean
	neural: boolean
	poi: boolean
	downloadWeights: boolean
	degraded: boolean
	format: "json" | "tuple" | "xml"
	model?: string
	tokenizer?: string
	policy?: string[]
	resolve: boolean
	resolveDB?: string
	streetEvidenceRerank: boolean
	candidates?: number
	benchmark?: number
}

interface PolicyOverride {
	component: ComponentTag
	mode: PolicyMode
}

function parsePolicySpecs(policySpecs: readonly string[]): PolicyOverride[] {
	const out: PolicyOverride[] = []

	for (const policySpec of policySpecs) {
		const m = POLICY_SPEC_RE.exec(policySpec)

		if (!m) throw new CommandError(`Invalid --policy spec ${policySpec}; expected <component>=<mode>`)
		const [, component, mode] = m

		if (!POLICY_MODES.includes(mode as PolicyMode)) {
			throw new CommandError(`Unknown policy mode ${mode}; valid: ${POLICY_MODES.join(", ")}`)
		}

		out.push({ component: component as ComponentTag, mode: mode as PolicyMode })
	}

	return out
}

const ParseCommand: ParsedCommandComponent<ParseOptions> = ({ options, args }) => {
	// The weights guard wraps the DEFAULT pipeline path only — explicit --model/--tokenizer paths and
	// the legacy/benchmark/degraded paths keep their existing loading semantics untouched (plan 3;
	// non-interactive absent-weights behavior stays byte-identical to pre-guard until plan 4).
	const guardEligible =
		options.benchmark === undefined &&
		!(options.policy && options.policy.length) &&
		!options.neural &&
		!options.model &&
		!options.tokenizer

	// The guard owns the probe now (it is async, so a render-time check is not possible); it settles
	// to the same "neural" path when weights resolve and nothing else was forced.
	if (guardEligible) {
		return (
			<WeightsGuard locale={options.locale} autoDownload={options.downloadWeights} forceDegraded={options.degraded}>
				{(outcome) => <ParseTask options={options} args={args} weightsOutcome={outcome} />}
			</WeightsGuard>
		)
	}

	return <ParseTask options={options} args={args} weightsOutcome="neural" />
}

/**
 * The actual parse work, one hook-owning component below the guard so the prompt can render first.
 */
function ParseTask({
	options,
	args,
	weightsOutcome,
}: {
	options: ParseOptions
	args: string[]
	weightsOutcome: WeightsOutcome
}): React.ReactElement | null {
	const state = useCommandTask(async () => {
		const input = args[0]!

		if (options.benchmark !== undefined) {
			if ((options.policy && options.policy.length) || options.neural) {
				throw new CommandError(
					"--benchmark requires the default runtime-pipeline path (incompatible with --policy / --neural)"
				)
			}

			return await runBenchmark(input, options, options.benchmark)
		}

		// --policy implies the neural proposal/policy path.
		if (options.policy && options.policy.length) {
			const policyOverrides = parsePolicySpecs(options.policy)

			return await runNeural(input, options, policyOverrides)
		}

		// --neural without --policy: legacy direct-neural path (kept for parity with old behavior).
		if (options.neural) {
			return await runNeural(input, options, [])
		}

		// Guard said degraded (user declined the download, download failed, or --degraded): the real
		// pipeline minus the encoder. "unavailable" falls through to runPipeline's legacy chain.
		if (weightsOutcome === "declined") {
			return runDegraded(input, options)
		}

		// Default: runtime pipeline.
		return runPipeline(input, options)
	})

	if (state.status === "error") {
		return <Text color="red">{state.message}</Text>
	}

	if (state.status !== "done") {
		return <Spinner />
	}

	// Every parse format (json/tuple/xml) is machine-readable — bypass Ink's word-wrapping
	// <Text> renderer, which corrupts long JSON lines at 80 cols when piped (see writeRawStdout).
	return writeRawStdout(state.result)
}

async function resolveWOFPath(options: ParseOptions): Promise<string> {
	const { $public } = await import("@mailwoman/core/env")
	const path = options.resolveDB ?? $public.MAILWOMAN_WOF_DB

	if (!path) {
		throw new CommandError(
			"--resolve needs a WOF SQLite path. Set $MAILWOMAN_WOF_DB or pass --resolve-db <path>. " +
				"Download from https://data.geocode.earth/wof/dist/sqlite/ and pre-build the FTS5 index " +
				"with `mailwoman gazetteer build fts <path>`."
		)
	}

	return path
}

async function tryBuildFST(options: ParseOptions): Promise<FSTMatcher | undefined> {
	const { $public } = await import("@mailwoman/core/env")
	const dbPath = options.resolveDB ?? $public.MAILWOMAN_WOF_DB

	if (!dbPath) return undefined

	try {
		if (!(await pathExists(dbPath))) return undefined
		const { buildFSTFromWOF } = await import("@mailwoman/resolver-wof-sqlite/fst-builder")
		const { matcher } = await buildFSTFromWOF({ dbPath })

		return matcher
	} catch {
		return undefined
	}
}

/**
 * Tree → resolved tree via the WOF backend. When `options.candidates` is set, asks the resolver for top-(N+1)
 * candidates per node so the runner-ups land on `AddressNode.alternatives` (where N is the requested alternative count;
 * +1 because the top winner is also in the limit).
 */
async function resolveWithCandidates(
	resolver: Resolver,
	tree: AddressTree,
	options: ParseOptions
): Promise<AddressTree> {
	const opts: {
		candidatesPerLookup?: number
		defaultCountry?: string
		adminCoherence?: boolean
		postcodeCountryCoherence?: boolean
		postcodeShapeCoherence?: boolean
		postcodeContainmentCoherence?: boolean
	} = {}

	if (options.candidates !== undefined) {
		opts.candidatesPerLookup = options.candidates + 1
	}

	// #42: the library default is ON since 2026-08-05; only the explicit --no-postcode-country-coherence
	// pin needs threading.
	if (options.postcodeCountryCoherence === false) {
		opts.postcodeCountryCoherence = false
	}

	// #31 opt-in mechanisms: library defaults are OFF, so only the explicit opt-in needs threading.
	if (options.postcodeShapeCoherence === true) {
		opts.postcodeShapeCoherence = true
	}

	if (options.postcodeContainmentCoherence === true) {
		opts.postcodeContainmentCoherence = true
	}

	const { resolveCandidateDBPath } = await import("#resolver-backend")
	const dc = resolverDefaultCountry(options, !!(await resolveCandidateDBPath()))

	if (dc) {
		opts.defaultCountry = dc
	}

	// #895: the library default is ON; only the explicit --no-admin-coherence pin needs threading.
	if (options.adminCoherence === false) {
		opts.adminCoherence = false
	}

	return resolver.resolveTree(tree, opts)
}

async function withResolver<T>(options: ParseOptions, fn: (resolver: Resolver) => Promise<T>): Promise<T> {
	const { createWOFResolver } = await import("@mailwoman/resolver")
	const { createResolverBackend, resolveCandidateDBPath } = await import("#resolver-backend")

	// Dynamic import so `@mailwoman/resolver-wof-sqlite` stays a true optional peer dep — users who
	// never set --resolve don't pay for kysely + the resolver bundle.
	let mod: typeof import("@mailwoman/resolver-wof-sqlite")

	try {
		mod = await import("@mailwoman/resolver-wof-sqlite")
	} catch {
		throw new CommandError(
			"--resolve requires `@mailwoman/resolver-wof-sqlite` to be installed. " +
				"Run `npm install @mailwoman/resolver-wof-sqlite` and try again."
		)
	}

	// $MAILWOMAN_CANDIDATE_DB → the demo-parity candidate backend (no WOF admin path required); else FTS.
	const lookup = await createResolverBackend(mod, {
		wofPaths: (await resolveCandidateDBPath()) ? "" : await resolveWOFPath(options),
	})

	try {
		// PlaceLookup is structurally compatible with ResolverBackend — the cast is just to satisfy
		// the type, no runtime conversion.
		const resolver = createWOFResolver(lookup)

		return await fn(resolver)
	} finally {
		lookup[Symbol.dispose]()
	}
}

async function serializeTree(
	tree: AddressTree,
	format: "json" | "tuple" | "xml",
	opts: { includeAlternatives?: boolean } = {}
): Promise<string> {
	const { decodeAsJSON, decodeAsTuples, decodeAsXML } = await import("@mailwoman/core/decoder")

	switch (format) {
		case "xml":
			return decodeAsXML(tree, { includeAlternatives: opts.includeAlternatives })
		case "tuple":
			return JSON.stringify(decodeAsTuples(tree), null, 2)
		default:
			// JSON: when --candidates is requested, dump the full AddressTree (carries alternatives
			// on each node). Otherwise stay libpostal-compat (flat tag→value).
			return opts.includeAlternatives ? JSON.stringify(tree, null, 2) : JSON.stringify(decodeAsJSON(tree), null, 2)
	}
}

/**
 * The generic degraded-mode banner (stderr — stdout stays machine-parseable). Emitted when the guard hands back a
 * `declined` outcome (interactive "n" / `--degraded` / a failed download) — the paths that never attempt an encoder
 * load, so `tryLoadNeural`'s precise absent-vs-load-error warning didn't fire. The attempted-and-failed case is
 * announced by `tryLoadNeural` instead (see #1108), so this banner is deliberately NOT emitted there (it would double
 * up).
 */
function emitDegradedBanner(options: ParseOptions): void {
	console.error(
		"⚠ degraded parse: the neural encoder is not loaded — output carries structural-pipeline results only.\n" +
			`  Upgrade: npm install ${weightsPackageName(options.locale)}   or   mailwoman parse --download-weights <address>`
	)
}

/**
 * #40 — announce every stage the coordinator degraded past. `runPipeline` catches a classifier / grouper / resolver
 * throw and keeps going (`PipelineResult.faults`), which used to mean a crashed model produced a tidy-looking parse
 * with nothing on stdout OR stderr to say so. Same `⚠` register as the encoder-load warnings above; stderr only, so
 * stdout stays the machine-readable parse.
 */
function emitFaultWarnings(result: { faults: ReadonlyArray<{ stage: string; name: string; message: string }> }): void {
	for (const fault of result.faults) {
		console.error(
			`⚠ degraded parse: the ${fault.stage} stage threw and the pipeline continued without it — ` +
				`${fault.name}: ${fault.message}`
		)
	}
}

/**
 * Encoder-less structural parse (plan 3), WITHOUT the banner: the REAL pipeline stages (normalize → query-shape →
 * locale-gate → kind → grouper fast-paths) with no neural classifier. The tree carries what the structural stages can
 * prove (postcode_only / locality_only fast-paths populate it; free-form addresses may yield an empty tree). The caller
 * owns the degraded notice — either {@link emitDegradedBanner} or the precise absent/load-error warning `tryLoadNeural`
 * already printed — so no path degrades silently, and none double-warns.
 */
async function runStructuralPipeline(input: string, options: ParseOptions): Promise<string> {
	const { createRuntimePipeline } = await import("#index")
	const pipeline = createRuntimePipeline({ poiQueryKind: options.poi })
	const result = await pipeline(input, { locale: options.locale })
	emitFaultWarnings(result)

	return options.debug
		? JSON.stringify(await serializeResult(result, options.format), null, 2)
		: await serializeTree(result.tree, options.format, { includeAlternatives: false })
}

/**
 * Structural parse fronted by the generic degraded banner — the guard's `declined` entry point (the caller here did NOT
 * attempt an encoder load, so it owns the notice).
 */
async function runDegraded(input: string, options: ParseOptions): Promise<string> {
	emitDegradedBanner(options)

	return runStructuralPipeline(input, options)
}

/**
 * Default path: runtime pipeline. Lazy-loads the neural classifier + optional resolver. Returns the parsed tree
 * serialized in the requested format. When the encoder is unavailable, degrades to the structural-pipeline stages
 * (normalize → query-shape → kind → grouper fast-paths) rather than any rules parser.
 */
async function runPipeline(input: string, options: ParseOptions): Promise<string> {
	// `tryLoadNeural` emits its own precise (absent vs. corrupt/load-error) stderr warning when the load
	// fails, so an attempted-but-failed encoder load is NEVER silent — including on the --resolve/--debug
	// paths, which don't route through the degraded banner below (#1108). Every route into this function
	// attempts the load: the deliberate skip is `--degraded`, which the guard answers with `declined`
	// before we get here (see ParseTask).
	const classifier = await tryLoadNeural(options)

	// When the encoder isn't loaded and there's no resolver/debug work to do, the full pipeline can only
	// emit QueryShape fast-path structure. Route to the structural path so the CLI still produces useful
	// output for the fast-path kinds (postcode_only, locality_only). `--debug` stays on the pipeline so
	// the operator gets the requested PipelineResult JSON shape.
	if (!classifier && !options.resolve && !options.debug) {
		// `tryLoadNeural` already emitted the precise warning, so the generic banner would double up.
		return runStructuralPipeline(input, options)
	}

	const wantAlternatives = options.candidates !== undefined

	const resolveOpts: {
		candidatesPerLookup?: number
		defaultCountry?: string
		postcodeCountryCoherence?: boolean
		postcodeShapeCoherence?: boolean
		postcodeContainmentCoherence?: boolean
	} = {}

	if (wantAlternatives) {
		resolveOpts.candidatesPerLookup = (options.candidates ?? 5) + 1
	}

	// #42 postcode-country coherence — only meaningful alongside --resolve's default country. Default-ON,
	// so only the explicit --no-postcode-country-coherence opt-out needs threading.
	if (options.resolve && options.postcodeCountryCoherence === false) {
		resolveOpts.postcodeCountryCoherence = false
	}

	// #31 opt-in mechanisms — default-OFF, so only the explicit opt-in needs threading.
	if (options.resolve && options.postcodeShapeCoherence === true) {
		resolveOpts.postcodeShapeCoherence = true
	}

	if (options.resolve && options.postcodeContainmentCoherence === true) {
		resolveOpts.postcodeContainmentCoherence = true
	}

	// Scope the resolver so a bare region abbreviation (`NY`) resolves to the intended country's place
	// rather than a higher-priority foreign homonym. Inferred from --locale unless --default-country
	// overrides (or is `none`). Only meaningful on the --resolve path; harmless otherwise.
	if (options.resolve) {
		const { resolveCandidateDBPath } = await import("#resolver-backend")
		const dc = resolverDefaultCountry(options, !!(await resolveCandidateDBPath()))

		if (dc) {
			resolveOpts.defaultCountry = dc
		}
	}

	const pipelineOpts: {
		locale?: string
		resolveOpts?: {
			candidatesPerLookup?: number
			defaultCountry?: string
			postcodeCountryCoherence?: boolean
			postcodeShapeCoherence?: boolean
			postcodeContainmentCoherence?: boolean
		}
	} = {
		locale: options.locale,
	}

	if (
		resolveOpts.candidatesPerLookup !== undefined ||
		resolveOpts.defaultCountry !== undefined ||
		resolveOpts.postcodeCountryCoherence !== undefined ||
		resolveOpts.postcodeShapeCoherence !== undefined ||
		resolveOpts.postcodeContainmentCoherence !== undefined
	) {
		pipelineOpts.resolveOpts = resolveOpts
	}

	// #727 phase-4c: the rerank is DEFAULT-ON — `createRuntimePipeline` lazy-loads the bundled FR index when the model
	// ships a span head (a no-op otherwise). `--no-street-evidence-rerank` passes `false` to disable it.
	const streetEvidence = options.streetEvidenceRerank ? undefined : (false as const)

	const { createRuntimePipeline } = await import("#index")

	if (options.resolve) {
		return await withResolver(options, async (resolver) => {
			const fst = await tryBuildFST(options)
			const pipeline = createRuntimePipeline({ classifier, resolver, fst, streetEvidence, poiQueryKind: options.poi })
			const result = await pipeline(input, pipelineOpts)
			emitFaultWarnings(result)

			return options.debug
				? JSON.stringify(await serializeResult(result, options.format), null, 2)
				: await serializeTree(result.tree, options.format, { includeAlternatives: wantAlternatives })
		})
	}

	const fst = await tryBuildFST(options)
	const pipeline = createRuntimePipeline({ classifier, fst, streetEvidence, poiQueryKind: options.poi })
	const result = await pipeline(input, pipelineOpts)
	emitFaultWarnings(result)

	return options.debug
		? JSON.stringify(await serializeResult(result, options.format), null, 2)
		: await serializeTree(result.tree, options.format, { includeAlternatives: wantAlternatives })
}

const BENCHMARK_WARMUP_ITERATIONS = 5

function formatMs(ms: number): string {
	if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`

	if (ms < 10) return `${ms.toFixed(2)}ms`

	if (ms < 100) return `${ms.toFixed(1)}ms`

	return `${Math.round(ms)}ms`
}

/**
 * Run the runtime pipeline N times against a single input and report per-stage timing percentiles + heap delta. The
 * first 5 iterations are warmup (excluded from stats) so JIT + lazy-imports settle before measurement. Useful for
 * catching regressions when training models or coordinator changes affect inference cost.
 */
async function runBenchmark(input: string, options: ParseOptions, iterations: number): Promise<string> {
	// `--degraded` is the encoder-less benchmark: the weights guard never runs on this path (it is
	// gated on `benchmark === undefined`), so the flag has to be read here or it silently does nothing.
	const classifier = options.degraded ? undefined : await tryLoadNeural(options)

	const runOne = async (
		pipeline: ReturnType<typeof createRuntimePipeline>
	): Promise<{ timing: Record<string, number>; total: number; path: string }> => {
		const t0 = performance.now()
		const result = await pipeline(input, { locale: options.locale })
		const total = performance.now() - t0

		return { timing: { ...result.timing }, total, path: result.path }
	}

	const collect = async (
		pipeline: ReturnType<typeof createRuntimePipeline>
	): Promise<{
		stageRuns: Map<string, number[]>
		totals: number[]
		paths: Map<string, number>
		heapDelta: number
	}> => {
		for (let i = 0; i < BENCHMARK_WARMUP_ITERATIONS; i++) {
			await runOne(pipeline)
		}

		if (typeof globalThis.gc === "function") {
			globalThis.gc()
		}

		const heapBefore = process.memoryUsage().heapUsed

		const stageRuns = new Map<string, number[]>()
		const totals: number[] = []
		const paths = new Map<string, number>()

		for (let i = 0; i < iterations; i++) {
			const r = await runOne(pipeline)
			totals.push(r.total)
			paths.set(r.path, (paths.get(r.path) ?? 0) + 1)

			for (const [stage, ms] of Object.entries(r.timing)) {
				let arr = stageRuns.get(stage)

				if (!arr) {
					arr = []
					stageRuns.set(stage, arr)
				}

				arr.push(ms)
			}
		}

		const heapAfter = process.memoryUsage().heapUsed

		return { stageRuns, totals, paths, heapDelta: heapAfter - heapBefore }
	}

	const { createRuntimePipeline } = await import("#index")

	const collected = options.resolve
		? await withResolver(options, (resolver) =>
				collect(createRuntimePipeline({ classifier, resolver, poiQueryKind: options.poi }))
			)
		: await collect(createRuntimePipeline({ classifier, poiQueryKind: options.poi }))

	const lines: string[] = [
		`mailwoman parse --benchmark: ${iterations} iterations + ${BENCHMARK_WARMUP_ITERATIONS} warmup`,
		`input: ${JSON.stringify(input)}`,
		`classifier: ${classifier ? `loaded (${options.locale})` : "none"}    resolver: ${options.resolve ? "wired" : "none"}`,
	]

	const pathSummary = Array.from(collected.paths.entries())
		.map(([p, n]) => `${p}=${n}`)
		.join(" ")

	lines.push(`path breakdown: ${pathSummary}`)
	lines.push("")
	lines.push("stage              p50       p95       p99       max")
	lines.push("─────────────────  ────────  ────────  ────────  ────────")

	for (const [stage, ms] of Array.from(collected.stageRuns.entries()).toSorted()) {
		const sorted = [...ms].toSorted((a, b) => a - b)

		lines.push(
			[
				stage.padEnd(17),
				formatMs(percentile(sorted, 50) ?? 0).padStart(8),
				formatMs(percentile(sorted, 95) ?? 0).padStart(8),
				formatMs(percentile(sorted, 99) ?? 0).padStart(8),
				formatMs(sorted.at(-1) ?? 0).padStart(8),
			].join("  ")
		)
	}

	const totalsSorted = [...collected.totals].toSorted((a, b) => a - b)
	lines.push("─────────────────  ────────  ────────  ────────  ────────")

	lines.push(
		[
			"TOTAL".padEnd(17),
			formatMs(percentile(totalsSorted, 50) ?? 0).padStart(8),
			formatMs(percentile(totalsSorted, 95) ?? 0).padStart(8),
			formatMs(percentile(totalsSorted, 99) ?? 0).padStart(8),
			formatMs(totalsSorted.at(-1) ?? 0).padStart(8),
		].join("  ")
	)

	lines.push("")
	// `formatIEC` carries a minus itself; a growth needs the plus spelled out or the sign is only legible by absence.
	const heapDelta = collected.heapDelta

	lines.push(`heap delta (post-warmup → post-bench): ${heapDelta > 0 ? "+" : ""}${ByteFormatter.formatIEC(heapDelta)}`)

	return lines.join("\n")
}

/**
 * Try to load the neural classifier. NEVER throws — on failure it emits a LOUD one-line stderr warning and returns
 * `undefined` so the caller degrades to the structural pipeline (postcode_only / locality_only fast-paths still
 * resolve; `npx mailwoman parse …` always produces output). Distinguishes two failure modes (#1108) so a consumer can't
 * attribute silently-degraded output to the neural parser:
 *
 * - Weights ABSENT (package not installed / carries no binaries) → an install hint, no scary error text.
 * - Weights present but the encoder FAILED to load (corrupt / partial bundle) → the underlying error is surfaced, not
 *   swallowed.
 *
 * The warning goes to STDERR, never STDOUT, so piped stdout parsing is unaffected.
 */
async function tryLoadNeural(options: ParseOptions): Promise<NeuralAddressClassifier | undefined> {
	try {
		const { NeuralAddressClassifier } = await import("@mailwoman/neural")

		return await NeuralAddressClassifier.loadFromWeights({
			locale: options.locale,
			modelPath: options.model,
			tokenizerPath: options.tokenizer,
		})
	} catch (error) {
		// Graceful degradation: pipeline runs normalize + queryShape + kind (+ resolver) only. The caller
		// sees `tree.roots` populated from QueryShape fast-paths but nothing from the encoder — so we warn.
		const message = error instanceof Error ? error.message : String(error)
		// "Absent" = the weights package simply isn't installed (the resolver's not-found signal). Every OTHER
		// failure means the weights DID resolve but the encoder couldn't load them — a partial/metadata-only
		// bundle ("missing model files"), a bad explicit --model/--tokenizer path, or a corrupt artifact — so we
		// surface the underlying error verbatim rather than mislabel it "not installed" and swallow the cause.
		const absent = /Could not resolve/iu.test(message)

		if (absent) {
			console.error(
				`⚠ neural weights not found — running a degraded structural parse; ` +
					`install ${weightsPackageName(options.locale)} for full accuracy.`
			)
		} else {
			console.error(`⚠ neural weights failed to load — running a degraded structural parse. Encoder error: ${message}`)
		}

		return undefined
	}
}

/**
 * Serialize the full pipeline result for `--debug`. Shows tree + timing + path + kind so callers can see which stage
 * owned which output.
 */
async function serializeResult(
	result: Awaited<ReturnType<ReturnType<typeof createRuntimePipeline>>>,
	format: "json" | "tuple" | "xml"
): Promise<unknown> {
	const { decodeAsXML } = await import("@mailwoman/core/decoder")

	return {
		input: result.input,
		normalized: result.normalized,
		queryShape: { ...result.queryShape, tokenClasses: undefined }, // tokenClasses is verbose
		locale: result.locale,
		kind: result.kind,
		...(result.poiIntent ? { poiIntent: result.poiIntent } : {}),
		path: result.path,
		timing: result.timing,
		// #40: only when non-empty — the key's presence IS the signal, and its absence keeps the clean-run shape
		// byte-identical for anything diffing `--debug` output. `cause` is dropped: an Error serializes to `{}`.
		...(result.faults.length
			? {
					faults: result.faults.map(({ stage, name, message }) => ({ stage, name, message })),
				}
			: {}),
		tree: format === "xml" ? decodeAsXML(result.tree) : result.tree,
	}
}

async function runNeural(
	input: string,
	options: ParseOptions,
	policyOverrides: readonly PolicyOverride[]
): Promise<string> {
	const { collectProposals, filterByPolicy, InMemoryPolicyRegistry } = await import("@mailwoman/core/policy")
	const { proposalsToTree } = await import("@mailwoman/core/decoder")
	const { createNeuralProposalClassifier, NeuralAddressClassifier } = await import("@mailwoman/neural")

	const neural = await NeuralAddressClassifier.loadFromWeights({
		locale: options.locale,
		modelPath: options.model,
		tokenizerPath: options.tokenizer,
	})

	// Fast path: no policy AND no resolve → preserve containment nesting via NeuralAddressClassifier
	// 's direct projection helpers (returns the serialized string in one call).
	if (!policyOverrides.length && !options.resolve) {
		switch (options.format) {
			case "xml":
				return neural.parseXML(input, { inputMode: options.inputMode })
			case "tuple":
				return JSON.stringify(await neural.parseTuples(input, { inputMode: options.inputMode }), null, 2)
			default:
				return JSON.stringify(await neural.parseJSON(input, { inputMode: options.inputMode }), null, 2)
		}
	}

	// Slow paths build the tree explicitly so we can resolve / re-project before serialization.
	let tree: AddressTree

	if (policyOverrides.length) {
		// Policy path: containment nesting is lost — see proposals-to-tree.ts for why.
		const proposalCls = createNeuralProposalClassifier({ id: `neural-cli-${options.locale}`, classifier: neural })
		// Without rule classifiers in the CLI loop, the registry's default rule_only would drop every
		// neural proposal and produce empty output. Default every component to neural_only when
		// --neural --policy is used, then layer the user's overrides on top.
		const policy = InMemoryPolicyRegistry.withDefaults()

		for (const entry of policy.entries()) {
			policy.set({ component: entry.component, mode: "neural_only" })
		}

		for (const o of policyOverrides) {
			policy.set({ component: o.component, mode: o.mode })
		}

		const wholeInputSection = { body: input, start: 0, end: input.length } as Section
		const proposals = await collectProposals([wholeInputSection], [proposalCls], { locale: options.locale })
		const filtered = filterByPolicy(proposals, policy, options.locale)
		tree = proposalsToTree(input, filtered)
	} else {
		// Resolve path without policy — keep containment by going through the decoder directly.
		tree = await neural.parse(input, { inputMode: options.inputMode })
	}

	if (options.resolve) {
		tree = await withResolver(options, (resolver) => resolveWithCandidates(resolver, tree, options))
	}

	return await serializeTree(tree, options.format, { includeAlternatives: options.candidates != null })
}

export default ParseCommand
