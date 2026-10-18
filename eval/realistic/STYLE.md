# How real business email reads (style guide for the realistic threads)

Distilled from a sample of real deal threads in the public Enron corpus (gas sales, nominations,
invoices, contract drafts, exchange deals; CMU 2015 release via Hugging Face `corbt/enron-emails`).
No real message text, names or numbers are copied into the threads: these are the **patterns**, to be
reproduced with fictional people, companies and values.

## Structure

- **Nested quoted history.** Most replies carry the whole earlier chain below the new text, Outlook style:

  ```
   -----Original Message-----
  From: 	Ruiz, Dana
  Sent:	Tuesday, October 20, 2026 10:12 AM
  To:	Procurement; Shah, Priya
  Cc:	Okafor, Ben
  Subject:	RE: RFQ 500 x AX-200

  <earlier text, which itself contains another -----Original Message----- block …>
  ```

  The quoted text keeps showing **old values** (the first price, the first date) in every later reply.
  Only the text above the first quote marker is the new statement.
- **Lotus Notes headers** also occur: `Vance Taylor/HOU/ECT@ECT on 04/24/2026 04:25 PM` on its own line,
  then `To:` / `cc:` / `Subject:` lines, then the quoted text.
- **Empty forwards.** `FW:` messages with no new text, only the forwarded chain; forwards to someone new
  with one line ("see below", "can you answer Darren's question?").
- **Subject drift.** `RE: RE: FW: …`, a reply under a new subject, a thread restarted with only the PO /
  property reference in the subject.

## Voice

- **Terse.** `done.`, `ditto.`, `ok - go ahead`, `see attached`, `thx`. Sign-offs by first name or initials
  (`D`, `vlt`), sometimes none.
- **Lowercase and shorthand.** `500 pcs fri`, `11.40/ea`, `10MM` (10,000), `5/4-6`, `wk of the 9th`,
  `noms`, `tix`, `asap`, `eod`.
- **Typos and slips.** `concern` for concerned, `than` for then, a transposed digit later corrected.
- **Hedges sit next to firm statements.** `should be able to do`, `at least 10,000 - 15,000`, `I think`,
  `pending mgmt ok`.

## How changes are said

Real corrections rarely say "correction". They look like:

- `Change the price on deal 157278 from $11.40 to $11.48.`
- `Nominations are being revised effective May 1:` followed by a small table with *Orig.* and *Rev.* columns.
- `the 5,000 for the 22nd is $2.985` (a value restated for one lot only).
- `should read $812,500, not $821,500` (a fix to a typo in an earlier email).
- `we did not ship any for the 8th-10th` (a partial update that removes lots).
- A changed value stated only in an attachment ("revised quote attached") or only in a table.

## Distractor numbers

Real threads are full of numbers that are not terms: deal and ticket numbers (`#639612`, `S#745589`),
meter numbers, phone numbers (`713-853-7177`), totals (`$5,740.00 total`), credits and deposits, account
codes, dates of past events, prices of other products. Each thread should include some.

## Tables

Tab- or space-aligned tables: `Counterparty  Meter #  Orig. Nom  Rev. Nom`, `Deal  Month  Change demand
fee from … to …`, line items with qty / unit / total.

## Noise

Out-of-office replies, "thanks" emails, a question about something unrelated, a cc'd person asking to be
taken off, a calendar logistics email in the same thread.
