# Writing a realistic thread (rules for authors)

A thread file is `threads/<ID>.json` in the format of `schema.ts`. Write the deal **as a script first**
(what each party says, when, and what changes), then write the emails in the style of `STYLE.md`, then
write the checkpoints. Run `node eval/realistic/validate.ts threads/<ID>.json` until it passes.

## Setup

- All names, companies and addresses are fictional; use `.example` domains for other parties and a
  `*.primitive.email` address for `self_address`. Dates are in Oct–Dec 2026, arrival times strictly
  increasing, ISO UTC (`2026-10-19T14:05:00Z`).
- `task` is a Continuity TaskSpec. Copy the shape of the examples below; keep the same requirement keys.
  - **Procurement:** self (`role: "self"`, `authority: ["decision."]`), supplier (`role: "counterparty"`,
    `authority: ["price.", "delivery.", "order.", "payment.", "quote.", "offer."]`, `group: "<supplier>"`),
    finance (`role: "internal"`, `authority: ["budget."]`). Optional: a second supplier contact in the same
    `group` (for contested values), an internal colleague with `authority: []`. Requirements:
    `requirement.quantity` (number), `requirement.deliver_all_by` (date), `requirement.max_unit_price`
    (money), each with a `display` and `hard: true`.
  - **Real estate:** self (`authority: ["decision.", "deal."]`), listing agent (`counterparty`,
    `authority: ["price.", "closing.", "contingency.", "decision.", "deal."]`, `group: "seller"`), buyer
    (`internal`, `["budget."]`), lender (`internal`, `["appraisal."]`), inspector (`internal`,
    `["inspection."]`), title company (`internal`, `["payment."]`). Optional: seller's attorney in `group:
    "seller"` (contested). Requirements: `requirement.max_price`, `requirement.close_by`,
    `requirement.opening_offer` (`hard: false`).
- Include our own outbound emails (`direction: "outbound"`, from `self_address`): they are part of the
  history the engine reads. Inbound mail is addressed `to` the self address.
- `in_reply_to` threads replies; leave it `null` for mail that starts a new thread (subject drift).
- Attachments are text lines (they become a PDF): `{ "filename": "Quote-Q-118-rev2.pdf", "lines": […] }`.

## What the gold must say (Continuity's rules, applied by a careful human)

The checkpoints state the **correct** state after the named message, by these rules:

0. **Complete.** `active` lists *every* domain term the visible messages state and that applies — including
   terms stated only in an attachment line ("Quantity: 1,200 units", "Valid until …") — not only the ones the
   story is about. A term the engine applies that the gold leaves out counts as an engine error.

1. **Terms are per speaker.** A later statement by the same speaker replaces their earlier value
   (list the old one under `superseded` with `replaced_in`). Order is arrival order.
2. **Only what a message itself says counts.** Values repeated in quoted history are not new
   statements. The `evidence` you cite must be in the message's new text (above the quote) or in its
   attachment — the validator enforces this.
3. **Same side, different values → contested.** Two speakers in the same `group` stating different values
   for the same term: both go under `contested`, neither is active.
4. **Not applied (→ `tentative`)**: hedged statements (`hedged`); a speaker without authority for the term,
   e.g. the supplier saying the budget is approved, finance stating a delivery date (`not_authoritative`);
   mail that fails authentication (`auth: "spoofed"` on the message → `unauthenticated`); a forwarded copy
   of an older offer that arrives after a newer one (`stale_forward`); money details (below).
5. **Money details are held for a human:** procurement `payment.terms` when it **changes**; real-estate
   `payment.wire_instructions` **always** → `tentative` with `held_for_verification`.
6. **Questions never become facts.** "Can you do $11.20?" states nothing.
7. **Units matter.** `price.unit` is per unit only — never a total. Deal numbers, phone numbers, ticket
   numbers, deposits and credits are not terms.
8. **Obligations:** a question or request we send creates one owed by the recipient; "I'll send …"
   creates a commitment owed by the speaker. A question is `answered` when its recipient later addresses
   it; a promise to send a document is `fulfilled` only when a message with that attachment arrives
   ("attached" with no attachment does not count). Unanswered ones stay `open`.
9. **Documents:** an attachment is `current`; `superseded` once a newer version of the same kind arrives
   from the same party; `partially_stale` when one of the terms it states was later replaced.
10. **Checks** (optional): `delivery_deadline`, `quantity`, `price_budget`, `budget_approval` (procurement);
    `price_budget`, `closing_deadline`, `appraisal_gap`, `price_approval` (real estate) → pass / fail / unknown.
11. **next_actor:** `us` when we must act (a requirement fails and we have not raised it since, we owe an
    answer, everything passes and we should accept); `them` when we are waiting on someone; `none` when
    the deal is closed or dead.
12. **Normalized values:** money and numbers as JSON numbers (`11.4`, `845000`); dates `"YYYY-MM-DD"`;
    `delivery.schedule` as `[{"qty": 300, "date": "2026-10-23"}]` (the speaker's full resulting schedule);
    text as written (`"Net 45"`); `offer.status` `"withdrawn"`; acceptance `"accepted"`.

Put 2–3 checkpoints in each thread: at least one in the middle (after a change) and one at the end. Give
the key checkpoint a `handoff`: what a fresh agent should do, with `must` / `must_not` as case-insensitive
regular expressions over its email (e.g. `"oct(ober)?\\.? ?23"`, `"\\$?11\\.48"`).

## Realism checklist (each thread)

- 5–12 messages, at least two from the other side, at least one carrying nested quoted history.
- Each assigned feature is really exercised — the hard case must be in the text, not just in the notes.
- Some distractor numbers. Some terse or lowercase writing.
- Every gold term cites exact words from its message (copy them).
