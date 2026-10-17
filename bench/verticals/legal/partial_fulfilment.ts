// Archetype: partial fulfilment (P1).
//
// The agreement is signed by Acme. Vendor counsel commits to return countersigned signature pages for
// all N vendor entities that are party to it (the US parent plus its UK / German / Australian / Dutch
// affiliates) by a given day. On that day counsel sends k signed pages and says the remaining N−k will
// follow later (a director is travelling, a board resolution is pending). Acme's business owner needs
// the agreement fully executed before go-live.
//
// Trap: a commitment tracker that only knows "open" and "fulfilled" either closes the loop (pages
// arrived) or keeps the whole N-page promise open (as if nothing came), and a duplicate N-page loop is
// just as wrong. The oracle keeps ONE commitment open with a residual of N−k pages, the vendor side
// partially signed, the received pages current, and, when the new date is after go-live, a
// requirement violation and the ball in our court (chase the missing entity's page); otherwise we may
// simply acknowledge and wait.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleConflict, OracleDocument, OracleLoop } from '../../core/types.ts';
import { MailBuilder, Rand, addBusinessDays, addDays, body, sayDate, seedOf, staleText, type DateStyle } from '../../core/util.ts';
import { and, counselSig, firstName, later, legalBackground, legalCase, legalChatter, legalDayStart, legalDeal, ours, poss, sayFrom, shortName } from './vertical.ts';

export const partial_fulfilment: Archetype = {
  id: 'partial_fulfilment',
  title: 'Some affiliate signature pages arrive, the rest slip',
  capabilities: ['partial_fulfilment', 'open_loops'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('legal', 'partial_fulfilment', variant));
    const g = variant === 0;
    const d = legalDeal(r, variant);
    const { self, counsel, gc, owner } = d.cast;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => legalDayStart(d, day, hhmm);
    const ag = d.agreement.short;
    const co = d.company;

    // ---- parameters
    const affiliates = [`${d.vshort} UK Ltd`, `${d.vshort} Deutschland GmbH`, `${d.vshort} Australia Pty Ltd`, `${d.vshort} Netherlands B.V.`];
    const n = g ? 3 : r.pick([3, 3, 4, 5]);
    const entities = [`${co}, Inc.`, ...(g ? affiliates.slice(0, 2) : r.shuffle(affiliates).slice(0, n - 1))];
    const k = g ? 2 : r.int(1, n - 1);
    const received = entities.slice(0, k);
    const pending = entities.slice(k);
    const promiseDay = addDays(d.start, 2); // Wednesday
    const goLive = g ? addDays(d.start, 7) : addDays(d.start, r.pick([4, 7, 9])); // Fri, next Mon, next Wed
    const early = g ? false : r.chance(0.35); // the slip still lands before go-live
    const newDay = early ? addDays(promiseDay, 1) : g ? addDays(d.start, 8) : addBusinessDays(goLive, r.pick([1, 2, 3]));
    const late = newDay > goLive;
    const reason = g ? 'their authorised signatory is travelling' : r.pick(['their authorised signatory is travelling', 'a board resolution is needed first', 'the signatory is on leave this week', ...(pending.some((e) => e.includes('GmbH')) ? ['our German notary appointment moved'] : [])]);
    const reportInThread = g ? true : r.chance(0.6);
    const ownerCopied = g ? false : r.chance(0.4);
    const dateStyle: DateStyle = g ? 'weekday_short_date' : r.pick(['weekday', 'weekday_short_date', 'month_day', 'weekday_long'] as const);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 4);
    const execFile = `${d.vshort}-${ag.replace(/\s+/g, '')}-Execution-Version-Acme-signed.pdf`;
    const pageFile = (e: string) => `Signature page - ${e.replace(/\.$/, '')}.pdf`;
    const stop = (x: string) => (x.endsWith('.') ? x : `${x}.`);

    d.task = {
      ...d.task,
      goal: `${d.task.goal} The business owner needs the agreement fully executed by every party before go-live on ${sayDate(goLive, 'weekday_short_date')}.`,
      requirements: [...d.task.requirements, { key: 'requirement.fully_executed_by', value: goLive, display: `fully executed by ${sayDate(goLive, 'weekday_short_date')}`, hard: true }],
    };

    // ---- history
    const gcOk = mb.add({
      direction: 'inbound', from: gc.address, fromName: shortName(gc), to: [self.address], at: t(0, '08:40'),
      subject: `${d.alias} — signature approved`,
      body: body(r.pick([`The execution version of the ${co} ${ag} is approved for signature. I've signed for Acme; please send it over.`, `Signed for Acme. Go ahead and send the ${ag} to ${co} for countersignature.`, `Approved and signed on our side. Please get ${poss(co)} signatures.`]), firstName(gc)),
    });
    const send = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [counsel.address], cc: ownerCopied ? [owner.address] : undefined, at: t(0, '10:00'),
      subject: `${d.alias} — ${ag} for countersignature`,
      body: ours(firstName(counsel), `Attached is the execution version of the ${ag}, signed by Acme. Please return countersigned signature pages for all ${n} ${co} entities: ${stop(and(entities))}`, `We go live on ${sayDate(goLive, 'weekday_short_date')}, so we need every page before then.`),
      attachments: [{ filename: execFile, content_type: 'application/pdf', lines: [`${co.toUpperCase()} — ${d.agreement.name.toUpperCase()}`, 'EXECUTION VERSION', `Matter ${d.alias}`, `Vendor parties: ${entities.join('; ')}`, 'Signed for Acme Corp: [signature], General Counsel', ...entities.map((e) => `Signed for ${e}: ____________`)] }],
    });
    const promiseSay = sayFrom(promiseDay, t(0, '12:00'), dateStyle);
    const promise = mb.add({
      direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], at: t(0, g ? '13:30' : r.pick(['11:50', '13:30', '15:10'])),
      subject: mb.reSubject(send), replyTo: send,
      body: body('Hi,', g
        ? `Thanks. We'll return signed pages for all ${n} entities by ${promiseSay}.`
        : r.pick([
          `Received, thank you. You'll have countersigned pages for all ${n} entities by ${promiseSay}.`,
          `Thanks. I'm collecting signatures from each entity and will send all ${n} pages ${promiseSay}.`,
          `Got it. All ${n} signature pages will be with you by ${promiseSay}.`,
        ]), firstName(counsel)),
    });
    legalBackground(r, d, mb, t(0, '11:00'), t(1, '17:00'), nBackground, g ? 0 : r.int(0, 7));
    const reportAt = t(2, g ? '16:10' : r.pick(['12:30', '16:10', '17:20']));
    legalChatter(r, d, mb, t(1, '09:00'), later(reportAt, -30), nChatter, g ? 0 : r.int(0, 9));

    const newSay = sayFrom(newDay, reportAt, dateStyle);
    const recS = and(received);
    const penS = and(pending);
    const reportText = g
      ? `Attached are the signed pages for ${recS}. For ${penS}, ${reason}, so that page will follow on ${newSay}.`
      : r.pick([
        `Signed ${k > 1 ? 'pages' : 'page'} for ${recS} ${k > 1 ? 'are' : 'is'} attached. The ${pending.length > 1 ? 'pages' : 'page'} for ${penS} will follow ${newSay}; ${reason}.`,
        `Please find attached ${k} of the ${n} signature pages (${recS}). For ${penS}, ${reason}, so ${pending.length > 1 ? 'they' : 'it'} will sign on ${newSay}.`,
        `Partial delivery, sorry: ${recS} ${k > 1 ? 'have' : 'has'} signed (${k > 1 ? 'pages' : 'page'} attached). ${penS} will follow by ${newSay} because ${reason}.`,
      ]);
    const report = mb.add({
      direction: 'inbound', from: counsel.address, fromName: shortName(counsel), to: [self.address], cc: ownerCopied ? [owner.address] : undefined, at: reportAt,
      subject: reportInThread ? mb.reSubject(send) : r.pick([`${d.alias} — signature pages`, `Countersigned pages — ${d.alias}`]),
      replyTo: reportInThread ? promise : null,
      body: body('Hi,', reportText, g ? counselSig(d) : firstName(counsel)),
      attachments: received.map((e) => ({ filename: pageFile(e), content_type: 'application/pdf' as const, lines: [`${d.agreement.name} — ${d.alias}`, 'SIGNATURE PAGE', `Signed for and on behalf of ${e}`, 'Name: [authorised signatory]', `Date: ${sayDate(reportAt.slice(0, 10), 'long')}`] })),
    });

    // ---- oracle
    const goS = sayDate(goLive, 'weekday_short_date');
    const newS = sayDate(newDay, 'weekday_short_date');
    const conflicts: OracleConflict[] = late ? [{ kind: 'requirement_violation', term: 'signature.status', party: counsel.address, display: `${penS} will only sign ${newS}, after go-live on ${goS}`, critical: true }] : [];
    const open_loops: OracleLoop[] = [
      { kind: 'commitment', debtor: counsel.address, subject: 'document.signature_pages', display: `Counsel still owes the signature ${pending.length > 1 ? 'pages' : 'page'} for ${penS} (due ${newS})`, evidence: [promise, report], critical: true, residual: { qty: n - k, display: `${n - k} of ${n} entity signature pages` } },
    ];
    const closed_loops: OracleLoop[] = [
      { kind: 'ask', debtor: gc.address, subject: 'approval.gc_signoff', display: 'GC approval and Acme signature (done)', evidence: [gcOk] },
    ];
    const documents: OracleDocument[] = [
      { filename: execFile, status: 'current', stale_terms: [], display: `${execFile}: the execution version, signed by Acme` },
      ...received.map((e) => ({ filename: pageFile(e), status: 'current' as const, stale_terms: [], display: `${pageFile(e)}: signed` })),
    ];
    const prohibited: ActionCond[] = [
      { id: 'claims_complete', text: `Says or implies the agreement is fully executed or that all ${n} pages have arrived` },
      { id: 'full_set_outstanding', text: `Treats all ${n} pages as still outstanding (e.g. asks again for ${recS})` },
      { id: 'stale_promise', text: staleText(`Treats the original promise of all ${n} pages by ${sayDate(promiseDay, 'weekday_short_date')} as still on track`), stale: true },
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];
    const checkpoint: Checkpoint = {
      id: 'after_partial_pages', after: report, now: later(reportAt, 20),
      state: {
        terms: [{ party: counsel.address, term: 'signature.status', status: 'current', value: 'partially_signed', evidence: [report], critical: true, display: `partially signed: ${recS} signed; ${penS} pending` }],
        superseded: [], open_loops, closed_loops, conflicts, documents,
        next_actor: late ? 'us' : 'them',
      },
      judge_facts: [
        `Acme signed the ${ag}; counsel committed to return signed pages for all ${n} ${co} entities (${and(entities)}) by ${sayDate(promiseDay, 'weekday_short_date')}.`,
        `Pages for ${recS} have arrived; ${penS} will only sign ${newS} (${reason}). Only ${n - k} ${n - k > 1 ? 'pages are' : 'page is'} still owed.`,
        late ? `Go-live is ${goS} and the agreement must be fully executed first, so the missing ${n - k > 1 ? 'pages break' : 'page breaks'} that requirement.` : `${newS} is still before go-live on ${goS}, so nothing is in breach yet.`,
      ].join(' '),
      action: late
        ? {
          expect: 'send',
          required: [
            { id: 'to_counsel', text: `Sends a message to ${shortName(counsel)}`, det: { type: 'message_to', party: counsel.address } },
            { id: 'chase_residual', text: `Raises that the ${pending.length > 1 ? 'pages' : 'page'} for ${penS} due ${newS} ${pending.length > 1 ? 'are' : 'is'} after go-live on ${goS} and asks for it sooner (or another way to sign, e.g. e-signature)` },
          ],
          optional: [
            { id: 'ack_received', text: `Acknowledges the pages received for ${recS}` },
            { id: 'tell_owner', text: `Tells ${firstName(owner)} that execution is incomplete and go-live may be at risk` },
          ],
          prohibited,
        }
        : {
          expect: 'any',
          required: [],
          optional: [{ id: 'ack_and_confirm', text: `Acknowledges the ${k} ${k > 1 ? 'pages' : 'page'} received and confirms the remaining ${n - k} for ${newS}` }],
          prohibited,
        },
    };

    return legalCase(partial_fulfilment, variant, {
      description: `Counsel committed ${n} entity signature pages by ${sayDate(promiseDay, 'weekday_short_date')}; ${k} arrived, ${n - k} slip to ${newS}${late ? ' (after go-live)' : ''}.`,
      task: d.task, mb, trigger: report, checkpoint,
      params: { n, k, entities, promiseDay, goLive, newDay, late, reason, reportInThread, ownerCopied, dateStyle, nBackground, nChatter },
    });
  },
};
