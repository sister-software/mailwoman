import { loadEnvFile } from "./load.js"
import { cwdPathBuilder } from "./paths.js"
import { PrivateEnvSchema, PublicEnvSchema } from "./schema.js"

const envFileRecord = loadEnvFile(cwdPathBuilder(".env"))

/**
 * Publicly accessible environment variables, loaded from the `.env` file in the current working directory.
 *
 * @see {@link loadEnvFile}
 * @see {@link $private} for privately accessible environment variables.
 */
export const $public = PublicEnvSchema.parse(envFileRecord)

/**
 * Privately accessible environment variables, loaded from the `.env` file in the current working directory.
 *
 * @see {@link loadEnvFile}
 * @see {@link $public} for publicly accessible environment variables.
 */
export const $private = PrivateEnvSchema.parse(envFileRecord)
