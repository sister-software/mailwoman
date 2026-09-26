/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The worktree arm as a comparison arm: `worktree-arm.ts` runs the child and `compare.ts` scores, while this
 * module projects the child's answers onto the shape every arm answers in so the dependency stays one-way.
 */

import type { ArmRunner, WorktreeArm } from "#arms"
import { type EffectiveConfig, type EngineRegistryLike, resolveConfig } from "#engine/registry"
import type { ResolvedInputSet } from "#input-sets"
import { runWorktreeArm } from "#worktree/arm"

/**
 * A mailwoman arm running another version of the source, batched in a child process
 * because the child pays a full engine build; the answers exist before the first
 * `answer()` call, which is why this arm cannot stream.
 *
 * The config is resolved by {@linkcode resolveConfig}, the same function the in-process
 * arm uses, so a change there reaches this arm without being copied.
 */
export async function worktreeArmRunner(
	registry: EngineRegistryLike,
	arm: WorktreeArm,
	set: ResolvedInputSet
): Promise<ArmRunner> {
	const effective: EffectiveConfig = resolveConfig(arm.config)

	const result = await runWorktreeArm({
		repoRoot: registry.repoRoot,
		ref: arm.ref,
		inputs: set.inputs.map((item) => item.input),
		options: effective,
	})

	const byInput = new Map(result.answers.map((answer) => [answer.input, answer]))
	const errored = result.answers.filter((answer) => answer.error).length

	const warnings = [
		`This arm ran tree ${result.commit} in a separate process. EVERYTHING that differs between the two trees is ` +
			"inside this comparison, not only what you changed on purpose — declare it as a variable and read the " +
			"isolation verdict accordingly.",
		...(result.commit.endsWith("+dirty")
			? [
					"The ref was the uncommitted working tree, so this arm is not reproducible from a sha alone. Commit " +
						"before recording a result you intend to cite.",
				]
			: []),
		...(errored ? [`${errored} of ${result.answers.length} rows threw in the child and score as no-results.`] : []),
	]

	return {
		label: `worktree:${arm.ref}`,
		provenance: {
			arm: "worktree",
			ref: arm.ref,
			commit: result.commit,
			setup_ms: result.setupMs,
			run_ms: result.runMs,
			config_effective: effective,
		},
		warnings,
		answer: async (input) => {
			const answer = byInput.get(input)

			// A missing input is a batching fault rather than a no-result: the child was handed
			// this set, so silence here would otherwise score as the pipeline declining to answer.
			if (!answer) {
				return {
					lat: null,
					lon: null,
					label: null,
					resultType: null,
					noResultReason: "this input was not in the child's batch",
				}
			}

			return {
				lat: answer.lat,
				lon: answer.lon,
				label: answer.components["locality"] ?? answer.components["region"] ?? null,
				resultType: answer.tier,
				noResultReason: answer.error ?? (answer.lat === null ? "the pipeline resolved no coordinate" : null),
			}
		},
	}
}
