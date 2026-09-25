/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Spinner } from "@inkjs/ui"
import type { ComponentTag } from "@mailwoman/codex/component"
import type { AddressTree } from "@mailwoman/core/decoder"
import { errorMessage } from "@mailwoman/core/errors/schema"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { pathExists } from "@mailwoman/core/fs/readers"
import { prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import type { PolicyMode } from "@mailwoman/core/policy"
import type { Resolver } from "@mailwoman/core/resolver"
import { CommandError } from "@mailwoman/core/scripting/command"
import { percentile } from "@mailwoman/core/stats"
import type { Section } from "@mailwoman/core/types"
import type { NeuralAddressClassifier, ScriptRoutedClassifier } from "@mailwoman/neural"
import { weightsPackageName } from "@mailwoman/neural/weights"
import type { FSTMatcher } from "@mailwoman/resolver-wof-sqlite/fst"
import type React from "react"

import {
	type CommandSpec,
	CommandTaskResult,
	isLocaleTag,
	loadClassifierTolerant,
	type ParsedCommandComponent,
	reportToStderr,
	useCommandTask,
	writeRawStdout,
} from "#cli-kit"
import { WeightsGuard, type WeightsOutcome } from "#cli-kit/weights-guard"
import { resolverDefaultCountry } from "#country-scope"
import type { createRuntimePipeline } from "#index"

/**
 * Re-exports the country-scope helpers so tests can check the `--locale` to
 * default-country mapping through the command module.
 */
export { localeToCountry, resolverDefaultCountry } from "#country-scope"
/**
 * Re-exports the country-scope type alongside its helpers.
 */
export type { CountryScope } from "#country-scope"

const POLICY_MODES: readonly PolicyMode[] = ["rule_only", "neural_only", "both", "neural_preferred", "rule_preferred"]
const POLICY_SPEC_RE = /^([a-z_]+)=([a-z_]+)$/u

/**
 * The summary at the top of `mailwoman parse --help`.
 *
 * It distinguishes `parse` from `geocode`, because both commands take the same argument.
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
 * Command specification for `parse`, which labels the components of an address.
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
			validate: isLocaleTag,
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
	// The weights guard covers only the default pipeline path.
	// The benchmark, policy, neural and explicit model paths load weights themselves.
	const guardEligible =
		options.benchmark === undefined &&
		!(options.policy && options.policy.length) &&
		!options.neural &&
		!options.model &&
		!options.tokenizer

	if (guardEligible) {
		return (
			<WeightsGuard locale={options.locale} autoDownload={options.downloadWeights} forceDegraded={options.degraded}>
				{(outcome) => <ParseTask options={options} args={args} weightsOutcome={outcome} />}
			</WeightsGuard>
		)
	}

	return <ParseTask options={options} args={args} weightsOutcome={options.degraded ? "declined" : "neural"} />
}

/**
 * Runs the parse in a component below the weights guard, so that the guard's prompt renders first.
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

		if (options.degraded && ((options.policy && options.policy.length) || options.neural)) {
			throw new CommandError("--degraded skips the neural encoder, so it cannot be combined with --policy or --neural")
		}

		if (options.policy && options.policy.length) {
			const policyOverrides = parsePolicySpecs(options.policy)

			return await runNeural(input, options, policyOverrides)
		}

		if (options.neural) {
			return await runNeural(input, options, [])
		}

		// An `unavailable` outcome falls through to `runPipeline`, which attempts the load itself.
		if (weightsOutcome === "declined") {
			return runDegraded(input, options)
		}

		return runPipeline(input, options)
	})

	if (state.status !== "done") return <CommandTaskResult state={state} running={<Spinner />} />

	// Every output format is machine-readable, so it bypasses Ink's `<Text>`, which wraps long lines.
	return writeRawStdout(state.result)
}

async function resolveWOFPath(options: ParseOptions): Promise<string> {
	const { requireWOFPath } = await import("#resolver-backend")

	try {
		return await requireWOFPath(options.resolveDB)
	} catch (error) {
		throw new CommandError(errorMessage(error), { cause: error })
	}
}

async function tryBuildFST(options: ParseOptions): Promise<FSTMatcher | undefined> {
	const { $public } = await import("#env")
	const dbPath = options.resolveDB ?? $public.MAILWOMAN_WOF_DB

	if (!dbPath) return undefined

	try {
		if (!(await pathExists(dbPath))) return undefined
		const { buildFSTFromWOF } = await import("@mailwoman/resolver-wof-sqlite/fst")
		const { matcher } = await buildFSTFromWOF({ dbPath })

		return matcher
	} catch {
		return undefined
	}
}

/**
 * Resolves a parsed tree against the WOF backend.
 *
 * The lookup limit is `--candidates` plus one, because the winning candidate counts toward it.
 */
async function resolveWithCandidates(
	resolver: Resolver,
	tree: AddressTree,
	options: ParseOptions,
	routedAway = false
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

	// The resolver enables postcode-country coherence by default, so only the opt-out is passed.
	if (options.postcodeCountryCoherence === false) {
		opts.postcodeCountryCoherence = false
	}

	// The resolver disables shape and containment coherence by default, so only the opt-in is passed.
	if (options.postcodeShapeCoherence === true) {
		opts.postcodeShapeCoherence = true
	}

	if (options.postcodeContainmentCoherence === true) {
		opts.postcodeContainmentCoherence = true
	}

	const { resolveCandidateDBPath } = await import("#resolver-backend")

	const dc =
		routedAway && !options.defaultCountry
			? undefined
			: resolverDefaultCountry(options, !!(await resolveCandidateDBPath()))

	if (dc) {
		opts.defaultCountry = dc
	}

	// The resolver enables admin coherence by default, so only the opt-out is passed.
	if (options.adminCoherence === false) {
		opts.adminCoherence = false
	}

	return resolver.resolveTree(tree, opts)
}

async function withResolver<T>(options: ParseOptions, fn: (resolver: Resolver) => Promise<T>): Promise<T> {
	const { createWOFResolver } = await import("@mailwoman/resolver")
	const { createResolverBackend, resolveCandidateDBPath } = await import("#resolver-backend")

	// `@mailwoman/resolver-wof-sqlite` is an optional peer, so it loads only when a resolver is needed.
	let mod: typeof import("@mailwoman/resolver-wof-sqlite")

	try {
		mod = await import("@mailwoman/resolver-wof-sqlite")
	} catch {
		throw new CommandError(
			"--resolve requires `@mailwoman/resolver-wof-sqlite` to be installed. " +
				"Run `npm install @mailwoman/resolver-wof-sqlite` and try again."
		)
	}

	// A configured candidate database needs no WOF admin path.
	const lookup = await createResolverBackend(mod, {
		wofPaths: (await resolveCandidateDBPath()) ? "" : await resolveWOFPath(options),
	})

	try {
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
			return prettyJSON(decodeAsTuples(tree))
		default:
			// With `--candidates`, JSON output is the full tree so that alternatives appear.
			// Otherwise it is the flat libpostal-style tag-to-value map.
			return opts.includeAlternatives ? prettyJSON(tree) : prettyJSON(decodeAsJSON(tree))
	}
}

/**
 * Prints the degraded-mode banner to stderr when the weights guard declines the encoder.
 *
 * A failed encoder load is reported by `tryLoadNeural` instead, so that path does not print this banner.
 */
function emitDegradedBanner(options: ParseOptions): void {
	console.error(
		"⚠ degraded parse: the neural encoder is not loaded — output carries structural-pipeline results only.\n" +
			`  Upgrade: npm install ${weightsPackageName(options.locale)}   or   mailwoman parse --download-weights <address>`
	)
}

/**
 * Prints a stderr warning for each stage that threw.
 *
 * The pipeline continues past a failed stage, so without these warnings the
 * output would look like a complete parse.
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
 * Runs the pipeline without a neural classifier.
 *
 * Only the structural fast paths, such as postcode-only and locality-only inputs,
 * populate the tree, so a free-form address may produce an empty tree.
 * The caller prints the degraded notice.
 */
async function runStructuralPipeline(input: string, options: ParseOptions): Promise<string> {
	const { createRuntimePipeline } = await import("#index")
	const pipeline = createRuntimePipeline({ poiQueryKind: options.poi })
	const result = await pipeline(input, { locale: options.locale })
	emitFaultWarnings(result)

	return options.debug
		? prettyJSON(await serializeResult(result, options.format))
		: await serializeTree(result.tree, options.format, { includeAlternatives: false })
}

/**
 * Prints the degraded banner and runs the structural pipeline.
 */
async function runDegraded(input: string, options: ParseOptions): Promise<string> {
	emitDegradedBanner(options)

	return runStructuralPipeline(input, options)
}

/**
 * Parses with the runtime pipeline and serializes the tree in the requested format.
 *
 * A plain parse falls back to the structural pipeline when the encoder does not load.
 */
async function runPipeline(input: string, options: ParseOptions): Promise<string> {
	// `tryLoadNeural` prints its own warning when the load fails, so this path skips the degraded banner.
	const classifier = await tryLoadNeural(options)

	// Without an encoder the full pipeline produces only fast-path structure.
	// `--resolve` and `--debug` stay on the full pipeline to keep their output shape.
	if (!classifier && !options.resolve && !options.debug) {
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

	// The resolver enables postcode-country coherence by default, so only the opt-out is passed.
	if (options.resolve && options.postcodeCountryCoherence === false) {
		resolveOpts.postcodeCountryCoherence = false
	}

	// The resolver disables shape and containment coherence by default, so only the opt-in is passed.
	if (options.resolve && options.postcodeShapeCoherence === true) {
		resolveOpts.postcodeShapeCoherence = true
	}

	if (options.resolve && options.postcodeContainmentCoherence === true) {
		resolveOpts.postcodeContainmentCoherence = true
	}

	// The default country keeps a bare region abbreviation such as `NY` from resolving to a foreign homonym.
	if (options.resolve) {
		const { resolveCandidateDBPath } = await import("#resolver-backend")
		// An input routed to another script family's classifier does not inherit the locale's country.
		// An explicit `--default-country` still applies.
		const routedAway = classifier ? (await classifier.forInput(input)) !== classifier.primary : false

		const dc =
			routedAway && !options.defaultCountry
				? undefined
				: resolverDefaultCountry(options, !!(await resolveCandidateDBPath()))

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

	// Passing `undefined` keeps the pipeline's default street-evidence rerank, and `false` disables it.
	const streetEvidence = options.streetEvidenceRerank ? undefined : (false as const)

	const { createRuntimePipeline } = await import("#index")

	if (options.resolve) {
		return await withResolver(options, async (resolver) => {
			const fst = await tryBuildFST(options)
			const pipeline = createRuntimePipeline({ classifier, resolver, fst, streetEvidence, poiQueryKind: options.poi })
			const result = await pipeline(input, pipelineOpts)
			emitFaultWarnings(result)

			return options.debug
				? prettyJSON(await serializeResult(result, options.format))
				: await serializeTree(result.tree, options.format, { includeAlternatives: wantAlternatives })
		})
	}

	const fst = await tryBuildFST(options)
	const pipeline = createRuntimePipeline({ classifier, fst, streetEvidence, poiQueryKind: options.poi })
	const result = await pipeline(input, pipelineOpts)
	emitFaultWarnings(result)

	return options.debug
		? prettyJSON(await serializeResult(result, options.format))
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
 * Runs the pipeline repeatedly on one input and reports per-stage timing percentiles and the heap delta.
 *
 * Warmup iterations are excluded from the statistics so that JIT compilation and lazy imports settle first.
 */
async function runBenchmark(input: string, options: ParseOptions, iterations: number): Promise<string> {
	// The weights guard does not run for benchmarks, so `--degraded` is handled here.
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
		`input: ${stringifyJSON(input)}`,
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
	// `formatIEC` prints a minus sign but not a plus sign, so growth gets an explicit plus.
	const heapDelta = collected.heapDelta

	lines.push(`heap delta (post-warmup → post-bench): ${heapDelta > 0 ? "+" : ""}${ByteFormatter.formatIEC(heapDelta)}`)

	return lines.join("\n")
}

/**
 * Loads the neural classifier, or returns `undefined` so that the caller can
 * fall back to the structural pipeline.
 *
 * Load warnings go to stderr, so stdout stays parseable.
 */
async function tryLoadNeural(
	options: ParseOptions
): Promise<ScriptRoutedClassifier<NeuralAddressClassifier> | undefined> {
	return await loadClassifierTolerant(options.locale, {
		modelPath: options.model,
		tokenizerPath: options.tokenizer,
		onDegrade: reportToStderr,
	})
}

/**
 * Serializes the full pipeline result for `--debug`, including the timing, path and kind.
 */
async function serializeResult(
	result: Awaited<ReturnType<ReturnType<typeof createRuntimePipeline>>>,
	format: "json" | "tuple" | "xml"
): Promise<unknown> {
	const { decodeAsXML } = await import("@mailwoman/core/decoder")

	return {
		input: result.input,
		normalized: result.normalized,
		// Token classes are omitted because they are verbose.
		queryShape: { ...result.queryShape, tokenClasses: undefined },
		locale: result.locale,
		kind: result.kind,
		...(result.poiIntent ? { poiIntent: result.poiIntent } : {}),
		path: result.path,
		timing: result.timing,
		// The `faults` key appears only when a stage threw, so a clean run keeps its output shape.
		// The `cause` is dropped because an Error serializes to `{}`.
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

	// Each invocation parses one input, so the script route is chosen once up front.
	const routedClassifier = await NeuralAddressClassifier.loadRoutedFromWeights({
		locale: options.locale,
		modelPath: options.model,
		tokenizerPath: options.tokenizer,
	})

	const neural = await routedClassifier.forInput(input)
	// An input routed to another script family does not inherit the locale's country.
	const routedAway = neural !== routedClassifier.primary

	// Without policy overrides or resolution, the classifier's own projections keep containment nesting.
	if (!policyOverrides.length && !options.resolve) {
		switch (options.format) {
			case "xml":
				return neural.parseXML(input, { inputMode: options.inputMode })
			case "tuple":
				return prettyJSON(await neural.parseTuples(input, { inputMode: options.inputMode }))
			default:
				return prettyJSON(await neural.parseJSON(input, { inputMode: options.inputMode }))
		}
	}

	let tree: AddressTree

	if (policyOverrides.length) {
		// The policy path loses containment nesting, as explained in `proposals-to-tree.ts`.
		const proposalCls = createNeuralProposalClassifier({ id: `neural-cli-${options.locale}`, classifier: neural })
		// The CLI runs no rule classifiers, so the registry's `rule_only` defaults would drop every proposal.
		// Every component therefore starts at `neural_only`, and the user's overrides apply on top.
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
		// Parsing through the decoder keeps containment nesting.
		tree = await neural.parse(input, { inputMode: options.inputMode })
	}

	if (options.resolve) {
		tree = await withResolver(options, (resolver) => resolveWithCandidates(resolver, tree, options, routedAway))
	}

	return await serializeTree(tree, options.format, { includeAlternatives: options.candidates != null })
}

export default ParseCommand
