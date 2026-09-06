/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { z } from "zod"

/**
 * Environment settings consumed by release preparation and package publication.
 */
export const PublicReleaseEnvSchema = z.object({
	MAILWOMAN_PUBLISH_MODEL: z.string().optional().meta({
		title: "Published model",
		description: "Model artifact selected for release copying and publication.",
	}),
	MAILWOMAN_PUBLISH_TOKENIZER: z.string().optional().meta({
		title: "Published tokenizer",
		description: "Tokenizer artifact selected for release copying and publication.",
	}),
	MAILWOMAN_SKIP_WEIGHTS_COPY: z.string().optional().meta({
		title: "Skip weights copy",
		description: "Compatibility toggle that skips copying neural weights during development or release preparation.",
	}),
	// Release-it publish flow (`packages/release-kit/lib/pack/publish-workspace.ts`). The OTP is a secret — see `$private`.
	MAILWOMAN_SKIP_WEIGHTS: z.string().optional().meta({
		title: "Skip release weights",
		description: "Release-flow toggle that omits neural weights from package publication.",
	}),
	/**
	 * Set to `0` to publish WITHOUT a sigstore provenance attestation. Provenance is otherwise on by default under GitHub
	 * Actions — this exists so a release blocked by a sigstore or registry outage can still ship.
	 */
	MAILWOMAN_NPM_PROVENANCE: z.string().optional().meta({
		title: "npm provenance",
		description:
			"Set to `0` to publish without a Sigstore provenance attestation; otherwise provenance is enabled in GitHub Actions.",
	}),
	/**
	 * Set by GitHub Actions itself. npm can only mint a provenance attestation from a CI provider it supports, so this is
	 * the predicate for `--provenance` rather than the generic `CI` flag.
	 */
	GITHUB_ACTIONS: z.coerce.boolean().default(false).meta({
		title: "GitHub Actions",
		description: "Whether the process is running under GitHub Actions; used to determine npm provenance support.",
	}),
	RELEASE_IT_WORKSPACES_PATH_TO_WORKSPACE: z.string().optional().meta({
		title: "Release workspace path",
		description: "Workspace path override consumed by the release-it workspaces publish flow.",
	}),
	RELEASE_IT_WORKSPACES_TAG: z.string().optional().meta({
		title: "Release dist-tag",
		description: "npm distribution tag override consumed by the release-it workspaces publish flow.",
	}),
	RELEASE_IT_WORKSPACES_ACCESS: z.string().optional().meta({
		title: "Release package access",
		description: "npm package access override consumed by the release-it workspaces publish flow.",
	}),
	RELEASE_IT_WORKSPACES_DRY_RUN: z.string().optional().meta({
		title: "Release dry run",
		description: "Dry-run override consumed by the release-it workspaces publish flow.",
	}),
})

/**
 * Credentials used by package publication and weights staging. Never log their values.
 */
export const PrivateReleaseEnvSchema = z.object({
	RELEASE_IT_WORKSPACES_OTP: z.string().optional().meta({
		title: "npm one-time password",
		description: "npm two-factor authentication code used by the release publish flow.",
	}),
	HF_BUCKET_RESOLVE_URL: z
		.url()
		.optional()
		.meta({
			title: "Hugging Face bucket resolve URL",
			description: "Resolve URL used to fetch staged weights from the Hugging Face bucket.",
			examples: ["https://huggingface.co/buckets/sister-software/mailwoman/resolve/"],
		}),
})
