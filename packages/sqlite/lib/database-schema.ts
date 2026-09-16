/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Default schema type for {@link DatabaseClient}; consumers supply their own table schema.
 */

/**
 * Empty schema marker used only as the generic default.
 */
export type Database = Record<string, never>
