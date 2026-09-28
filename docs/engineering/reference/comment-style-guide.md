# Mailwoman comment and code documentation style

This guide sets the voice for Mailwoman code comments, API documentation, and explanatory text in tests. It draws on comments and documentation from the author's earlier projects and on the current Mailwoman communication standards.

The goal is a natural, useful explanation. A comment can be conversational, but it should tell a reader what the code does, why a choice matters, or what a test establishes. It should not make the reader reconstruct the point from narration, shorthand, or a chain of clauses.

## The guiding principle

Explain the mechanism, then give the reader a place to stop.

Some earlier comments use a conversational voice to walk through a sequence. Others state a constraint, its cause, and its consequence. Mailwoman can use either approach. In both, the explanation should remain concrete, and each sentence should finish one useful thought before the next begins.

## GOOD

### Explain why a non-obvious operation is necessary

State what the code does and the condition that requires it.

```ts
// The import map is generated after TypeScript compilation, so load it dynamically.
```

This tells the reader why a static import would fail. A comment that only says “Load the import map dynamically” repeats the operation without explaining the constraint.

### State an invariant and its consequence

Name the property the code relies on, then state what follows from it.

```ts
// The lookup table contains an entry for every luminance value, so this lookup cannot miss.
```

Use the actual buffer, index, state, or lifecycle rule. The word “invariant” can be useful when discussing a named invariant, but it should not replace the property itself.

### Give each causal step a sentence

When an explanation needs several steps, let each sentence carry one step. A short sequence can still sound like a person explaining the code.

```ts
// `readPixels` returns rows from bottom to top. The rasterizer reverses the row index to display the image upright.
```

The two sentences name the operation and its consequence. The reader does not need to unpack several operations from one relative clause.

### Explain what a test distinguishes

Describe how the fixture or assertion exposes the failure the test covers.

```ts
// A vertical flip swaps the top and bottom pairs. A horizontal flip swaps left and right.
// Only the correct mapping produces this ordering.
```

A test shows how the code behaves for its inputs and conditions. Describe broader behavior as unverified unless other evidence supports it.

### Document caller-visible behavior

API documentation should help a caller use an export correctly. Describe the behavior, relevant defaults, limits, side effects, and platform differences. Include an example or reference when it answers a likely question.

```ts
/**
 * Resizes the source to one pixel per character cell.
 * This method does not resize the output canvas.
 */
```

Start JSDoc or TSDoc with a complete sentence that says what the symbol does or represents. Add detail when it changes how a caller should use it.

### Keep a conversational voice when it carries the explanation

First person, contractions, and direct address are welcome when they make a concrete explanation easier to follow.

```ts
// We read rows in reverse because WebGL returns them bottom-to-top.
```

Conversational wording is a voice choice. It does not remove the need to state the operation and its reason.

### Let the implementation explain routine behavior

Comment non-obvious behavior, constraints, decisions, and limitations. Keep comments near the code they explain. Remove a comment when names and implementation already give the reader the same information.

## BAD

### Do not chain another thought onto the sentence

The target cadence is a sentence that reaches its main point, adds a comma, and then keeps going through `which`, `whose`, or `and`. These clauses can each be grammatical. The problem is the accumulation: the reader must remember the opening point while the sentence adds another operation, explanation, or result.

```ts
// The pass uses the trainer's emitter, which makes its counts comparable, and this means the audit matches a training run.
```

Split the claims and keep their causal order:

```ts
// The pass uses the trainer's emitter. Its counts are therefore comparable with a training run.
```

Do not treat every comma followed by `which`, `whose`, or `and` as an error. A short relative clause can identify its subject. A list can use a comma and “and.” Revise sentences that accumulate independent facts or causal steps. A comma before one of these words can also serve a separate grammatical purpose.

### Do not narrate an obvious next action

Avoid a running commentary that announces each statement without giving its reason.

```ts
// First, create a stream...
const stream = new TransformStream()

// Next, create a reader...
const reader = stream.readable.getReader()
```

Explain an ordering only when the order matters. Then say why.

### Do not rely on shared context or hints

Avoid comments that assume the reader already knows what “this,” “them,” or “the thing” means.

```ts
// I think you know what's up. We gotta stitch these together...
```

Name the values or structures being combined and state what the combination produces.

### Do not label a workaround without describing its constraint

Words such as “hack” or “magic” express a reaction to the implementation. They do not explain why it exists.

```ts
// Bit of a hack.
```

State the compatibility issue, platform behavior, or other condition that requires the workaround.

### Do not compress an observation into a slogan

Avoid compressed slogans that hide the operation or behavior the reader needs to know.

```ts
// "The guard held." "Parity UP." "Contract confirmed."
// The fallback kept parity postcode at 0.986 in the 2,000-step probe.
```

When the claim depends on an evaluation, name its conditions and metric. Separate the observation from any unverified explanation.

### Do not restate a symbol or preserve empty comments

```ts
/** Creates a session. */
function createSession() { /* ... */ }
```

Add behavior, inputs, outputs, constraints, side effects, or caller guidance that the symbol itself does not express. Remove empty JSDoc blocks and comments that add no information.

### Do not use a comment as a parking place for abandoned code

Remove commented-out code. Put deferred work in an issue or task record when it needs to persist. Keep a TODO only when its task and context remain current and actionable.

### Keep the project voice out of marketing copy

Technical comments should not use slogans, inflated claims, all-capitals emphasis, or decorative excitement. User-facing guides can address the reader directly and use a warmer cadence. They still need accurate claims, concrete examples, and clear instructions.

## Choose detail by purpose

Implementation comments explain behavior that the code does not make obvious. API documentation explains caller-visible behavior and constraints. Test comments explain the failure mode an assertion can detect. Tutorials and guides can tell a story and address the reader, while keeping each step and claim clear.

Do not force all comments into one sentence or one register. Use as much detail as the mechanism requires. When a sentence begins to collect another operation and its consequence, end the sentence and give the next step its own subject and verb.

## Review questions

Before keeping or adding a comment, ask:

- Does it explain something a reader cannot infer from the code or the symbol name?
- Does it identify the operation, constraint, or behavior directly?
- Does each sentence finish one thought before another causal step begins?
- Does a test comment describe what the test can distinguish?
- Does API documentation tell the caller what matters for correct use?
- Will this explanation remain useful to a reader who never saw the current change?
