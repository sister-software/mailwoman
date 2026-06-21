---
name: de-slop
description: >
  Detect and remove "LLM smells" (AI-slop tells) from any text or document.
  Use this whenever you are (a) generating prose, documentation, emails, posts,
  marketing copy, READMEs, comments, or any human-facing text, or (b) asked to
  review, edit, or critique a document. Workflow: draft normally, then audit the
  draft against the checklists below, then rewrite to remove every flagged item.
  The goal is output that does not read as machine-generated.
---

# De-Slop: Remove LLM Smells from Text

## Purpose

AI-generated text has recognizable fingerprints ("smells"). Readers increasingly
spot them, and they make writing feel hollow, salesy, and machine-made. This skill
makes you eliminate those fingerprints from anything you write or review.

## When to invoke

- You are about to produce any human-facing text (prose, docs, emails, posts, commit
  messages, PR descriptions, comments, copy).
- You are asked to review / edit / critique a document.
  \

## Core workflow (always follow in order)

1. **Draft.** Write the content normally to get the ideas down.
2. **Audit.** Go through every checklist in this file line by line against your draft.
   Mark each hit.
3. **Rewrite, don't patch.** For each hit, rewrite the underlying sentence/thought.
   Do not just swap a banned word for a synonym — that leaves the same rhythm and
   structure, which is itself a tell. Re-express the idea plainly.
4. **Verify.** Re-run the audit on the rewritten text. Repeat until zero hits.
5. **Report (review mode).** When reviewing someone else's document, list each smell
   found with its location, why it's a smell, and a concrete fixed version.

### Hard rules

- **Never** introduce fake typos, grammar errors, or deliberately "dumbed-down"
  phrasing to look human. Fix the smell, keep the quality.
- **Never** keep a sentence just because it "sounds good." Sounding polished in
  isolation is exactly how slop accumulates.
- Prefer cutting over rewording. If a sentence only adds rhythm or emphasis and no
  information, delete it.
- Default to plain words. If a 50-cent word isn't more precise than a plain one, use
  the plain one.
- Match the voice already present in the document or the user's own writing if a
  sample exists. Do not impose a generic "polished" register.

---

## CHECKLIST A — Banned / flag-on-sight words & phrases

Each of these is a strong tell. Flag every occurrence. Remove or replace by rewriting
the sentence. (A word being legitimately useful sometimes does NOT excuse its
high-frequency AI usage — check that you actually need it.)

### Filler intensifiers used to prop up weak claims

- "genuinely", "truly", "really" (as in "what really matters")
- "honest" / "honestly", "genuine", "actual" / "actually", "real" (as in "a real X"),
  "straight" — the honest/genuine/actual/real cluster
- "simply", "just" (as a softener), "cleanly", "quietly", "seamlessly", "effortlessly"

### Overused metaphors / jargon (figurative use)

- "load bearing" (unless literally structural)
- "blast radius" (unless literally explosive)
- "escape hatch"
- "smoke test" (use "sanity check" or just say what you mean)
- "the spine of", "the backbone of"
- "substrate"
- "seam" / "seams", "shape of" / "the shape of things" (figurative)
- "threading X through Y"
- "canonical", "normalized" (when not technically precise)
- "north star", "first-class citizen", "source of truth" (when overused)

### Stock phrases / framing devices

- "It's not just X, it's Y" / "not merely X but Y" (contrastive negation — see B1)
- "less about X, more about Y"
- "X is the Y of Z"
- "The uncomfortable truth (is)..."
- "And this is what most people miss:"
- "Here's the thing:"
- "The thing to internalize:"
- "The honest caveat:" / "The genuine answer:" / "The smoking gun:" (any "The [noun]:")
- "belt and suspenders" / "belt-and-braces"
- "inside baseball"
- "the quiet part said out loud" / "saying the quiet part out loud"
- "that holds" / "that tracks" / "that's real" (standalone affirmations)
- "Curious if anyone..." / "Would love to hear your thoughts" (engagement bait)
- "happy to help" / "happy to..." (especially with the subject dropped)
- "You're absolutely right" / "You are right to push back" (sycophantic openers)
- "at the end of the day", "when it comes to", "in today's world", "in an era of"
- "delve", "tapestry", "testament", "underscore", "leverage" (as a verb), "robust",
  "vibrant", "crucial", "pivotal", "realm", "landscape", "navigate" (figurative),
  "elevate", "unlock", "harness", "foster", "facilitate", "myriad", "plethora"

> Note: this list is not closed. Treat any word you find yourself reaching for
> repeatedly, or any phrase that sounds like marketing, as suspect.

---

## CHECKLIST B — Sentence & structure patterns

### B1. Contrastive negation ("It's not X, it's Y")

Denying one thing to assert another, especially when X was never in question.

- Smell: "This isn't about speed. It's about trust."
- Also: "not just X, but Y", "X is not B, instead A is...", introducing a topic by
  what it is NOT before saying what it IS.
- Fix: state the positive claim directly. "This builds trust."

### B2. Triple / staccato negation

"Not this. Not that. Not that either."

- Fix: say what the thing _is_ in one sentence, or list the exclusions plainly.

### B3. Jab-jab-thrust rhythm (lists of three)

Two short punches then a longer assertion: "Smooth. Effortless. A perfect fit."

- Also: lists of three adjectives/clauses where the third just combines the first two.
- Fix: keep one precise descriptor; drop the rhythmic padding.

### B4. Too many punchlines / aphorisms

Every paragraph ending on a quotable, profound-sounding one-liner.

- Smell: "Symmetry becomes a trap." / "The map was never the territory."
- Fix: most paragraphs should end on a normal, informative sentence. Cut manufactured
  profundity.

### B5. Manufactured-cadence short sentences

Strings of clipped sentences for drama: "Then it arrived. It had no preference. No
prior. No instinct." Reads like an ad.

- Fix: combine into natural sentences with real connective tissue.

### B6. "X is the Y of Z" analogies

Cute equivalences that sound clever and say little.

- Fix: explain the actual relationship plainly, or cut.

### B7. The LinkedIn dramatic break

"just .\n\nAnd it changes everything." — single word/clause, big white space, grand claim.

- Fix: delete the drama; make the claim only if you can substantiate it.

### B8. Sells like an Apple product page

Punchy declaratives that market rather than inform.

- Fix: switch to neutral, informative register unless the brief is explicitly ad copy.

### B9. "The" in front of headers

Headers like "The Architecture", "The Caveats", "The Fixes".

- Fix: drop the article — "Architecture", "Caveats", "Fixes".

---

## CHECKLIST C — Tone & voice

- **Sycophancy:** validating the reader before responding, agreeing reflexively,
  over-praising. Cut openers like "Great question", "You're absolutely right".
- **Saccharine / hollow warmth:** generically heartfelt language with no specifics.
  Replace with concrete detail or remove.
- **Corpo-speak inflation:** turning a simple message into bloated corporate prose.
  Say it in fewer, plainer words.
- **No-information padding:** sentences that only restate the previous one, hedge, or
  set up the "real" point. Delete them.
- **Expansion bias:** LLMs lengthen; they rarely tighten. After drafting, aggressively
  cut. Shorter is almost always more human.
- **Uniform paragraph shape:** every paragraph the same length with a topic sentence +
  three supports + a kicker. Vary structure; let some thoughts be one line.

---

## CHECKLIST D — Punctuation & typography

- **Em-dashes (—):** the single most recognized tell. Avoid for emphasis/asides; use a
  comma, period, parentheses, or colon. (Don't overcorrect into fake errors.)
- **Smart/curly quotes & apostrophes (’ “ ”)** auto-inserted where the surrounding text
  uses straight ASCII (' "). Match the document's existing convention.
- **Colon-led reveals:** "The smoking gun:", "The takeaway:" — see B/A.
- **Over-bolding / over-bulleting:** bolding key phrases in every paragraph and turning
  prose into bullet soup. Use lists only for genuinely enumerable items.
- **Emoji as decoration / section icons:** remove unless the medium clearly calls for it.
- **Italicized "Oh. _Oh._"** and similar staged reactions in anecdotes. Cut.

---

## CHECKLIST E — Document / formatting smells (review mode)

- Section headers that are all the same grammatical shape ("The X").
- Every section padded to equal length regardless of substance.
- Restating the same point in a heading, the first sentence, and a summary box.
- A "Conclusion/TL;DR" that merely repeats the intro.
- Tables or diagrams that encode nothing the sentence didn't already say.
- Numbered "steps" formatting applied to things that aren't sequential steps.

---

## CHECKLIST F — Code & code-comment smells (when text is code or about code)

- **Verbose, obvious comments** restating what the code plainly does. Keep comments for
  _why_, not _what_.
- **Vertical-whitespace bloat** — exploding short function signatures across many lines
  for no reason; gratuitous blank lines. Keep it compact and consistent with the file.
- **Vocabulary tells in comments/docs:** "contract", "artifact", "load bearing",
  "blast radius", "escape hatch", "substrate", "the spine", "threading through".
- **Gratuitous "backwards-compatible" / "versioned" framing** on greenfield code.
- **Bespoke-everything:** reimplementing patterns that already exist in the codebase.
  Reuse existing patterns and naming.

---

## CHECKLIST G — Visual / web & image smells (when generating UI or describing images)

Flag and avoid defaulting to:

- **JetBrains Mono / Inter** as the reflexive font; identical type scales everywhere.
- **Purple/blue gradients**, blue-on-black, Tailwind "Slate" palette by default.
- **Generic card grids** (rounded corners + soft shadow + same padding) for everything.
- **"Step + bullet" landing-page layout** repeated for unrelated content.
- **Blinking-dot status badges**, KPI cards, dashboards crammed with figures that
  repeat the same number.
- **Oversized border radius** as a default.
- **Emoji used as icons** (also an accessibility problem).
- For generated images: uniform over-detail with no focal hierarchy, inconsistent
  perspective, the "filter-over-montage" look.

Principle: only deviate from clean defaults with intent. Legibility first, but don't
let "clean default" mean "the same template everyone's AI produced."

---

## Final verification pass (run before returning output)

Answer all of these "yes" before delivering:

1. Zero items from Checklist A remain (or each survivor is genuinely the most precise word and not propping up a weak claim).
2. No contrastive negation, triple negation, or jab-jab-thrust rhythm (B1–B3).
3. No manufactured punchlines or staccato drama (B4, B5, B7).
4. No em-dash-for-emphasis; quote/apostrophe style matches the document (D).
5. Tone is plain and specific, not sycophantic, saccharine, or corpo-inflated (C).
6. I cut length rather than added it; every sentence carries information.
7. (Review mode) I listed each smell with location + reason + concrete fix.

If any answer is "no", return to step 3 of the workflow.

---

## Important meta-warnings (from the source research)

- **Superficial word-swaps make it worse.** Models tend to keep the slop structure and
  just change vocabulary. Rewrite the thought, not the word.
- **Context style is contagious.** If the surrounding draft is sloppy, you'll keep
  matching it. Audit against this file, not against your own draft's vibe.
- **This list is descriptive, not exhaustive forever.** New tells emerge per model and
  over time. When something reads as "marketing", "profound for no reason", or
  "too smooth", treat it as a smell even if it's not listed here.
- **Don't fake humanity.** The fix is plainer, more specific, more informative writing —
  never injected errors.
