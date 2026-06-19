---
name: morning-shift
description: Operator returns from a night-shift handoff. Encodes the wrap of the previous autonomous session (stop crons, deliver chat morning summary, present PRs in merge order, surface deferred decisions) and the kickoff of the day's collaborative work (read postmortem, sync main, carry forward lessons, set today's task list). Use when the operator says "I have returned", "good morning", "let's wrap up the shift", or "starting a new shift to close off the previous".
---

# Morning Shift Skill

The dual to `night-shift`. Two modes; usually run back-to-back: WRAP closes the
autonomous session cleanly, then KICKOFF starts the day's collaborative work.

## When to use

- Operator returns with any of: "I have returned", "good morning", "let's wrap up the shift", "we're starting a new shift to close off the previous", "what have you been doing".
- A scheduled night-shift cron is still running and needs to be stopped.
- A night-shift postmortem exists at `docs/articles/evals/YYYY-MM-DD-night-N-postmortem.md` and the operator hasn't merged the PRs yet.
- Day's work is about to start — task list needs to flip from "produce while you sleep" to "collaborate while you're at the keyboard."

## When NOT to use

- Operator is mid-collaboration (no prior autonomous session to wrap). Use normal mode.
- Routine session start with no prior night shift. Skip WRAP, skim KICKOFF, proceed.
- Operator is signing off (going TO sleep, not waking from it). That's `night-shift`.

---

## Mode A — WRAP the previous shift

Run these in order. Don't skip; each one closes a specific loose end.

### 1. Stop the hourly cron immediately

The night-shift skill arms a recurring `ScheduleWakeup` that re-arms itself every
hour. If you don't stop it, it will fire mid-conversation and re-trigger the
night-shift posture while the operator is at the keyboard.

```
CronList     → identify the night-shift checkpoint job
CronDelete   → cancel it
```

Confirm in chat: "Cron stopped — the shift is formally closed."

### 2. Pull a fresh status snapshot

Don't recite stale numbers. One bash call, parallel where it fits:

```bash
cd /home/lab/Projects/mailwoman
date -u +"%H:%M UTC"
echo "=== my open PRs ==="
gh pr list --author "@me" --state open --json number,title -q '.[] | "#\(.number) \(.title)"' | head
echo "=== CI rollup ==="
for pr in $(gh pr list --author "@me" --state open --json number -q '.[].number'); do
  echo -n "#$pr:"; gh pr checks $pr 2>&1 | awk '{printf " "$1":"$2}'; echo
done
echo "=== modal / heat / disk ==="
modal app list 2>&1 | grep -c running | sed 's/^/modal-running: /'
sensors 2>/dev/null | grep -iE "Tctl|Package" | head -1
df -h /home /mnt/playpen | tail -3
```

If any PR shows `test:fail` or main CI is red, **flag it in the morning summary
under "needs eyes-on" — don't bury it.**

### 3. Deliver the morning summary in chat

Order matters. Lead with what the operator must act on, not with what shipped.
The night-shift `Operator handoff format` is the authoritative spec; the
shorthand:

```
## 🌅 Morning summary — night-N (YYYY-MM-DD)

**Needs your eyes (priority order):**
1. <merge wall: PR #XXX → #YYY in this order; #XXX un-reds main first>
2. <decision deferred: e.g. promote v0.9.8-affix? — gate context here>
3. <regression / open NaN / open question>

**What changed in production:**
- HF default: <unchanged / v4.X.Y>
- Demo: <unchanged / version>
- npm: <unchanged / version>

**Numbers (one line):**
~$X of $20 Modal, N models trained, 0 NaN, 0 CI failures, 0 regressions shipped.

**Detail:** docs/articles/evals/YYYY-MM-DD-night-N-postmortem.md
```

Three habits that make this land:

- **Headline result goes in line 1, not paragraph 4.** If the win is region p90
  2763km → 10km, lead with that under the relevant `needs your eyes` item.
- **Empty rows are fine.** "Production: unchanged" is a complete answer.
- **No filler.** "Standing by for the next checkpoint" was a night-shift artifact;
  the operator is here now, the next message will tell you what to do.

### 4. Finalize the postmortem timestamps

The committed postmortem is a "living document" during the shift. At wrap:

```bash
# Replace "Living document — sketched during the shift, finalized at hand-off (15:00 UTC)."
# with the actual times worked: "Drafted during the shift; finalized at hand-off. Window: HH:MM–HH:MM UTC."
```

Add the final numbers row to the bottom table (GPU lost to error if any, total
Modal $, regressions shipped = 0).

If the night-shift had a fork sent for operator review (e.g. ship / escalate /
hold), make sure the doc's `Open / next` section names that decision explicitly.
The morning conversation is where it gets resolved; the doc should be the
artifact the operator can re-read in a week and understand the call.

### 5. Sync the in-memory MEMORY.md to match wrap state

If a top-of-MEMORY entry was marked `IN-FLIGHT` or `⏯`, flip it to `STOPPED` /
`⏸` / `RESOLVED` per the actual outcome. The next session that starts before
the operator finishes a decision should land in the right state, not a stale
"still training" state.

```bash
$EDITOR /home/lab/.claude/projects/-home-lab-Projects-mailwoman/memory/MEMORY.md
# Update the top entry's icon + description.
```

### 6. Stand down

Once the chat summary is delivered and the doc + memory are in sync, that's it.
Don't pile on follow-up paragraphs ("Standing by", "Let me know"). The operator
will direct the day; the next user message is the kickoff.

---

## Mode B — KICKOFF the day's work

Triggered by the operator's first directive after the wrap. Common shapes:

- "Sounds good. Let's wrap up the shift and do <thing>" → blog / merge / next feature
- "Merge and let's talk about next steps for today" → merge PRs in stated order, then collaborate
- "We're starting a new shift so we can close off the previous and getting started now" → close = WRAP done, get started = KICKOFF

### 1. Merge the night's PRs in the stated order

If the operator authorized merging in the morning summary or follow-up:

```bash
cd /home/lab/Projects/mailwoman
# Verify mergeability + CI for each PR:
gh pr view <N> --json mergeable,mergeStateStatus -q '.title+" | mergeable="+.mergeable+" state="+.mergeStateStatus'
gh pr checks <N> 2>&1 | head -4
# Then merge (squash unless the PR is explicitly a feature branch wanting history):
gh pr merge <N> --squash --delete-branch
# Verify on main:
git fetch origin && git log origin/main --oneline -3
```

Merge in the order the postmortem stated (usually: main-fixer first, then docs,
then code, then experimental PRs). If a merge breaks main, **stop the loop and
flag it** — don't keep merging the rest in the hope they'll fix it.

### 2. Pull the postmortem's lessons into the day's posture

Before launching today's work, read three things in this order:

1. **The chat morning summary you just sent** — these are the decisions on the table.
2. **`docs/articles/evals/YYYY-MM-DD-night-N-postmortem.md`** — the "What could've gone better" section. These are the patterns today should avoid.
3. **`/home/lab/.claude/projects/-home-lab-Projects-mailwoman/memory/MEMORY.md`** top entries — these are the live constraints (treadmill stops, ship/hold decisions, gate states).

If any of those three contradicts what the operator just asked for, **surface
the contradiction now, not 3 hours into the work.** Example:

> "The postmortem flagged the affix split has a stability ceiling at 29M params.
> You're asking me to push the affix recipe further — that's exactly the
> treadmill the night-shift stopped at. Want to confirm we're escalating
> (option 2: wider model / dedicated head), not iterating?"

### 3. Reset the task list for collaboration mode

Night-shift task lists optimize for "produce in parallel while operator sleeps."
Day task lists optimize for "one focused thread at a time, operator approves
each step." Reset:

- Archive the night-shift checkpoint tasks (the hourly "post a progress report" entries).
- Promote night-shift `Open / next` items to today's tasks in priority order.
- Add one top task: **"Resolve <the fork decision from last night>"** if there is one.

### 4. Drop the night-shift posture

The autonomous-session disciplines are designed for an operator-absent context.
Some of them get in the way when the operator is at the keyboard:

| Posture      | Night                              | Day                                                                         |
| ------------ | ---------------------------------- | --------------------------------------------------------------------------- |
| Default      | "default to action"                | "default to surfacing the choice"                                           |
| Wakeups      | hourly recurring                   | none; respond to operator turns                                             |
| DeepSeek     | consult freely on forks            | consult only when operator asks or the fork is bigger than the conversation |
| Merging      | self-merge if green + authorized   | operator merges unless they've said otherwise                               |
| PR scope     | "open, ready-to-merge" is the unit | normal PR cadence                                                           |
| Chat density | scarce + high-signal               | normal conversation                                                         |

If the operator hands the conn again ("I'll be afk for an hour, keep going"),
flip back to night-shift posture for that window — but the explicit handoff is
the trigger, not the wall-clock time.

### 5. Carry forward the integrity guardrails

These survive both modes — they're not posture, they're project rules:

- **No silent gate drift** — the postmortem table cites config bars verbatim above any scorecard.
- **Diagnostic before fix** — even in day-mode collaboration, a 30+ min GPU action gets a 2k-step probe first.
- **Resume vs init_from** — never `init_from` to continue a capability still being grown.
- **Salvage-first** — check isp-nexus + mailwoman before writing new modules.
- **Sequential mutating ops** — never parallel git/gh/npm batches (compaction-fabrication risk).
- **Verify every remote mutation** — `git ls-remote origin`, `gh pr view`, `npm view`.
- **DeepSeek calibration** — trust structure, test numbers; log the scoreboard line per consult.

---

## Edge cases

### Operator returned mid-shift, not at the planned wrap

If the operator returns before the planned 15:00 UTC hand-off (or whatever the
shift end was), do WRAP steps 1, 2, 3, then ask whether to continue the shift
or close it now. Don't unilaterally extend or shorten; the operator's return is
itself a context shift that wants their input.

### Multiple postmortems exist for "last night"

If `docs/articles/evals/` has two postmortems with the same date (e.g. one was
amended after a restart), the most recently-touched one is canonical. The
earlier file should be marked superseded in its own header; if it isn't, do
that as part of WRAP step 4.

### No postmortem exists

The night-shift skill says "Don't write this at the end as an afterthought —
sketch it as you go." If there's no draft, that's a process failure to flag.
Write a stub now (what shipped, what's open, what's unknown) and own the gap
in the morning summary explicitly: "No postmortem was sketched during the
shift — this stub is what I can reconstruct."

### The chat morning summary was already delivered

If the night-shift handed off cleanly and the morning summary is already in
chat, WRAP step 3 is "confirm it's accurate against the fresh snapshot (step
2), correct any stale numbers, then proceed." Don't re-deliver a full summary.

### The operator asks "what did you do last night?"

This is the same trigger as "I have returned" — go through WRAP. The question
is asking for the morning summary, just phrased differently.
