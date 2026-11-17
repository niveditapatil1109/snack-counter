# Code Walkthrough

Read this next to the code. Each section names a file, lists line ranges (`file:line`), and explains **what** each part does and **why** it was written that way. The final sections cover how the tests prove the rules, likely interview questions, and a 10-minute presentation script.

---

## 0. Reading order

Read the files in this order. Each one only depends on files above it.

| # | File | One-line purpose |
|---|------|------------------|
| 1 | `src/config.js` | Offices, budgets and timing rules: the "knobs" |
| 2 | `src/domain/errors.js` | Named errors the bot can turn into friendly messages |
| 3 | `src/domain/money.js` | Exact money, one currency at a time |
| 4 | `src/domain/time.js` | "What day/month is it **in that office**?" |
| 5 | `src/domain/refill.js` | The state machine: the heart of the design |
| 6 | `src/domain/assignmentPolicy.js` | Who buys next (pure function) |
| 7 | `src/domain/budget.js` | Remaining budget and the cap (pure functions) |
| 8 | `src/ports.js` | The contracts for chat, HR and clock |
| 9 | `src/adapters/*` | Store, fake chat, fake HR, clocks |
| 10 | `src/services/refillService.js` | The lifecycle, step by step |
| 11 | `src/services/claimsService.js` | HR submission, retry, status tracking |
| 12 | `src/services/volunteerService.js` | Holidays and visits |
| 13 | `src/services/reportService.js` | Monthly report |
| 14 | `src/app.js` | Wires it all together |
| 15 | `demo.js`, `test/*` | See it run, and see the rules proven |

---

## 1. The big picture in one minute

```
            Chat tool                                   HR system
               │                                            │
         ChatPort (fake)                             HrPort (fake)
               │                                            │
   ┌───────────▼────────────── services/ ───────────────────▼────────┐
   │  RefillService  ──receipt──►  ClaimsService                     │
   │  VolunteerService             ReportService                     │
   └───────────┬─────────────────────────────────────────────────────┘
               │ calls pure functions
   ┌───────────▼────────────── domain/ ──────────────────────────────┐
   │  refill.js (state machine)  assignmentPolicy.js  budget.js      │
   │  money.js  time.js  errors.js                    no I/O at all  │
   └───────────┬─────────────────────────────────────────────────────┘
               │
         Store (InMemoryStore now, Postgres later) + Clock
```

The architecture is called **ports and adapters** (or *hexagonal*). Its three ideas:
1. **Domain** (`src/domain`) holds the rules and is *pure*: no database, no chat, no `Date.now()`. Pure code is easy to test and easy to explain.
2. **Services** (`src/services`) run the use cases: they read from the store, call domain functions, save, and send messages.
3. **Adapters** (`src/adapters`) are swappable plugs for the outside world. Tests use fakes. Production would plug in Slack, the real HR API and Postgres **without changing services or domain**.

### One request's journey: "/snack empty" in Oslo

1. Chat adapter receives `/snack empty`, then calls `refills.reportEmpty('OSL', 'ola')`.
2. `reportEmpty` checks the store for an open Oslo refill. If there isn't one, it creates `R-1` in state `REPORTED`.
3. `#offerToNextVolunteer` does two things:
   - runs the budget check (`checkBudget`),
   - picks a person (`pickBuyer`),
   then saves `R-1` as `OFFERED` and DMs that person.
4. Later, the person taps Accept, which calls `acceptRefill`. That saves `COMMITTED` and posts "Kari is refilling…" to the channel.
5. The person uploads the receipt, which calls `completeRefill`. That saves `REFILLED`, then `ClaimsService.submit` files the claim with HR and saves `CLAIM_SUBMITTED`.
6. The scheduler (`runScheduledJobs`) polls HR. On approval it saves `REIMBURSED` and DMs the buyer.

---

## 2. JavaScript concepts used (quick primer)

| Concept | Where | What to say if asked |
|---|---|---|
| ES modules (`import`/`export`) | everywhere, enabled by `"type": "module"` in `package.json` | "Standard JS modules, no build step." |
| `#private` fields/methods | `Money.#assertSameCurrency`, `RefillService.#offerToNextVolunteer` | "Truly private. They can't be called from outside the class, so the public API is exactly the use cases." |
| Spread to copy (`{ ...refill, ...changes }`) | `transition()` | "We never mutate a refill. We build a new object. That makes 'what changed' explicit and enables version checks." |
| `Object.freeze` | `Money`, `RefillState` | "Values can't be changed by accident." |
| `?.` and `??` | `r.purchase?.buyerId`, `[0]?.volunteer ?? null` | Optional chaining / default when null or undefined. |
| `a - b \|\| c - d` in `sort` | `rankCandidates` | "Compare by the first key; if equal (0), fall through to the next key." |
| `async`/`await` | services | "Chat and HR calls are I/O, so they're async. Domain code is sync." |

---

## 3. `src/config.js`: the knobs

- **`OFFICES` (lines 7–28).** Each office has an id, `currency`, IANA `timeZone`, `monthlyBudget`, `minPurchase`/`maxPurchase` and `adminId`.
  - *Why config and not code?* Adding a third office is one entry. No `if (office === 'Oslo')` anywhere.
  - `minPurchase`/`maxPurchase` come from the brief's "typical purchase" range. Max is the default spending cap. Min is the "is it even worth going to the shop?" threshold for the budget check.
  - Budgets are created with `Money.of(6000, 'NOK')`, so the currency travels with the number.
- **`RULES` (lines 31–39).** Every timing and fairness constant lives in one place, each with a comment. Tests override them, e.g. `setup({ rules: { maxDirectOffers: 0 } })`.
- **`MANAGEMENT_ID` (line 42).** The chat id that receives the monthly report.

---

## 4. `src/domain/errors.js`: named errors

- `DomainError` (base) sets `this.name` to the class name, so logs show `NotAllowedError: …` and not just `Error`.
- One class per *kind* of problem: `ValidationError` (bad input), `CurrencyMismatchError`, `NotFoundError`, `NotAllowedError` (wrong person), `RefillUnavailableError` (wrong state, e.g. already taken), `InvalidTransitionError` (illegal state move), `ConcurrentUpdateError` (optimistic-lock conflict).
- *Why?* A chat adapter can map each class to a friendly reply ("Someone else already took this refill"). Tests assert the **kind** of failure, not fragile message text.

---

## 5. `src/domain/money.js`: exact money

**The problem it solves:** in JavaScript `0.1 + 0.2 === 0.30000000000000004`. Money in floats drifts. Also, `1000 NOK + 1000 INR` is meaningless.

| Lines | What it does | Why |
|---|---|---|
| 10 | `class Money` | A *value object*: identified by its value, not an id |
| 11–21 | Constructor checks `minor` is an integer and `currency` is a 3-letter code, then `Object.freeze(this)` | Invalid money cannot exist. Frozen means immutable |
| 24–26 | `Money.of(1200, 'NOK')` turns major units into minor (`Math.round(major * 100)`) | Humans think in kroner. We store øre. `Math.round` absorbs float noise like `1200.1 * 100 = 120009.99…` |
| 28 | `Money.zero(currency)` | Starting value for sums |
| 32–40 | `plus` / `minus` return a **new** Money | Immutability: `a.plus(b)` never changes `a` |
| 42–55 | `isLessThan`, `isGreaterThan`, `min` | Comparisons used by the budget check |
| 61–63 | `convertTo(target, rate)` rounds **once** | Conversion is explicit and only used by the report |
| 69–71 | `toString()` gives `"1200.00 NOK"` | Used in chat messages |
| 73–80 | `#assertSameCurrency` throws `CurrencyMismatchError` | **This is the line that makes cross-currency bugs impossible.** Every `plus`/`minus`/compare goes through it |
| 84–86 | `sum(list, currency)` | Starts from `zero(currency)`, so an empty list sums to 0 in the right currency |

Both NOK and INR have 2 decimal places, so `× 100` is correct. A currency like JPY (0 decimals) would need an exponent table. That's a known, documented limit.

---

## 6. `src/domain/time.js`: dates in the office's timezone

- **`localDate(date, timeZone)` (lines 11–19)** uses `Intl.DateTimeFormat('en-CA', …)`. The `en-CA` locale formats as `YYYY-MM-DD`. *Why that format?* Such strings **sort correctly as plain strings**, so `from <= date && date <= to` works without date parsing.
- **`monthKey` (line 22)** is the first 7 characters, `'2026-11'`. This decides which month's budget a purchase counts against.
- *Why it matters:* 00:30 on 1 Dec in Bengaluru is still 30 Nov in UTC. Using UTC would put that purchase in the wrong month's budget. The test `spend lands in the month of the office timezone, not UTC` proves this.
- `addHours`, `addDays`, `hoursBetween` are plain millisecond arithmetic, so deadlines are simple `Date` comparisons.

---

## 7. `src/domain/refill.js`: the state machine

This is the most important file for the presentation.

| Lines | What | Why |
|---|---|---|
| 8–19 | `RefillState`: 10 named states, frozen, each with a comment | Code always uses `S.COMMITTED`, never a raw string. A typo like `S.COMITTED` is `undefined`, which no transition list allows, so it throws instead of quietly creating a new state. Freezing stops anyone adding or changing states at runtime |
| 29–40 | `ALLOWED_TRANSITIONS`: for each state, the list of states it may move to | **The whole lifecycle in 12 lines.** Anything not listed throws. For example, `REFILLED → REIMBURSED` (skipping HR) is impossible |
| 43 | `OPEN_STATES` | "The box is still empty." The rule *one open refill per office* is defined in terms of this set |
| 46 | `SPEND_STATES` | What counts as company spend. `CLAIM_REJECTED` is excluded because the company didn't pay |
| 49 | `UNPAID_STATES` | Bought but not yet reimbursed. The fairness ranking uses it |
| 51–53 | `isOpen`, `countsAsSpend`, `isUnpaid` | Readable helpers used across the code |
| 55–74 | `createRefill(...)` builds the initial record | Every field is listed with a comment. This *is* the data model. `version: 1` starts the optimistic-lock counter. `history` starts with the first event |
| 80–92 | `transition(refill, to, {at, by, note, changes})` | The **only** way a refill changes. Steps below |

**What `transition` does, statement by statement:**
- **Line 81.** `sameState` checks whether we are staying in the same state. Same-state moves are allowed for recording things, for example "offer passed from Anna to Bjørn" (`OFFERED → OFFERED`) or "HR was down, attempt 2" (`REFILLED → REFILLED`).
- **Lines 82–84.** If the move isn't in the table, throw `InvalidTransitionError`.
- **Lines 85–91.** Return a **new** object. The steps:
  1. copy the old fields (`...refill`),
  2. apply the changes (`...changes`),
  3. set the new `state`,
  4. bump `version` by 1,
  5. append a history entry `{at, from, to, by, note}`.
- *Why return a new object instead of mutating?*
  1. The store can compare the old version with the new one (optimistic lock, see §9).
  2. If saving fails, nothing in memory was half-changed.
  3. `history` gives a full audit trail for free. The demo prints it.

---

## 8. `src/domain/assignmentPolicy.js`: who buys

A **pure function**: data in, person out. It is the easiest file to unit test, and the easiest to change if management wants a different fairness rule.

| Lines | What | Why |
|---|---|---|
| 11–14 | `officeOn(volunteer, date)`: a visit covering `date` wins, otherwise the home office | Handles "employees sometimes visit the other office". A visitor is asked for the box they can actually reach |
| 16–18 | `isAway(volunteer, date)` | Holidays. Uses the sortable date strings from `time.js` |
| 21–34 | `eligibleVolunteers`: filters to active, at this office today, not away, not already tried, not busy | Line 22 computes *today in the office's timezone*. Line 24 builds `busyIds`: people currently asked for or buying another open refill. This only happens with visitors, but it prevents one person holding two refills |
| 37–46 | `fairnessStats`: per person, `unpaidRefills`, `recentRefills` (last 90 days), `lastRefillAt` | `Math.max(0, ...)` makes "never refilled" equal to 0, i.e. the oldest possible, so new volunteers go first |
| 55–68 | `rankCandidates`: map each person to stats, then sort | The sort chain `a - b \|\| …` means "compare by unpaid; if tied, by recent; if tied, by last refill; if tied, by id" |
| 70–72 | `pickBuyer`: the first ranked person, or `null` | `null` means nobody is available, and the service escalates |

**Why this order?**
1. **Unpaid first** directly answers "a few people … wait weeks to get their money back": nobody is asked to front money again while still out of pocket, if someone else can go.
2. **Recent count** spreads the work.
3. **Last refill** breaks ties fairly.
4. **id** makes the result deterministic, which makes the tests stable.

---

## 9. `src/domain/budget.js`: the budget check

| Lines | What | Why |
|---|---|---|
| 12–18 | `spentInMonth(office, refills, month)`: filter this office, keep spend states, keep this office-local month, sum amounts | Spend is **derived** from purchases every time. No separate running total that could drift out of sync |
| 20–23 | `remainingBudget`: monthly budget minus spent | Uses the office timezone for "this month" |
| 32–39 | `checkBudget` returns `{ remaining, canAfford, cap }` | `canAfford` is false when remaining is below the minimum useful purchase. `cap = min(maxPurchase, remaining)` |

**Key design point (comment at lines 25–31):** there's no "reservation" ledger. Because only one refill per office can be open, nobody else can spend the money between the offer and the receipt. The cap *is* the reservation. That's one fewer moving part to explain and test.

---

## 10. `src/ports.js`: contracts

The file holds no code, only JSDoc `@typedef`s describing what the services need:
- `ChatPort.sendDirect` / `postToChannel`,
- `HrPort.createClaim` (must honour `idempotencyKey`) / `getClaimStatus`,
- `Clock.now`.

*Why have it?* It's the answer to "how would you plug in Slack?": write a class with those two methods.

---

## 11. Adapters

### `src/adapters/inMemoryStore.js`: storage
- **Lines 30–36, `insertRefill`.** Refuses a second open refill for the same office. This is a safety net behind the check in `reportEmpty`. In Postgres it would be a **partial unique index** (comment at the top of the file).
- **Lines 49–58, `saveRefill`: the optimistic lock.** The new object carries `version N+1` (from `transition`). We save only if the stored one is still at `N`. If someone else saved in between, the stored version is already `N+1`, so we throw `ConcurrentUpdateError`. In SQL: `UPDATE refills SET … WHERE id = $1 AND version = $2`. Zero rows updated means you lost the race.
- **`structuredClone`** in the constructor means the store doesn't share objects with the caller's fixtures.

### `src/adapters/fakeChat.js`: simulated chat
- Records `{to, text}` for every message (`#record`, line 30). `messagesTo` / `lastMessageTo` (lines 22–28) let tests assert "Anna was told…".
- The optional `onMessage` callback lets the demo print messages live.

### `src/adapters/fakeHr.js`: simulated HR
- `createClaim` (line 19) validates the fields the brief lists (amount, currency inside `Money`, description, receipt image, employee id).
- **Idempotency (lines 26–28).** The same `idempotencyKey` returns the existing claim id. A retry after a timeout can never create two claims.
- `failNextRequests(n)` (line 15) simulates HR downtime. `approve` / `reject` (lines 42–48) simulate HR staff acting later.

### `src/adapters/clock.js`
- `systemClock` is for production. `FakeClock` (lines 12–26) lets tests call `advanceHours(25)` instead of waiting 25 hours. *This is why every service asks `this.clock.now()` instead of calling `new Date()`.*

---

## 12. `src/services/refillService.js`: the lifecycle

**The one rule to remember (comment, lines 18–22): change state first, then send messages.**

Node runs one piece of JavaScript at a time. Code between two `await`s cannot be interrupted by another request. So every method does **read → check → write with no `await` in between**, and only then `await`s chat messages. That makes each state change atomic on one server. The store's version check (§11) covers several servers.

### 12.1 `reportEmpty` (lines 38–68)
- **Line 44.** Is there already an open refill for this office?
- **Lines 45–59, yes.** Record the extra reporter and their "ran out" items with a same-state `transition`, save, and reply "already in progress". **No second refill, so no second buyer (problem P2).**
- **Lines 61–63, no.** Create the refill (`REPORTED`) and insert it.
- **Line 65.** `#offerToNextVolunteer` does the budget check and picks a person.
- **Line 66.** Tell the channel. This comes *after* the offer, following the "state first" rule.

### 12.2 `#offerToNextVolunteer` (lines 74–121): budget check + choose who buys
- **Lines 77–83.** Budget check *before* asking anyone to spend their own money. Not enough budget and no admin override means `#blockOnBudget`.
- **Line 84.** The cap: the override uses the typical max, otherwise `min(max, remaining)`.
- **Lines 87–97.** Only call `pickBuyer` while fewer than `maxDirectOffers` people have been tried. Otherwise `candidate = null`.
- **Lines 99–101.** No candidate means `#escalate`.
- **Lines 103–114.** Save as `OFFERED` with `assigneeId`, `cap` and `offerExpiresAt = now + 2h`. The note records *why* (e.g. "anna did not answer in time; offered to bjorn").
- **Lines 115–119.** DM the chosen person, with the budget stated up front.

### 12.3 `#blockOnBudget` (lines 123–138) and `#escalate` (lines 140–158)
- Blocked: nobody is asked. The admin gets a DM with the remaining amount and the options.
- Escalated: the cap is still set, `assigneeId` is cleared, "Help wanted, first to accept gets it" goes to the channel, and the admin is pinged.

### 12.4 `acceptRefill` (lines 164–199): "two people cannot both commit"
- **Lines 168–170.** If it's `OFFERED` to someone else: `NotAllowedError`.
- **Lines 171–173.** If it's in any state other than `OFFERED`/`ESCALATED` (e.g. already `COMMITTED`): `RefillUnavailableError`.
- **Line 174.** The person must be an active volunteer.
- **Lines 179–190.** Save as `COMMITTED` with `purchaseDueAt = now + 24h`.
- **Why exactly one wins.** Two people tap "Accept" on an escalated refill at the same moment:
  1. The first call runs lines 165–190 without pausing and saves `COMMITTED`.
  2. The second call then reads `COMMITTED` and fails at line 171.
  3. On multiple servers, the second save would carry a stale version and fail in `saveRefill`.

  The test `two simultaneous accepts produce exactly one buyer` proves this.
- **Lines 193–197.** Confirm to the buyer, then tell the channel "nobody else needs to buy" (P2).

### 12.5 `declineRefill` (lines 201–209)
- Only the current assignee can decline. `#passToNextVolunteer` adds them to `triedIds` and offers to the next person.

### 12.6 `checkTimeouts` (lines 216–238): handover when nobody completes
- Called by the scheduler. **Deadlines are data on the refill, not `setTimeout`s.** A server restart loses nothing, and the job can run late or twice safely.
- **Line 220.** Re-read each refill, because earlier iterations `await`ed and the data may have changed.
- **Lines 222–224.** Offer expired: pass to the next person, and tell the old one "nothing to do".
- **Lines 225–231.** Commitment expired with no receipt: pass on, and tell the old buyer **"please do NOT buy"** (P2).
- **Lines 233–236.** If an accept slipped in at the same moment, `ConcurrentUpdateError` is ignored: their write won, and the next run re-checks.

### 12.7 `#passToNextVolunteer` (lines 241–243)
- Builds `{ ...refill, triedIds: [...triedIds, assigneeId] }` and offers again. Because `triedIds` grows, **nobody is asked twice for the same refill**, and after 3 the refill escalates.

### 12.8 `completeRefill` (lines 249–294): receipt uploaded
- **Lines 254–256.** Only the current `COMMITTED` buyer can complete. A buyer who was released can't, so two purchases can't both go through the bot.
- **Lines 257–265.** Validation:
  1. the amount is a positive `Money`,
  2. the **currency matches the counter's** (an Oslo refill must be in NOK),
  3. a receipt image is present.
- **Lines 269–270.** Overspend check with 10% tolerance. Flagged, **not blocked**: the volunteer already paid.
- **Lines 272–283.** Save as `REFILLED` with the `purchase` and an empty `claim` record.
- **Lines 285–293.** Thank them in the channel, alert the admin if over the cap, and hand off to `claims.submit` straight away (P3: no "I'll file it later").

### 12.9 Admin actions (lines 300–327)
- `approveOverBudget`: admin only, must be `BLOCKED_BUDGET`. Sets `budgetOverride: true` and offers.
- `cancelRefill`: admin only, refill must be open. Tells the current assignee not to buy.

---

## 13. `src/services/claimsService.js`: getting people paid

### `submit(refill)` (lines 24–60)
- **Lines 29–36.** Call HR with:
  - **`idempotencyKey: refill.id`.** One refill always means one claim, however many retries.
  - `employeeId` = the buyer. That might be a visitor; HR pays them in *their* payroll currency.
  - `amount` in the receipt currency.
  - A description with the refill id, office and items.
- **Lines 37–39.** If HR throws (down, timeout), `#recordFailedAttempt`. **It never throws to the user**: the box *is* refilled, and only the paperwork is pending.
- **Lines 41–43.** Re-read after the `await`. If another run already filed it, stop.
- **Lines 45–59.** Save `CLAIM_SUBMITTED` with the HR claim id, and DM the buyer.

### `#recordFailedAttempt` (lines 62–81)
- Stays in `REFILLED` (same-state transition, so it appears in history), increments `attempts`, stores `lastError`. On the last allowed attempt, it asks the admin to file by hand.

### `retryFailedSubmissions` (lines 84–91) and `syncStatuses` (lines 94–113)
- Scheduler jobs. `syncStatuses` polls HR for each `CLAIM_SUBMITTED`. `APPROVED` leads to `#markReimbursed`, `REJECTED` leads to `#markRejected` (buyer and admin told). Otherwise it calls `#nudgeIfSlow`.
- HR down during polling: `continue`, and try again next run.

### `#nudgeIfSlow` (lines 151–168)
- The brief says HR takes 1–10 days. After `claimNudgeAfterDays`, the admin is nudged **once** (`nudgedAt` prevents spam).

---

## 14. `src/services/volunteerService.js`

- `markAway(id, from, to)` (line 19) and `declareVisit(id, officeId, from, to)` (line 26) append periods. They validate the date format and that `from <= to` (`assertPeriod`, line 34).
- **Design decision (comment at the top): WFH is not tracked.** A one-tap Decline is cheaper than daily check-ins nobody would do.

---

## 15. `src/services/reportService.js`: the monthly report

- **Lines 31–34.** The rate for each office currency. The reporting currency itself is rate 1. **A missing rate throws**: a silently wrong total is worse than an error.
- **Lines 36–39.** Purchases in this month, in the office's timezone.
- **Lines 42–58.** Per-office figures:
  - spent / budget / remaining / % used,
  - the converted amount (**convert the total once, round once**),
  - refill count,
  - average hours the box was empty (`reportedAt → purchasedAt`),
  - over-cap count, awaiting reimbursement, rejected,
  - refills per volunteer,
  - top "ran out first" items. This answers "which snacks actually get eaten" cheaply, without inventory tracking.
- **Lines 61–70.** The total across offices in the reporting currency. `fxRates` is copied into the report, so it can be reproduced later.
- **`formatReport` (line 82)** is the plain-text version for chat. `sendMonthlyReport` (line 74) DMs it to management.

---

## 16. `src/app.js`: wiring

- **Lines 14–17.** Create the services and pass in their dependencies. `ClaimsService` is created first because `RefillService` needs it.
- **Lines 23–27, `runScheduledJobs`.** The three periodic jobs. In production, a cron or `setInterval` calls this every ~5 minutes.
- **Line 29.** Return the public API. Tests and the demo only ever touch this.

---

## 17. Tests: how the rules are proven

Run with `npm test`. That's 52 tests, ~150 ms, no network, using Node's built-in runner.

**`test/helpers.js`**
- `setup()` builds a fresh app with fakes and a `FakeClock` at Tue 10 Nov 2026, 09:00 Oslo. Options can override volunteers, rules or the start time.
- `DEFAULT_VOLUNTEERS`: with no history, ties break by id, so Oslo always asks anna, then bjorn, kari, lars. That makes expectations easy to read.
- `doRefill(ctx, office, amount)` runs report → accept → receipt in one line, for tests that need history.

| Rule from the brief | Test file → test name |
|---|---|
| Two people cannot both commit | `commit.test.js`: *two simultaneous accepts produce exactly one buyer*, *only the person who was offered…*, *store rejects a write based on an out-of-date read* |
| A refill nobody completes is handed to someone else | `handover.test.js`: *unanswered offer moves…*, *someone who said yes but never bought is released…*, *after three people pass… escalated* |
| Budgets and totals correct across both currencies | `budget.test.js`: *cap shrinks…*, *visitor spends Oslo NOK budget…*, *month of the office timezone*; `report.test.js`: *own currency and the total in the reporting currency*; `money.test.js`: *adding NOK to INR is refused* |
| Fair choice of buyer | `assignment.test.js`: fewest recent, unpaid-last, holiday, visitor, deterministic ties |
| Duplicate empty reports | `lifecycle.test.js`: *a second "empty" report joins the open refill* |
| HR unreliability | `claims.test.js`: retry until success with exactly one claim, idempotency, give-up + admin, rejected, nudge |

**How time is tested.** `clock.advanceHours(3); await app.runScheduledJobs();` simulates "3 hours later, the cron ran". No real waiting, no flaky timers.

---

## 18. Questions you may be asked (with answers)

**Why not just broadcast "who can refill?" and take the first answer?**
That's today's process and the cause of P1: everyone assumes someone else will answer. Asking one named person creates ownership. Broadcast is still used, but only as the escalation fallback.

**How do you guarantee two people can't commit?**
Three layers:
1. Only one open refill per office.
2. The accept checks the state and the assignee and writes, with no `await` in between, so it is atomic in Node.
3. The store's version compare-and-set rejects a stale write from another server.

**What if someone is working from home when asked?**
They tap Decline and the next person is asked instantly. Tracking WFH would need daily check-ins nobody would do. The 2-hour timeout covers people who don't answer at all.

**What if the released buyer already bought?**
They were told explicitly not to buy, and the bot no longer accepts their receipt for that refill. The admin handles that rare case by hand. Auto-accepting it would re-introduce double purchases.

**A Bengaluru employee refills Oslo. Which budget, which currency?**
Oslo's budget, in NOK, because budgets belong to the counter. The claim goes to HR in NOK with their employee id, and HR pays them in INR (their payroll currency). We never convert for reimbursement.

**Why integers for money?**
Floats can't represent 0.1 exactly. With integer øre/paise, sums are exact. Plus, `Money` refuses to mix currencies.

**How is the monthly total computed across currencies?**
Each office total stays in its own currency. It's converted once, using a rate passed in for that month, and the rate is stored in the report so the numbers can be reproduced.

**What happens if HR is down?**
The refill stays `REFILLED` with the error recorded. The scheduler retries. The idempotency key means a retry can never create a second claim. After 5 failures, the admin files it by hand.

**What happens if the server restarts?**
Nothing is lost. Deadlines are fields on the refill (`offerExpiresAt`, `purchaseDueAt`), not in-memory timers. The next scheduler run picks everything up.

**How would this scale / go to production?**
- Slack adapter + HR client + Postgres store. The services don't change.
- The store's methods map 1:1 to SQL (`UPDATE … WHERE version = $n`, plus a partial unique index).
- A third office is one config entry.
- Fairness is a pure function you can swap.

**What would you build next?**
1. A working-hours calendar per office, so offers don't expire overnight.
2. Exponential backoff for HR retries.
3. A real Slack adapter with buttons.
4. The Postgres store.

**What is out of scope, and why?**
The rule: build something only if it fixes one of the four problems, or is needed to make that fix reliable. Examples:
- **Sensors:** someone still has to refill the box.
- **OCR:** typing one amount is faster than checking OCR output.
- **Company card:** a finance decision, not automation.
- **Payroll conversion:** HR's job.
- **A second approval step:** it would slow reimbursement.
- **Voting or stock tracking:** doesn't fix any of the four problems.
- **Dashboard:** everyone is in chat already.

The full table is under "Out of scope" in `DESIGN.md`.

---

## 19. A 10-minute presentation script

1. **(1 min) Framing.** "Buying stays human. I automated the coordination. Four problems: empty for days, double buying, unfair load and slow money, no visibility."
2. **(2 min) Lifecycle.** Show the state diagram in `DESIGN.md`, then `ALLOWED_TRANSITIONS` in `refill.js:29`. "Everything is in this table. Illegal moves throw. Every move goes to history."
3. **(2 min) Choosing who buys.** `assignmentPolicy.js:55`: unpaid first, then recent load, then last refill, then id. Mention visitors (`officeOn`) and holidays.
4. **(1.5 min) No double buying.** `reportEmpty` dedup (`refillService.js:44`), `acceptRefill` (`refillService.js:164`), and `saveRefill` version check (`inMemoryStore.js:49`).
5. **(1.5 min) Money.** `Money` and `#assertSameCurrency`. The counter owns the budget. Office-timezone month. Run the report test.
6. **(1 min) Run it.** `npm run demo`, then `npm test`.
7. **(1 min) Trade-offs and Out of scope**, from `DESIGN.md`. State the rule first, then give 2–3 examples.
