// Renderers shared by the story page and the live console:
//   renderBoard — a compiled context drawn as state cards (with change highlights)
//   threadSVG   — the conversation as one line of events, agents as short lifelines riding on it
//   eventLabel  — a short human label for an event in the PO-4817 story

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (ch) => HTML_ENTITIES[ch]);

// terms are listed in this order; anything unknown sinks to the bottom
const TERM_SEQUENCE = ['delivery.schedule', 'price.unit', 'order.quantity', 'budget.max_unit_price', 'payment.terms', 'quote.valid_until', 'decision.order'];
const termOrder = (term) => {
  const at = TERM_SEQUENCE.indexOf(term);
  return at === -1 ? 99 : at;
};

const abbreviateCheck = (label) => label
  .replace('All units by ', 'All by ')
  .replace('Unit price within budget', 'Price ≤ budget');

const termKey = (t) => `${t.party}|${t.term}`;

const actorWord = (who) => ({ us: 'Us', them: 'Them', human: 'You' })[who] ?? 'Nobody';

const card = (key, cls, heading, aside, body) =>
  `<div class="b-card ${cls}" data-k="${key}">
    <div class="b-h"><span>${heading}</span><b>${aside}</b></div>
    ${body}
  </div>`;

/** Remember what the previous context looked like, so the new one can say what changed. */
function snapshotOf(prev) {
  if (!prev) return null;
  return {
    actor: prev.next_actor,
    terms: new Map((prev.current_terms ?? []).map((t) => [termKey(t), t.value])),
    checks: new Map((prev.checks ?? []).map((x) => [x.check, x.status])),
    loops: new Set([...(prev.waiting_on_them ?? []), ...(prev.we_owe ?? [])].map((o) => o.id)),
    docs: new Map((prev.documents ?? []).map((d) => [d.artifact_id, d.status])),
  };
}

function actorCard(ctx, before, version) {
  const moved = Boolean(before) && before.actor !== ctx.next_actor;
  const aside = `${esc(ctx.meta?.alias ?? '')}${version != null ? ` · state v${version}` : ''}`;
  const body = `<div class="b-top"><div class="actor ${esc(ctx.next_actor)}">${actorWord(ctx.next_actor)}</div><div class="actor-why clamp">${esc(ctx.next_actor_reason)}</div></div>`;
  return card('top', moved ? 'hot' : '', 'Who acts next', aside, body);
}

function checksCard(ctx, before, compact) {
  const list = ctx.checks ?? [];
  let moved = false;
  const cells = list.map((x) => {
    if (before && before.checks.get(x.check) !== x.status) moved = true;
    return `<div class="check ${esc(x.status)}" title="${esc(x.detail)}"><i></i><span>${esc(abbreviateCheck(x.check))}</span></div>`;
  }).join('');
  const failing = list.some((x) => x.status === 'fail');
  const firstConflict = (ctx.conflicts ?? [])[0];
  const aside = failing ? 'conflict' : list.length ? 'checked against state' : '';
  let body = cells ? `<div class="checks">${cells}</div>` : '<div class="empty">no terms to check yet</div>';
  if (firstConflict && !compact) {
    body += `<div class="conflict-line clamp1">✕ ${esc(firstConflict.detail)}</div>`;
  }
  return card('checks', failing ? 'bad' : moved ? 'hot' : '', 'Requirements', aside, body);
}

function termsCard(ctx, before) {
  const replaced = ctx.superseded_terms_do_not_use ?? [];
  const sorted = [...(ctx.current_terms ?? [])].sort((a, b) => termOrder(a.term) - termOrder(b.term));
  let moved = false;
  const rows = sorted.map((t) => {
    const fresh = Boolean(before) && before.terms.get(termKey(t)) !== t.value;
    if (fresh) moved = true;
    const prior = replaced.filter((s) => s.party === t.party && s.term === t.term).at(-1);
    const wasHtml = prior ? `<span class="was">${esc(prior.old_value)}</span>` : '';
    const contested = t.status === 'contested' ? ' <span class="tag fail">contested</span>' : '';
    return `<div class="row ${fresh ? 'flash' : ''}">
      <div class="k" title="${esc(t.party)}">${esc(t.term)}</div>
      <div class="v">${wasHtml}${esc(t.value)}${contested}</div>
      <div class="src">${esc((t.stated_in ?? []).at(-1) ?? '')}</div>
    </div>`;
  }).join('');
  const body = rows ? `<div class="rows">${rows}</div>` : '<div class="empty">nothing agreed or offered yet</div>';
  return card('terms', moved ? 'hot' : '', 'Current terms', replaced.length ? `${replaced.length} superseded` : '', body);
}

function loopsCard(ctx, before, compact) {
  const open = [
    ...(ctx.waiting_on_them ?? []).map((o) => ({ ...o, dir: 'them' })),
    ...(ctx.we_owe ?? []).map((o) => ({ ...o, dir: 'us' })),
  ];
  const lastKept = (ctx.resolved_commitments ?? []).slice(-1);
  const overflow = Math.max(0, open.length - 3);
  let moved = false;

  let rows = open.slice(0, 3).map((o) => {
    const fresh = Boolean(before) && !before.loops.has(o.id);
    if (fresh) moved = true;
    const label = o.kind === 'commitment' ? 'owed' : o.kind;
    const closes = o.closes_when && !compact
      ? `<br><span class="closes">closes when ${esc(o.closes_when)}</span>`
      : '';
    return `<div class="loop ${fresh ? 'row flash' : ''}" style="display:flex"><span class="tag open">${label}</span><span class="clamp"><b>${esc(o.owed_by)}</b> → ${esc(o.what)}${closes}</span></div>`;
  }).join('');
  if (overflow) rows += `<div class="loop"><span class="empty">+ ${overflow} more</span></div>`;
  rows += lastKept.map((o) => `<div class="loop"><span class="tag fulfilled">kept</span><span><b>${esc(o.owed_by ?? o.debtor ?? 'supplier')}</b> → ${esc(o.what ?? o.text ?? '')}</span></div>`).join('');

  const answered = (ctx.already_answered_do_not_reask ?? []).length;
  return card('loops', moved ? 'hot' : '', 'Open loops', answered ? `${answered} answered · don’t re-ask` : '',
    rows || '<div class="empty">nobody owes anybody anything</div>');
}

function docsCard(ctx, before, compact) {
  let moved = false;
  const rows = (ctx.documents ?? []).map((d) => {
    const fresh = Boolean(before) && before.docs.get(d.artifact_id) !== d.status;
    if (fresh) moved = true;
    const staleLines = (d.stale_terms ?? []).map((s) => `<div class="st bad">✕ ${esc(s.term)} — says ${esc(s.document_says)}</div>`).join('');
    const okLine = d.status !== 'superseded' && d.still_current_terms?.length
      ? `<div class="st ok">✓ ${d.still_current_terms.length} terms still current</div>`
      : '';
    const statusText = d.status === 'partially_stale' ? 'part stale' : esc(d.status);
    return `<div class="doc ${fresh ? 'row flash' : ''}" style="display:block"><div class="fn"><span>${esc(d.filename)}</span><span class="tag ${esc(d.status)}">${statusText}</span></div>${compact ? '' : staleLines + okLine}</div>`;
  }).join('');
  const injected = (ctx.flags ?? []).some((f) => f.kind === 'prompt_injection_suspected');
  return card('docs', moved ? 'hot' : '', 'Documents', injected ? '1 injection quarantined' : '',
    rows || '<div class="empty">no attachments yet</div>');
}

/** Render compiled context `c` into `root`. `prev` (the previous context) drives the change highlights. */
export function renderBoard(root, c, { prev = null, version = null, compact = false } = {}) {
  if (!c) {
    root.innerHTML = '<div class="b-card"><div class="empty">no state yet — the engine is waiting for its first email</div></div>';
    return;
  }
  const before = snapshotOf(prev);
  root.innerHTML = actorCard(c, before, version)
    + checksCard(c, before, compact)
    + termsCard(c, before)
    + `<div class="b-grid">${loopsCard(c, before, compact)}${docsCard(c, before, compact)}</div>`;
  // highlights fade on their own
  setTimeout(() => root.querySelectorAll('.b-card.hot').forEach((el) => el.classList.remove('hot')), 2200);
}

/**
 * The thread as SVG markup.
 * model = { slots, nodes: [{ id, label, dir, hot }], agents: [{ name, from, to, state, note }], gaps: [{ from, to }], head }
 * from / to / head are measured in node-index units and may be fractional.
 */
export function threadSVG(model, { width = 1000, height = 150, labels = true } = {}) {
  const inset = 34;
  const lineY = 84;
  const laneY = lineY - 40; // where agent lifelines run
  const slots = Math.max(model.slots ?? 0, model.nodes.length, 2);
  const xAt = (i) => inset + (i * (width - 2 * inset)) / (slots - 1);
  const head = Math.min(Math.max(model.head ?? 0, 0), slots - 1);
  const out = [];

  // colours come from site.css classes, so the thread follows the theme
  out.push(`<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="thread-svg" role="img" aria-label="Conversation thread with agent lifelines">
  <line x1="${inset}" y1="${lineY}" x2="${width - inset}" y2="${lineY}" class="thr-future" stroke-width="1" stroke-dasharray="2 4"/>
  <line x1="${inset}" y1="${lineY}" x2="${xAt(head)}" y2="${lineY}" class="thr-past" stroke-width="1.5"/>`);

  // stretches where no agent was alive but the thread kept moving
  for (const gap of model.gaps ?? []) {
    const a = xAt(gap.from);
    const b = xAt(gap.to);
    const span = b - a;
    const caption = span > 84
      ? `<text x="${(a + b) / 2}" y="${laneY + 4}" text-anchor="middle" class="thr-t small sub">${span > 250 ? 'no agent running · state still updating' : 'no agent running'}</text>`
      : '';
    const line = span > 84
      ? `<line x1="${a + 6}" y1="${laneY}" x2="${(a + b) / 2 - (span > 250 ? 128 : 58)}" y2="${laneY}" class="thr-gapline" stroke-dasharray="1 4"/>
      <line x1="${(a + b) / 2 + (span > 250 ? 128 : 58)}" y1="${laneY}" x2="${b - 6}" y2="${laneY}" class="thr-gapline" stroke-dasharray="1 4"/>`
      : `<line x1="${a}" y1="${laneY}" x2="${b}" y2="${laneY}" class="thr-gapline" stroke-dasharray="1 4"/>`;
    out.push(`<g class="thr-gap">${line}${caption}</g>`);
  }

  for (const agent of model.agents ?? []) {
    const a = xAt(agent.from);
    const b = Math.max(xAt(agent.to), a + 8);
    const note = agent.note ? ` <tspan class="muted">${esc(agent.note)}</tspan>` : '';
    const cross = agent.state === 'killed'
      ? `<path d="M${b - 5} ${laneY - 5}L${b + 5} ${laneY + 5}M${b + 5} ${laneY - 5}L${b - 5} ${laneY + 5}" class="thr-x" stroke-width="1.75"/>`
      : '';
    const pulse = agent.state === 'alive' ? `<circle cx="${b}" cy="${laneY}" r="3.5" class="thr-pulse"/>` : '';
    out.push(`<g class="thr-agent ${agent.state}">
      <rect x="${a}" y="${laneY - 2}" width="${b - a}" height="4" rx="2" class="thr-life"/>
      <line x1="${a}" y1="${laneY + 2}" x2="${a}" y2="${lineY - 5}" class="thr-stem" stroke-width="1"/>
      <text x="${a}" y="${laneY - 12}" class="thr-t thr-name">${esc(agent.name)}${note}</text>
      ${cross}
      ${pulse}
    </g>`);
  }

  // when nodes are crowded, every other label drops a line
  const crowded = (width - 2 * inset) / (slots - 1) < 100;
  model.nodes.forEach((node, i) => {
    const x = xAt(i);
    const lit = i <= head;
    const outbound = node.dir === 'outbound';
    const labelY = lineY + 39 + (crowded && i % 2 ? 14 : 0);
    const ring = node.hot ? `<circle cx="${x}" cy="${lineY}" r="13" class="thr-ring"/>` : '';
    const text = labels
      ? `<text x="${x}" y="${lineY + 24}" text-anchor="middle" class="thr-t ${lit ? '' : 'muted'}">${esc(node.id)}</text>
      <text x="${x}" y="${labelY}" text-anchor="middle" class="thr-t small ${lit ? 'sub' : 'muted'}">${esc(node.label)}</text>`
      : '';
    out.push(`<g class="thr-node ${lit ? 'lit' : ''} ${outbound ? 'out' : ''} ${node.hot ? 'hot' : ''}">
      ${ring}
      <rect x="${x - 4}" y="${lineY - 4}" width="8" height="8" class="thr-dot" ${outbound ? '' : `transform="rotate(45 ${x} ${lineY})"`}/>
      ${text}
    </g>`);
  });

  out.push('</svg>');
  return out.join('');
}

/** Short human labels for events in the PO-4817 story (fallback: the sender's label). */
export function eventLabel(ev) {
  const kinds = (ev.transitions ?? []).map((t) => t.type);
  if (ev.direction === 'outbound') {
    if (kinds.includes('claim_added') && /accept/i.test(JSON.stringify(ev.transitions))) return 'we accept';
    if (/budget/i.test(ev.subject)) return 'budget request';
    if (/^re:/i.test(ev.subject)) return 'we reply';
    return 'RFQ sent';
  }
  if (kinds.includes('conflict_resolved')) return 'rev 2 · fixed';
  if (kinds.includes('conflict_detected')) return 'correction';
  if (kinds.includes('artifact_added')) return 'offer + PDF';
  if (ev.from_label === 'finance') return 'approved';
  return ev.from_label ?? 'email';
}
