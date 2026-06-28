/**
 * @file Global variables provided by Node.js
 */

declare module "process" {
	global {
		namespace NodeJS {
			interface ProcessEnv {
				/**
				 * An environment variable used to determine whether Node.js is running in production mode.
				 *
				 * @see {@link https://nodejs.org/en/learn/getting-started/nodejs-the-difference-between-development-and-production | The difference between development and production}
				 */
				readonly NODE_ENV?: "development" | "production"

				/**
				 * Whether or not we are running on a CI server.
				 */
				readonly CI?: string

				readonly RCLONE_S3_PROVIDER?: string
				readonly RCLONE_S3_ACCESS_KEY_ID?: string
				readonly RCLONE_S3_SECRET_ACCESS_KEY?: string
				readonly RCLONE_S3_ENDPOINT?: string
				readonly RCLONE_S3_REGION?: string
				readonly RCLONE_S3_NO_CHECK_BUCKET?: string
				readonly RCLONE_S3_PUBLIC_PROVIDER?: string
				readonly RCLONE_S3_PUBLIC_ACCESS_KEY_ID?: string
				readonly RCLONE_S3_PUBLIC_SECRET_ACCESS_KEY?: string
				readonly RCLONE_S3_PUBLIC_ENDPOINT?: string
				readonly RCLONE_S3_PUBLIC_REGION?: string
				readonly RCLONE_S3_PUBLIC_NO_CHECK_BUCKET?: string

				readonly HF_BUCKET_URI?: string
				readonly HF_ORG_NAME?: string
				readonly HF_BUCKET_NAME?: string
				readonly HF_BUCKET_RESOLVE_URL?: string
				readonly HF_TOKEN?: string

				readonly CF_AUTH_TOKEN?: string
				readonly GEOCODE_EARTH_API_KEY?: string
			}
		}
	}
}
