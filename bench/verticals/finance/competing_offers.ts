// Archetype: competing offers (P1).
//
// Acme's controller frees up an early-payment budget for this week's payment run. We ask two
// independent vendors (different companies, different groups), each with an open invoice, whether they
// will give a discount for paying now. Both answer with a discount % and a deadline. Depending on the
// variant the larger saving is out of reach (its net payment exceeds the budget, or its deadline falls
// before the payment run), or both are reachable but the budget only covers one and the larger saving
// wins.
//
// Trap: two values for the same term keys (discount %, deadline, amount) in one mailbox look like a
// correction ("newest wins": the later answer overwrites the earlier) or a contradiction to reconcile.
// They are neither: offers from different parties are both current, keyed by party. The oracle lists
// both offers, records a requirement violation only against the one that cannot be taken, and the
// right action accepts the offer that fits the budget and the run date (the bigger saving when both
// do) without binding to the other.
import type { Archetype, BenchCase, BenchParty, BenchTask, Checkpoint, OracleConflict, OracleLoop, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, money, moneyShort, sayDate, seedOf } from '../../core/util.ts';
import { addParty, financeBackground, financeCase, financeChatter, financeDayStart, financeDeal, firstName, later, ours, rivalVendor, round2, shortName } from './vertical.ts';

type Scenario = 'over_limit' | 'deadline' | 'both_ok';

interface Offer { party: BenchParty; company: string; invoice: string; amount: number; pct: number; deadline: string; net: number; saving: number; key?: string; ask?: string }

export const competing_offers: Archetype = {
  id: 'competing_offers',
  title: 'Two vendors offer early-payment discounts against one budget',
  capabilities: ['competing_offers'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('finance', 'competing_offers', variant));
    const g = variant === 0;
    const d = financeDeal(r, variant, { terms: 'net' });
    const { self, ar, controller } = d.cast;
    const rival = rivalVendor(r, d, g);
    addParty(d, rival.party);
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => financeDayStart(d, day, hhmm);

    // ---- parameters
    const scenario: Scenario = g ? 'over_limit' : r.pick(['over_limit', 'deadline', 'both_ok'] as const);
    const primaryWins = g ? true : r.chance(0.5);
    const run = addDays(d.start, 3); // Thursday payment run
    const winAmount = g ? 48000 : Math.max(d.amount, 6000);
    const loseAmount = round2(Math.round((winAmount * (g ? 1.5 : r.pick([1.4, 1.6, 1.8]))) / 10) * 10);
    const winPct = g ? 2 : r.pick([1.5, 2, 2.5]);
    let losePct = g ? 2.5 : r.pick([2, 2.5, 3]);
    if (scenario === 'both_ok') losePct = r.pick([0.5, 0.75, 1]); // the larger invoice yields the smaller saving
    const mk = (party: BenchParty, company: string, invoice: string, amount: number, pct: number, deadline: string): Offer => ({ party, company, invoice, amount, pct, deadline, net: round2(amount * (1 - pct / 100)), saving: round2(amount * pct / 100) });
    const winDeadline = addDays(run, g ? 1 : r.pick([0, 1, 4]));
    const loseDeadline = scenario === 'deadline' ? addDays(run, -r.pick([1, 2])) : addDays(run, r.pick([1, 4]));
    const primary = { party: ar, company: d.company, invoice: d.alias };
    const second = { party: rival.party, company: rival.company, invoice: g ? 'HC-77310' : `${rival.company.split(' ')[0].slice(0, 2).toUpperCase()}-${r.int(10000, 99999)}` };
    const wP = primaryWins ? primary : second;
    const lP = primaryWins ? second : primary;
    const winner = mk(wP.party, wP.company, wP.invoice, winAmount, winPct, winDeadline);
    const loser = mk(lP.party, lP.company, lP.invoice, loseAmount, losePct, loseDeadline);
    if (scenario === 'both_ok' && loser.saving >= winner.saving) loser.pct = 0.5, loser.net = round2(loser.amount * 0.995), loser.saving = round2(loser.amount * 0.005);
    const big = Math.max(winner.net, loser.net);
    const budget = scenario === 'over_limit' ? Math.ceil(winner.net / 1000) * 1000 : Math.ceil(big / 1000) * 1000;
    const winnerFirst = g ? false : r.chance(0.5);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 2);

    // a task of its own: this week's early-payment program
    const alias = `EPP-${run.slice(5).replace('-', '')}`;
    const task: BenchTask = {
      id: `task_${alias.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
      alias,
      goal: `Use this week's early-payment budget (${sayDate(run, 'weekday_short_date')} payment run) on the best available early-payment discount from Acme's vendors, within the controller's limit.`,
      self_address: self.address,
      parties: [self, ar, controller, rival.party],
      requirements: [
        { key: 'requirement.max_amount', value: budget, display: `Early payments in this run must not exceed the controller's budget (${moneyShort(budget)} in total)`, hard: true },
        { key: 'requirement.payment_run', value: run, display: `Early payments go out in the ${sayDate(run, 'weekday_short_date')} run, so a discount is usable only if its deadline is on or after that date`, hard: true },
        { key: 'requirement.verified_remit_to', value: true, display: "Pay only to each vendor's bank account on file", hard: true },
      ],
    };
    d.task.parties.forEach((p) => { if (!task.parties.includes(p)) task.parties.push(p); });

    // ---- history
    const budgetMsg = mb.add({
      direction: 'inbound', from: controller.address, fromName: shortName(controller), to: [self.address], at: t(0, '08:40'),
      subject: g ? `Early payments this week` : r.pick(['Early payments this week', `Spare cash for ${sayDate(run, 'weekday')}'s run`, 'Early-pay discounts']),
      body: body('Hi,', g
        ? `We have up to ${money(budget)} of spare cash for ${sayDate(run, 'weekday')}'s payment run. See whether any vendor will give us an early-payment discount on an open invoice and take the best one that fits.`
        : r.pick([
          `Treasury says we can pay up to ${moneyShort(budget)} early in the ${sayDate(run, 'weekday_short_date')} run. Go and get us the best early-pay discount within that.`,
          `You're approved to use up to ${moneyShort(budget)} for early payments on ${sayDate(run, 'weekday')}. Pick whichever discount saves us most and fits.`,
          `Budget for early payments this week: ${moneyShort(budget)} total, ${sayDate(run, 'weekday')} run. Please shop it around our vendors.`,
        ]), firstName(controller)),
    });
    const offers = g ? [primary, second] : r.shuffle([primary, second]);
    const byParty = new Map<string, Offer>([[winner.party.address, winner], [loser.party.address, loser]]);
    for (const [i, p] of offers.entries()) {
      const o = byParty.get(p.party.address)!;
      o.ask = mb.add({
        direction: 'outbound', from: self.address, fromName: self.name, to: [p.party.address], at: t(0, i ? '09:12' : '09:00'),
        subject: `Early payment — ${o.invoice}`,
        body: ours(firstName(p.party), `We could pay your open invoice ${o.invoice} (${moneyShort(o.amount)}) early, in our ${sayDate(run, 'weekday_short_date')} payment run. Would you offer an early-payment discount, and until when?`),
      });
    }
    financeBackground(r, d, mb, t(0, '10:00'), nBackground, g ? 0 : r.int(0, 7), true);

    const quoteText = (o: Offer): string => g
      ? `Yes: ${o.pct}% off ${o.invoice} if payment reaches us by ${sayDate(o.deadline, 'weekday_long')}, so ${money(o.net)} instead of ${money(o.amount)}.`
      : r.pick([
        `We can offer ${o.pct}% on ${o.invoice} (${moneyShort(o.net)} net) for payment received by ${sayDate(o.deadline, 'weekday_short_date')}.`,
        `Happy to: pay ${moneyShort(o.net)} by ${sayDate(o.deadline, 'long')} and we'll treat ${o.invoice} as settled (${o.pct}% discount).`,
        `${o.pct}% early-payment discount on ${o.invoice} if we have the funds by ${sayDate(o.deadline, 'weekday')} ${sayDate(o.deadline, 'month_day')}. Net ${money(o.net)}.`,
      ]);
    const order = winnerFirst ? [winner, loser] : [loser, winner];
    const times = g ? ['13:20', '15:05'] : r.shuffle(['11:45', '13:20', '15:05', '16:30']).slice(0, 2).sort();
    for (const [i, o] of order.entries()) {
      o.key = mb.add({
        direction: 'inbound', from: o.party.address, fromName: shortName(o.party), to: [self.address], at: t(0, times[i]),
        subject: mb.reSubject(o.ask!), replyTo: o.ask,
        body: body('Hi,', quoteText(o), `${shortName(o.party)}\nAccounts Receivable, ${o.company}`),
      });
    }
    financeChatter(r, d, mb, later(mb.get(order[0].key!).at, 10), nChatter, g ? 0 : r.int(0, 9));
    const trigger = order[1].key!;
    const trigAt = mb.get(trigger).at;

    // ---- oracle
    const termsFor = (o: Offer): OracleTerm[] => [
      { party: o.party.address, term: 'invoice.number', status: 'current', value: o.invoice, evidence: [o.key!], display: `${o.company}: ${o.invoice}` },
      { party: o.party.address, term: 'invoice.amount', status: 'current', value: o.amount, evidence: [o.key!], display: `${o.company}: ${moneyShort(o.amount)}` },
      { party: o.party.address, term: 'discount.early_pay_pct', status: 'current', value: o.pct, evidence: [o.key!], critical: true, display: `${o.company}: ${o.pct}%` },
      { party: o.party.address, term: 'discount.deadline', status: 'current', value: o.deadline, evidence: [o.key!], critical: true, display: `${o.company}: ${sayDate(o.deadline, 'weekday_short_date')}` },
    ];
    const terms: OracleTerm[] = [...termsFor(winner), ...termsFor(loser), { party: controller.address, term: 'approval.max_amount', status: 'current', value: budget, evidence: [budgetMsg], critical: true, display: `${moneyShort(budget)} early-payment budget` }];
    const conflicts: OracleConflict[] = [];
    if (scenario === 'over_limit') conflicts.push({ kind: 'requirement_violation', term: 'invoice.amount', party: loser.party.address, display: `${loser.company}: net ${moneyShort(loser.net)} exceeds the ${moneyShort(budget)} early-payment budget`, critical: true });
    if (scenario === 'deadline') conflicts.push({ kind: 'requirement_violation', term: 'discount.deadline', party: loser.party.address, display: `${loser.company}: discount ends ${sayDate(loser.deadline, 'weekday_short_date')}, before the ${sayDate(run, 'weekday_short_date')} payment run`, critical: true });
    const closed_loops: OracleLoop[] = [winner, loser].map((o): OracleLoop => ({ kind: 'ask', debtor: o.party.address, subject: 'discount.early_pay_pct', alt_subjects: ['discount.deadline'], display: `${o.company}: early-payment discount (answered)`, evidence: [o.ask!, o.key!] }));

    const why = scenario === 'over_limit' ? `${loser.company}'s saving is larger (${moneyShort(loser.saving)}) but its net payment ${moneyShort(loser.net)} exceeds the ${moneyShort(budget)} budget`
      : scenario === 'deadline' ? `${loser.company}'s saving is larger (${moneyShort(loser.saving)}) but its discount ends ${sayDate(loser.deadline, 'weekday_short_date')}, before the ${sayDate(run, 'weekday_short_date')} run`
        : `both fit on their own but the budget covers only one, and ${winner.company} saves more (${moneyShort(winner.saving)} vs ${moneyShort(loser.saving)})`;
    const checkpoint: Checkpoint = {
      id: 'after_both_offers', after: trigger, now: later(trigAt, 20),
      state: { terms, superseded: [], open_loops: [], closed_loops, conflicts, documents: [], next_actor: 'us' },
      judge_facts: [
        `The controller allowed up to ${moneyShort(budget)} of early payments in the ${sayDate(run, 'weekday_short_date')} run.`,
        `${winner.company}: ${winner.pct}% off ${winner.invoice} (${moneyShort(winner.amount)} → ${moneyShort(winner.net)}, saves ${moneyShort(winner.saving)}) if paid by ${sayDate(winner.deadline, 'weekday_short_date')}. ${loser.company}: ${loser.pct}% off ${loser.invoice} (${moneyShort(loser.amount)} → ${moneyShort(loser.net)}, saves ${moneyShort(loser.saving)}) if paid by ${sayDate(loser.deadline, 'weekday_short_date')}.`,
        `${why}. ${winner.company}'s offer is the one to take. The two answers are separate offers, not a correction or a contradiction.`,
      ].join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_winner', text: `Sends a message to ${winner.company}`, det: { type: 'message_to', party: winner.party.address } },
          { id: 'take_winner', text: `Accepts ${winner.company}'s ${winner.pct}% discount: confirms Acme will pay ${moneyShort(winner.net)} on ${winner.invoice} in the ${sayDate(run, 'weekday_short_date')} run` },
        ],
        optional: [
          { id: 'decline_loser', text: `Politely tells ${loser.company} Acme will pay ${loser.invoice} on its normal terms` },
          { id: 'tell_controller', text: 'Tells the controller which discount was taken and the saving' },
        ],
        prohibited: [
          // judged, not binding_to: the optional decline ("we will pay it on its normal terms") is itself binding language
          { id: 'binding_loser', text: `Accepts ${loser.company}'s discount or commits to paying ${loser.invoice} early (saying it will be paid on its normal terms is fine)` },
          { id: 'both', text: `Commits to paying both invoices early (${moneyShort(round2(winner.net + loser.net))}, over the budget)` },
          { id: 'as_correction', text: "Treats one vendor's answer as correcting or contradicting the other's" },
          { id: 'loser_better', text: scenario === 'both_ok' ? `Claims ${loser.company}'s offer saves more` : `Claims ${loser.company}'s offer can be taken within the budget and run date` },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return financeCase(competing_offers, variant, {
      description: `${winner.company} ${winner.pct}% vs ${loser.company} ${loser.pct}% against a ${moneyShort(budget)} budget (${scenario}); ${winner.company} wins.`,
      task, mb, trigger, checkpoint,
      params: { scenario, primaryWins, budget, run, winner: { company: winner.company, invoice: winner.invoice, amount: winner.amount, pct: winner.pct, deadline: winner.deadline, net: winner.net }, loser: { company: loser.company, invoice: loser.invoice, amount: loser.amount, pct: loser.pct, deadline: loser.deadline, net: loser.net }, winnerFirst, nBackground, nChatter },
    });
  },
};
