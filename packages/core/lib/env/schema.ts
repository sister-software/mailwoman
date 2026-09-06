/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * @file Environment schema definitions for `@mailwoman/core`. Every key here is read by core itself; a package
 *   that reads its own variables declares them beside its readers and extends these views with `liveEnv`.
 */

import { z } from "zod"

import { DefaultMailwomanPaths } from "#env/paths"
import { blankAsAbsent } from "#env/utils"

// #region Public

const StorageEnvSchema = z.object({
	// Platform-native application directories. Environment values override these defaults.
	//
	// A bare `.default()` fires only on `undefined`, so a present-but-empty variable passes validation intact.
	MAILWOMAN_DATA_ROOT: blankAsAbsent(z.string().default(DefaultMailwomanPaths.data)).meta({
		title: "Data root",
		description: "Root directory for downloaded Mailwoman data and runtime artifacts.",
	}),
	MAILWOMAN_CONFIG_ROOT: blankAsAbsent(z.string().default(DefaultMailwomanPaths.config)).meta({
		title: "Config root",
		description: "Directory for Mailwoman configuration files.",
	}),
	MAILWOMAN_CACHE_ROOT: blankAsAbsent(z.string().default(DefaultMailwomanPaths.cache)).meta({
		title: "Cache root",
		description: "Directory for reusable downloaded and generated caches.",
	}),
	MAILWOMAN_TEMP_ROOT: blankAsAbsent(z.string().default(DefaultMailwomanPaths.temp)).meta({
		title: "Temporary root",
		description: "Directory for named temporary outputs and evaluation staging.",
	}),
})

const RuntimeEnvSchema = z.object({
	MAILWOMAN_COARSE_PLACER_DIR: z.string().optional().meta({
		title: "Coarse placer directory",
		description: "Directory containing the coarse country-placement model artifacts.",
	}),
})

const LicenseEnvSchema = z.object({
	MAILWOMAN_DOCS_URL: z.string().optional().meta({
		title: "Documentation URL",
		description: "Base URL used by documentation and demo tooling.",
	}),
	/**
	 * A signed commercial license key (`mwl1.<payload>.<signature>`, Ed25519 over the payload, verified offline against
	 * the public keys `@mailwoman/core/license` ships). Its presence changes what `mailwoman doctor` reports about the
	 * license that applies to this installation; it never changes what the runtime does. Absent means the AGPL-3.0-only
	 * branch applies. Public in the sense that it is a signed assertion, not a secret, but the doctor prints the licensee
	 * and expiry rather than the token.
	 */
	MAILWOMAN_LICENSE_KEY: blankAsAbsent(z.string().min(1).optional()).meta({
		title: "Commercial license key",
		description: "Signed commercial license assertion used by `mailwoman doctor`; it does not change runtime behavior.",
	}),
	/**
	 * The license worker's origin (`https://license.mailwoman.ai` when unset), for `mailwoman license refresh` and the
	 * online per-license status. Pointed at a sandbox deploy or a test stub.
	 */
	MAILWOMAN_LICENSE_URL: blankAsAbsent(z.string().min(1).optional()).meta({
		title: "License service URL",
		description: "License-service origin used by license refresh and online status checks.",
	}),
})

/**
 * Non-secret operational config core reads, exposed via `$public`. Anything not listed is stripped from `process.env`
 * on parse.
 */
export const PublicEnvSchema = z
	.object({
		...StorageEnvSchema.shape,
		...RuntimeEnvSchema.shape,
		...LicenseEnvSchema.shape,
	})
	.meta({
		title: "Public environment configuration",
		description: "Non-secret operational configuration exposed through `$public`.",
	})

// #endregion

// #region Private

/**
 * Secrets core reads, exposed via `$private`. Core reads none: this is the base every package's private view extends,
 * so a credential is declared once, beside the code that sends it.
 */
export const PrivateEnvSchema = z.object({}).meta({
	title: "Private environment configuration",
	description: "Secrets and credentials exposed through `$private`; never log their values.",
})

// #endregion
