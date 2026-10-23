/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * @file Environment schema definitions for `@mailwoman/core`. Every key here is read by core itself. a package
 *   that reads its own variables declares them beside its readers and extends these views with `liveEnv`.
 */

import { object, string, url } from "zod"

import { DefaultMailwomanPaths, DefaultWellKnown, ServerStoragePaths } from "#env/paths"
import { blankAsAbsent } from "#env/utils"

// #region Public

// #region Local Storage

const StorageEnvSchema = object({
	MAILWOMAN_DATA_ROOT: blankAsAbsent(string().default(DefaultMailwomanPaths.data)).meta({
		title: "Data root",
		description: "Root directory for downloaded Mailwoman data and runtime artifacts.",
	}),
	MAILWOMAN_CONFIG_ROOT: blankAsAbsent(string().default(DefaultMailwomanPaths.config)).meta({
		title: "Config root",
		description: "Directory for Mailwoman configuration files.",
	}),
	MAILWOMAN_CACHE_ROOT: blankAsAbsent(string().default(DefaultMailwomanPaths.cache)).meta({
		title: "Cache root",
		description: "Directory for reusable downloaded and generated caches.",
	}),
	MAILWOMAN_TEMP_ROOT: blankAsAbsent(string().default(DefaultMailwomanPaths.temp)).meta({
		title: "Temporary root",
		description: "Directory for named temporary outputs and evaluation staging.",
	}),
})

// #endregion

// #region Runtime

const RuntimeEnvSchema = object({
	MAILWOMAN_COARSE_PLACER_DIR: string().optional().meta({
		title: "Coarse placer directory",
		description: "Directory containing the coarse country-placement model artifacts.",
	}),
})

// #endregion

// #region License

const LicenseEnvSchema = object({
	MAILWOMAN_DOCS_URL: string().optional().meta({
		title: "Documentation URL",
		description: "Base URL used by documentation and demo tooling.",
	}),
	/**
	 * A signed commercial license key (`mwl1.<payload>.<signature>`, Ed25519 over the payload,
	 * verified offline against the public keys `@mailwoman/core/license` ships).
	 *
	 * Its presence changes what `mailwoman doctor` reports about the license
	 * that applies to this installation.
	 * It never changes what the runtime does.
	 * Absent means the AGPL-3.0-only branch applies.
	 *
	 * Public in the sense that it is a signed assertion rather than a secret,
	 * but the doctor prints the licensee and expiry rather than the token.
	 */
	MAILWOMAN_LICENSE_KEY: blankAsAbsent(string().min(1).optional()).meta({
		title: "Commercial license key",
		description:
			"Signed commercial license assertion used by `mailwoman doctor`. This does not change runtime behavior.",
	}),
	/**
	 * The license worker's origin (`https://license.mailwoman.ai` when unset),
	 * for `mailwoman license refresh` and the online per-license status.
	 *
	 * Pointed at a sandbox deploy or a test stub.
	 */
	MAILWOMAN_LICENSE_URL: blankAsAbsent(url().optional()).meta({
		title: "License service URL",
		description: "License-service origin used by license refresh and online status checks.",
	}),
})

// #endregion

const DefaultWellKnownEnvSchema = object({
	MAILWOMAN_PUBLIC_BUCKET: string()
		.default(DefaultWellKnown.PublicBucket)
		.meta({
			title: "Public bucket",
			description: "S3 bucket for storing public assets.",
		})
		.brand(DefaultWellKnown.PublicBucket),
	MAILWOMAN_TILES_URL: url()
		.default(DefaultWellKnown.TilesURL)
		.meta({
			title: "Tiles origin",
			description: "Origin URL for serving tiles.",
		})
		.brand(DefaultWellKnown.TilesURL),
	MAILWOMAN_ASSETS_URL: url()
		.default(DefaultWellKnown.AssetsURL)
		.meta({
			title: "Public assets origin",
			description: "Origin URL for serving public assets.",
		})
		.brand(DefaultWellKnown.AssetsURL),
})

const ServerStoragePathsEnvSchema = object({
	MAILWOMAN_TILES_BUCKET: string()
		.default(ServerStoragePaths.TILES_BUCKET)
		.meta({
			title: "Tiles bucket",
			description: "S3 bucket for storing tiles.",
		})
		.brand(ServerStoragePaths.TILES_BUCKET),
	MAILWOMAN_TILES_PREFIX: string()
		.default(ServerStoragePaths.TILES_PREFIX)
		.meta({
			title: "Tiles prefix",
			description: "Prefix within the tiles bucket.",
		})
		.brand(ServerStoragePaths.TILES_PREFIX),
})

/**
 * Non-secret operational config core reads, exposed via `$public`.
 *
 * The schema strips any other key from `process.env` during parsing.
 */
export const PublicEnvSchema = object({
	...StorageEnvSchema.shape,
	...DefaultWellKnownEnvSchema.shape,
	...RuntimeEnvSchema.shape,
	...LicenseEnvSchema.shape,
}).meta({
	title: "Public environment configuration",
	description: "Non-secret operational configuration exposed through `$public`.",
})

// #endregion

// #region Private

/**
 * Secrets core reads, exposed via `$private`.
 *
 * Core reads none: this is the base every package's private view extends,
 * so a credential is declared once, beside the code that sends it.
 */
export const PrivateEnvSchema = object({
	...ServerStoragePathsEnvSchema.shape,
}).meta({
	title: "Private environment configuration",
	description: "Secrets and credentials exposed through `$private`; never log their values.",
})

// #endregion
