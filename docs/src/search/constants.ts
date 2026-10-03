/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * The file name of the gzip SQLite index the docs build writes at the site root.
 */
export const SEARCH_INDEX_FILENAME = "search-index.db.gz"
/**
 * The URL path at which the browser fetches the search index.
 */
export const SEARCH_INDEX_PATH = `/${SEARCH_INDEX_FILENAME}`
/**
 * Where the `runtime-assets` plugin stages the sqlite-wasm worker and runtime.
 */
export const SQLITE_RUNTIME_PATH = "/mailwoman/sqlite/"
