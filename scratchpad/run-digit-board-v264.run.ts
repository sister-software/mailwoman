/**
 * PRE-REGISTERED (written before the numbers exist): v310 reads NO bare-street-hn 0.693 with ZERO Norwegian training
 * data — almost exactly the 0.715 v310 reached on FRENCH bare-street after the fr-fragment shard. v264 is the same
 * model MINUS that shard (the one variable).
 *
 * TRANSFER : v264 reads NO bare-street-hn well below 0.693 -> the FR shard taught bare-street polarity in a way that
 * crossed to Norwegian. Phenomenon shards are locale- TRANSFERABLE, and the doctrine's "phenomenon shards per locale"
 * is too pessimistic. NO TRANSFER: v264 ~= v310 -> Norwegian bare-street was always ~0.69 and the FR shard did nothing
 * for it. Each locale needs its own shard.
 *
 * Package-shaped (#718), int8-vs-int8. The v264 cache is the SHIPPED 6.3.0 package.
 */
import { runDigitBoard } from "../mailwoman/eval-harness/digit-board.ts"

await runDigitBoard({ weightsCacheRoot: "scratchpad/v264-cache" })
