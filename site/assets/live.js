// The live engine console. The mode is chosen once, at load:
//   stage  — served by `npm run stage`: drives the story (POST /stage/next) and streams process output over SSE
//   engine — pointed at a plain Continuity server: read-only, follows state through the /wait long-poll
//   replay — nothing reachable: steps through the recorded run in assets/snapshot.json
// Two faces render the same state: the presenter view (default) and the details console (D).
import { renderBoard, threadSVG, eventLabel, esc } from './board.js';
import { setupTheme } from './theme.js';

const el = (sel) => document.querySelector(sel);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const noMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const pad2 = (n) => String(n).padStart(2, '0');

async function getJSON(path, init) {
  const res = await fetch(path, { cache: 'no-store', ...init });
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body.error ?? res.status), { status: res.status });
  return body;
}

// ============================================================ state
const app = {
  mode: null,          // 'stage' | 'engine' | 'replay'
  task: null,
  version: -1,
  // engine data
  health: null, state: null, timeline: null, ctx: null, runs: [],
  briefing: '', briefingTokens: 0, transcriptTokens: 0,
  prevCtx: null,
  // stage + processes
  stage: null,
  procs: new Map(),
  running: null,       // index of the beat in flight
  // bookkeeping for "what is new"
  seenEvents: new Set(), seenRuns: new Set(), newEvents: new Set(),
  tab: 'evidence',
  waitCtl: null,
  // replay
  snap: null,
  replayBeat: 0,
};

const MODE_LABEL = { stage: 'live · stage', engine: 'live · read-only', replay: 'replay' };

// the recorded run, beat by beat: what to reveal and which processes exist at that point
const REPLAY_SCRIPT = [
  { title: 'Agent A opens the deal.', caption: 'Two emails. Two threads.', at: 'ev_2', procs: { 'agent-a': 'running' }, runs: 1 },
  { title: 'The supplier says yes.', caption: '500 by Friday at $11.40. Quote attached.', at: 'ev_3', procs: { 'agent-a': 'running' }, runs: 2, unlinked: true },
  { title: 'Agent A is killed.', caption: 'No warning. No handoff notes.', at: 'ev_3', procs: { 'agent-a': 'killed' }, runs: 2, unlinked: true, moment: 'kill' },
  { title: 'Finance approves.', caption: 'Nobody is awake to read it. Continuity is.', at: 'ev_5', procs: { 'agent-a': 'killed' }, runs: 2, unlinked: true },
  { title: 'The supplier changes the deal.', caption: 'Only 300 can arrive Friday.', at: 'ev_6', procs: { 'agent-a': 'killed' }, runs: 2, unlinked: true },
  { title: 'Agent B wakes up with zero memory.', caption: 'One call to Continuity. Then it writes.', at: 'ev_7', procs: { 'agent-a': 'killed', 'agent-b': 'exited' }, runs: 3, unlinked: true, moment: 'agent-b' },
  { title: 'The supplier fixes it.', caption: 'All 500 by Friday, with a revised quote.', at: 'ev_8', procs: { 'agent-a': 'killed', 'agent-b': 'exited' }, runs: 3, unlinked: true },
  { title: 'Agent C closes the deal.', caption: 'Another fresh agent. Every check passes.', at: 'ev_9', procs: { 'agent-a': 'killed', 'agent-b': 'exited', 'agent-c': 'exited' }, runs: 4, unlinked: true, moment: 'agent-c' },
];

// the pipeline strip, left to right
const PIPELINE = [
  ['Primitive', 'signed mail'],
  ['Event log', 'append-only'],
  ['Claude', 'reads'],
  ['Resolver', 'decides'],
  ['State', ''],
  ['Compiler', 'briefing'],
  ['Agent', 'memory 0'],
];
const STAGE = { PRIMITIVE: 0, LOG: 1, READER: 2, STATE: 4, COMPILER: 5, AGENT: 6 };

// ============================================================ derived helpers
const usesClaude = () => app.health?.agent_llm || /^llm/.test(app.health?.extractor ?? '');
const actorWord = (who) => (who === 'us' ? 'Us' : who === 'them' ? 'Them' : 'Nobody');

/** Beat list, cursor and busy flag, regardless of mode. */
function storyPosition() {
  if (app.mode === 'replay') return { beats: REPLAY_SCRIPT, cursor: app.replayBeat };
  return { beats: app.stage?.beats ?? [], cursor: app.stage?.cursor ?? 0 };
}

// ============================================================ engine data
async function refresh() {
  let tasks;
  try { tasks = await getJSON('/tasks'); } catch { return; }
  if (!tasks.length) {
    app.task = null;
    app.version = -1;
    ingest(null);
    return;
  }
  app.task = tasks[0].id;
  const base = `/tasks/${encodeURIComponent(app.task)}`;
  const [health, state, timeline, live, runs] = await Promise.all([
    getJSON('/api/health'),
    getJSON(`${base}/state`),
    getJSON(`${base}/timeline`),
    getJSON(`${base}/context`),
    getJSON(`${base}/agent-runs`),
  ]);
  app.version = state.state_version;
  ingest({
    health, state, timeline, runs,
    ctx: live.context,
    briefing: live.briefing,
    briefingTokens: live.briefing_tokens,
    transcriptTokens: live.transcript_tokens,
  });
}

/** Follow the engine forever: long-poll /wait and refetch whenever the state version moves. */
async function follow() {
  for (;;) {
    try {
      if (!app.task) {
        await pause(700);
        await refresh();
        continue;
      }
      app.waitCtl = new AbortController();
      const url = `/tasks/${encodeURIComponent(app.task)}/wait?since=${app.version}&timeout_ms=20000`;
      const res = await fetch(url, { signal: app.waitCtl.signal, cache: 'no-store' }).then((r) => r.json());
      if (res.state_version !== app.version) await refresh();
    } catch {
      await pause(600);
    }
  }
}

// ============================================================ stage stream (SSE)
const STREAM_HANDLERS = {
  status(e) {
    app.stage = e;
    if (!e.busy) app.running = null;
    mergeProcs(e.procs);
    renderBeats();
    renderProcs();
    renderPipeBusy();
    if (!e.busy) refresh();
  },
  beat(e) {
    app.running = e.status === 'running' ? e.index : null;
    if (app.stage) app.stage.busy = e.status === 'running';
    if (e.status === 'error') log('stage', `beat ${e.index + 1} failed: ${e.error}`, 'l-kill');
    else if (!e.replay) log('stage', `${e.status === 'running' ? '▶' : '✓'} ${e.index + 1}. ${e.title}`);
    if (e.status === 'done' && !e.replay && app.stage && e.index === app.stage.beats.length - 1) setTimeout(finale, 2600);
    renderBeats();
    renderPipeBusy();
  },
  log(e) {
    log(e.proc, e.line);
    if (!e.replay && /compiled context v/.test(e.line)) flow(STAGE.STATE, STAGE.AGENT, false);
  },
  say(e) {
    log('stage', e.text);
  },
  proc(e) {
    const proc = app.procs.get(e.name) ?? { name: e.name };
    Object.assign(proc, { pid: e.pid, state: e.state, started: proc.started ?? e.t });
    if (e.state === 'killed' && !e.replay && app.timeline && proc.killedAt == null) {
      proc.killedAt = Math.max(0, (app.timeline?.events?.length ?? 1) - 1) + 0.45;
    }
    app.procs.set(e.name, proc);
    renderProcs();
    render();
    if (e.replay) return;
    if (e.state === 'killed') moment('kill', 'SIGKILL', `${e.name} · pid ${e.pid}`, 'agents running: 0 · the thread keeps going');
    else if (e.state === 'running' && e.name !== 'agent-a') moment('born', `${e.name}`, 'new process', `pid ${e.pid} · prior messages in memory: 0`);
  },
  reset() {
    app.procs.clear();
    app.seenEvents.clear();
    app.seenRuns.clear();
    app.version = -1;
    app.task = null;
    app.prevCtx = null;
    app.waitCtl?.abort();
    el('#term').innerHTML = '';
    log('stage', 'engine reset — fresh database, task PO-4817 created');
    ingest(null);
  },
};

function openStream() {
  const source = new EventSource('/stage/stream');
  source.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    STREAM_HANDLERS[e.type]?.(e);
  };
}

function mergeProcs(list = []) {
  for (const p of list) app.procs.set(p.name, { ...(app.procs.get(p.name) ?? {}), ...p });
  for (const name of [...app.procs.keys()]) {
    if (!list.some((p) => p.name === name)) app.procs.delete(name);
  }
}

// ============================================================ controls
async function advance() {
  if (app.mode === 'replay') return replayAdvance();
  if (app.mode !== 'stage' || app.stage?.busy) return;
  if (app.stage && app.stage.cursor >= app.stage.beats.length) return;
  app.stage.busy = true;
  renderBeats();
  try {
    await getJSON('/stage/next', { method: 'POST' });
  } catch (err) {
    log('stage', err.message, 'l-kill');
  }
}

async function restart() {
  if (app.mode === 'replay') return replayRestart();
  const btn = el('#reset');
  btn.disabled = true;
  try {
    await getJSON('/stage/reset', { method: 'POST' });
  } finally {
    btn.disabled = false;
  }
}

function onKey(e) {
  if (e.target.closest?.('input,textarea')) return;
  switch (e.key) {
    case 'ArrowRight':
    case ' ':
    case 'Enter':
      e.preventDefault();
      advance();
      break;
    case 'R':
      if (e.shiftKey) restart();
      break;
    case 'd':
    case 'D':
      showDetails(!document.body.classList.contains('details'));
      break;
    case 'Escape':
      showDetails(false);
      break;
    case '1': selectTab('evidence'); break;
    case '2': selectTab('handoff'); break;
    case '3': selectTab('briefing'); break;
    default: break;
  }
}

// ============================================================ ingest + render
function ingest(data) {
  if (!data) {
    Object.assign(app, { state: null, timeline: null, ctx: null, briefing: '', runs: [] });
    render();
    return;
  }
  const freshEvents = data.timeline.events.filter((e) => !app.seenEvents.has(e.id));
  const freshRuns = data.runs.filter((r) => !app.seenRuns.has(r.id));
  const firstLoad = app.seenEvents.size === 0 && app.seenRuns.size === 0;

  app.prevCtx = app.ctx;
  Object.assign(app, data);
  app.newEvents = new Set(firstLoad ? [] : freshEvents.map((e) => e.id));
  freshEvents.forEach((e) => app.seenEvents.add(e.id));
  freshRuns.forEach((r) => app.seenRuns.add(r.id));
  render();
  if (firstLoad) return;

  // replay what just happened through the pipeline, in causal order
  (async () => {
    for (let k = 0; k < freshRuns.length; k++) await flow(STAGE.STATE, STAGE.AGENT, false);
    for (const e of freshEvents) {
      if (e.direction === 'outbound') {
        await flow(STAGE.AGENT, STAGE.PRIMITIVE, true);
        await flow(STAGE.LOG, STAGE.STATE, false);
      } else {
        await flow(STAGE.PRIMITIVE, STAGE.STATE, false);
      }
    }
  })();

  const coldHandoff = freshRuns.some((r) => r.decision?.action === 'send'
    && r.decision?.prior_messages_in_process_memory === 0
    && r.agent_id !== 'agent-a');
  if (coldHandoff) {
    selectTab('handoff');
    el('#handoff-dot').textContent = '•';
  }
}

function render() {
  renderPresenter();
  renderTopBar();
  renderThread();
  renderEvidence();
  renderHandoff();
  renderBriefing();
  renderProcs();
  renderPipeLabels();
  renderBoard(el('#board'), app.ctx, { prev: app.prevCtx, version: app.state?.state_version ?? app.ctx?.meta?.state_version });
}

// ============================================================ top bar
function renderTopBar() {
  const health = app.health ?? {};
  const fallbackGoal = app.mode === 'replay' ? 'Replaying a recorded run of PO-4817' : 'waiting for the engine…';
  el('#goal').textContent = app.state?.task?.goal ?? app.ctx?.task?.goal ?? fallbackGoal;
  el('#alias').textContent = app.state?.task?.alias ?? 'PO-4817';

  const pills = [];
  if (app.mode === 'replay') pills.push('<span class="pill warn"><span class="dot warn"></span>recorded run</span>');
  if (health.transport) {
    const live = health.transport === 'primitive';
    pills.push(`<span class="pill ${live ? 'ok' : ''}"><span class="dot ${live ? 'on' : ''}"></span>${live ? 'Primitive · live mail' : 'Primitive · local sim'}</span>`);
  }
  if (health.extractor) pills.push(`<span class="pill">${/^llm/.test(health.extractor) ? 'Claude extractor' : 'rule extractor'}</span>`);
  if (health.agent_llm != null) pills.push(`<span class="pill">${health.agent_llm ? 'Claude agents' : 'policy agents'}</span>`);
  if (health.webhook_signature_verification) pills.push('<span class="pill ok">signed webhooks ✓</span>');
  const version = app.state?.state_version ?? app.ctx?.meta?.state_version;
  if (version != null) pills.push(`<span class="pill v">state v${version}</span>`);
  el('#badges').innerHTML = pills.join('');
}

// ============================================================ rail: beats + processes
function renderBeats() {
  const { beats, cursor } = storyPosition();
  // note: replay checks truthiness of the running index, matching the original console
  const busy = app.mode === 'replay' ? Boolean(app.running) : Boolean(app.stage?.busy);
  const activeIndex = app.running ?? cursor;

  el('#beats').innerHTML = beats.map((beat, i) => {
    let cls = '';
    if (i < cursor) cls = 'done';
    else if (busy && i === activeIndex) cls = 'running';
    else if (i === cursor) cls = 'next';
    const err = app.stage?.error && i === cursor ? 'error' : '';
    const mark = i < cursor ? '✓' : pad2(i + 1);
    return `<li class="beat ${cls} ${err}"><span class="n">${mark}</span><div><div class="tt">${esc(beat.title)}</div><div class="cp">${esc(beat.caption)}</div></div></li>`;
  }).join('');

  const finished = cursor >= beats.length;
  const button = el('#next');
  button.disabled = busy || finished || app.mode === 'engine';
  button.classList.toggle('busy', busy);
  renderPresenter();

  let label = 'Run next beat';
  if (busy) label = usesClaude() ? 'Claude is working…' : 'Working…';
  else if (finished) label = 'Complete ✓';
  else if (cursor === 0) label = 'Start the story';
  el('#next-l').textContent = label;
}

const HEARTBEAT = '<svg class="hb" viewBox="0 0 46 14"><path d="M0 7h12l3-5 4 10 3-5h24"/></svg>';

function procSubtitle(p) {
  if (p.engine) return p.sub;
  if (p.state === 'killed') return 'SIGKILL — gone, memory and all';
  if (p.state === 'running') return p.name === 'agent-a' ? 'long-running · watching inbox' : 'fresh process · memory 0';
  return `exited${p.code != null ? ` (${p.code})` : ''}`;
}

function renderProcs() {
  const rows = [];
  if (app.mode !== 'replay') {
    rows.push({ name: 'continuity', engine: true, state: 'running', sub: app.health ? `engine · ${app.health.extractor ?? ''}` : 'engine' });
  }
  rows.push(...app.procs.values());

  el('#procs').innerHTML = rows.map((p) => {
    const cls = p.engine ? 'engine' : p.state;
    const tail = p.state === 'running' || p.engine ? HEARTBEAT : `<span class="pid">${p.state === 'killed' ? '✕' : '·'}</span>`;
    return `<div class="proc ${cls}"><span class="nm">${esc(p.name)}</span><span class="pid">${p.pid ? `pid ${p.pid}` : ''}</span>${tail}<span class="sub">${esc(procSubtitle(p))}</span></div>`;
  }).join('') || '<div class="empty">no agent processes yet</div>';

  const alive = [...app.procs.values()].filter((p) => p.state === 'running').length;
  el('#proc-count').textContent = `${alive} agent${alive === 1 ? '' : 's'} running`;
}

// ============================================================ the thread
function buildThreadModel() {
  const events = app.timeline?.events ?? [];
  const count = events.length;
  const indexOf = (id) => events.findIndex((e) => e.id === id);
  const names = [...new Set([...app.runs.map((r) => r.agent_id), ...[...app.procs.values()].map((p) => p.name)])];

  // where a run sits on the line: the events it sent, else the last event it saw
  const runPositions = (run) => {
    const sent = (run.decision?.sent ?? []).map(indexOf).filter((i) => i >= 0);
    return sent.length ? sent : [Math.max(0, (run.context?.meta?.events_total ?? count) - 1)];
  };

  const agents = names.map((name) => {
    const runs = app.runs.filter((r) => r.agent_id === name);
    const proc = app.procs.get(name);
    let from;
    let to;
    if (runs.length) {
      from = Math.max(0, Math.min(...runPositions(runs[0])) - 0.45);
      to = Math.max(...runs.flatMap(runPositions));
    } else {
      from = to = Math.max(0, count - 1) + (count ? 0.5 : 0);
    }
    let state = 'alive';
    if (proc?.state === 'killed') state = 'killed';
    else if (proc?.state === 'running') state = 'alive';
    else if (runs.length) state = 'done';
    if (state === 'killed') to = proc?.killedAt ?? to + 0.45;
    const pid = proc?.pid ?? runs[0]?.decision?.pid;
    const note = name === 'agent-a' ? (pid ? `pid ${pid}` : '') : 'memory 0';
    return { name, from, to, state, note };
  }).sort((a, b) => a.from - b.from);

  const head = Math.max(0, count - 1, ...agents.filter((a) => a.state === 'killed').map((a) => a.to));

  // gaps: stretches with no living agent
  const gaps = [];
  let coveredTo = null;
  for (const a of agents) {
    if (coveredTo != null && a.from - coveredTo > 0.3) gaps.push({ from: coveredTo, to: a.from });
    coveredTo = Math.max(coveredTo ?? 0, a.to);
    if (a.state === 'alive') coveredTo = Infinity;
  }
  if (coveredTo != null && coveredTo !== Infinity && head - coveredTo > 0.3) gaps.push({ from: coveredTo, to: head });

  const hot = events.findIndex((e) => app.newEvents.has(e.id) && (e.transitions ?? []).some((t) => t.type === 'conflict_detected'));
  const nodes = events.map((e, i) => ({ id: e.id, label: eventLabel(e), dir: e.direction, hot: i === hot }));

  return {
    count,
    model: { slots: Math.max(8, count), nodes, head, agents, gaps },
    alive: agents.filter((a) => a.state === 'alive').length,
  };
}

function renderThread() {
  const { count, model, alive } = buildThreadModel();
  const paint = (box, height) => {
    if (!box.clientWidth) return; // hidden face
    box.innerHTML = count
      ? threadSVG(model, { width: Math.max(320, box.clientWidth), height })
      : `<div class="empty" style="height:${height}px;display:grid;place-items:center">the thread is empty</div>`;
  };
  paint(el('#thread'), 140);
  paint(el('#p-thread'), 200);
  el('#thread-meta').textContent = count
    ? `${count} emails · ${app.timeline?.threads?.length ?? 0} threads · ${alive ? `${alive} agent running` : 'no agent running'}`
    : '';
}

// ============================================================ presenter view
function showDetails(on) {
  document.body.classList.toggle('details', on);
  renderThread();
}

// a transition, said plainly: [cssClass, html] or null to skip it
function sayPlainly(t) {
  const text = t.summary ?? '';
  const grab = (re) => text.match(re);
  switch (t.type) {
    case 'conflict_detected':
      return ['bad', `✕ ${esc(grab(/— (.*?) —/)?.[1] ?? text)}. Deadline missed.`];
    case 'conflict_resolved':
      return ['ok', '✓ The deadline is met again.'];
    case 'claim_superseded': {
      const hit = grab(/changed ([\w.]+): (.*?) → (.*?)(?: \(|$)/);
      return hit ? ['', `${esc(hit[1].split('.')[0])}: <s>${esc(hit[2])}</s> → ${esc(hit[3])}`] : ['', esc(text)];
    }
    case 'injection_quarantined':
      return ['bad', 'Hidden instruction in the PDF: quarantined.'];
    case 'obligation_opened':
      return /committed to/.test(text) ? ['', `Owed to us: ${esc(text.split('committed to:')[1]?.trim() ?? text)}`] : null;
    case 'artifact_added':
      return ['', `Received ${esc(grab(/sent (.*?) \(/)?.[1] ?? 'a document')}`];
    case 'check_passed':
      return ['ok', `✓ ${esc(text.split(':')[0])}`];
    case 'obligation_resolved':
      return /fulfilled/.test(text) ? ['ok', `✓ Promise kept: ${esc(grab(/"(.*?)"/)?.[1] ?? '')}`] : null;
    case 'claim_added':
      return /decision\.order/.test(text) ? ['ok', '✓ Order accepted.'] : null;
    default:
      return null;
  }
}
const PLAIN_PRIORITY = ['conflict_detected', 'conflict_resolved', 'claim_superseded', 'injection_quarantined', 'obligation_opened', 'artifact_added', 'claim_added', 'obligation_resolved', 'check_passed'];
const priorityOf = (type) => (PLAIN_PRIORITY.indexOf(type) + 99) % 99; // unknown types sort last

const presenterCheck = (label) => label
  .replace('All units by ', 'All by ')
  .replace('Unit price within budget', 'Price within budget')
  .replace('Quantity 500 units', '500 units');

// greetings and sign-offs are not what the presenter wants to show
const isPleasantry = (line) => /^(hi|hello|dear|thanks,?|thank you,?|best|regards|best regards,?)\b/i.test(line) || /^(acme|\(po-)/i.test(line);

function restartAnimation(node) {
  node.style.animation = 'none';
  void node.offsetWidth;
  node.style.animation = '';
}

function justHappened() {
  const events = app.timeline?.events ?? [];
  const last = events.at(-1);
  const lastRun = app.runs.at(-1);
  const freshlyKilled = [...app.procs.values()].find((p) => p.state === 'killed' && p.killedAt != null && p.killedAt > events.length - 1);

  if (freshlyKilled) {
    return {
      cls: 'bad',
      html: `<div class="p-k">Just happened</div><div class="bad" style="--i:0">${esc(freshlyKilled.name)} · pid ${esc(freshlyKilled.pid ?? '')} · SIGKILL</div><div style="--i:1">Agents running: 0. The thread keeps going.</div>`,
    };
  }

  if (lastRun && last && lastRun.agent_id !== 'agent-a' && lastRun.decision?.sent?.includes(last.id)) {
    const body = lastRun.decision.messages?.[0]?.body ?? '';
    const prose = body.split('\n').map((l) => l.trim()).filter((l) => l && !isPleasantry(l)).join(' ');
    const firstTwo = (prose.match(/[^.?!]+[.?!]+/g) ?? [prose]).slice(0, 2).join(' ').trim();
    const memory = lastRun.decision.prior_messages_in_process_memory ?? 0;
    const tokens = (lastRun.context_tokens ?? 0).toLocaleString();
    return {
      cls: 'agent',
      html: `<div class="p-k">${esc(lastRun.agent_id)} wrote <b>${memory} messages in memory · ${tokens}-token briefing</b></div><div class="mail" style="--i:0">${esc(firstTwo)}</div>`,
    };
  }

  if (last) {
    const said = [...(last.transitions ?? [])]
      .sort((a, b) => priorityOf(a.type) - priorityOf(b.type))
      .map(sayPlainly)
      .filter(Boolean);
    const seen = new Set();
    const lines = said.filter(([, html]) => !seen.has(html) && seen.add(html)).slice(0, 3);
    if (!lines.length) {
      lines.push(['', last.direction === 'outbound'
        ? `${esc(last.from_label)} → ${esc((last.to_labels ?? []).join(', '))}: ${esc(last.subject)}`
        : `Email from ${esc(last.from_label)}`]);
    }
    return {
      cls: lines.some(([k]) => k === 'bad') ? 'bad' : 'hot',
      html: `<div class="p-k">Just happened <b>${esc(last.id)} · ${esc(last.from_label)}</b></div>${lines.map(([k, h], i) => `<div class="${k}" style="--i:${i}">${h}</div>`).join('')}`,
    };
  }

  return { cls: '', html: '<div class="p-k">Just happened</div><div class="quiet" style="--i:0">Nothing yet.</div>' };
}

function renderPresenter() {
  const { beats, cursor } = storyPosition();
  const busy = app.mode === 'replay' ? app.running != null : Boolean(app.stage?.busy);
  const current = busy ? beats[app.running ?? cursor] : beats[cursor - 1];

  // headline: the beat in flight or the last one finished
  const title = current?.title ?? (app.mode === 'engine' ? 'Following the engine.' : 'Agents forget.');
  const sub = current?.caption ?? (app.mode === 'engine' ? (app.state?.task?.goal ?? '') : 'Watch the thread.');
  const titleEl = el('#p-title');
  const subEl = el('#p-sub');
  if (titleEl.textContent !== title) {
    titleEl.textContent = title;
    subEl.textContent = sub;
    restartAnimation(titleEl);
    restartAnimation(subEl);
  }

  el('#p-count').textContent = beats.length
    ? `${pad2(Math.min(cursor + (busy ? 1 : 0), beats.length))} / ${pad2(beats.length)}`
    : '';

  let hint = '';
  if (busy) hint = `<span class="spin"></span>${usesClaude() && app.mode !== 'replay' ? 'Claude is working' : 'working'}`;
  else if (cursor < beats.length && app.mode !== 'engine') hint = `press <span class="kbd">→</span> ${cursor ? 'for the next beat' : 'to start'}`;
  el('#p-hint').innerHTML = hint;

  // tiles
  const c = app.ctx;
  el('#p-actor').innerHTML = `<div class="p-k">Next move</div><div class="actor ${esc(c?.next_actor ?? '')}">${c ? actorWord(c.next_actor) : '—'}</div>`;

  const checks = c?.checks ?? [];
  const checksEl = el('#p-checks');
  checksEl.className = `p-tile ${checks.some((x) => x.status === 'fail') ? 'bad' : ''}`;
  const lights = checks.map((x) => `<div class="light ${esc(x.status)}"><i></i>${esc(presenterCheck(x.check))}</div>`).join('')
    || '<div class="light"><i></i>no offer yet</div>';
  checksEl.innerHTML = `<div class="p-k">Requirements</div><div class="p-lights">${lights}</div>`;

  // only re-render (and re-animate) the "just happened" tile when its content changes
  const nowEl = el('#p-now');
  const { cls, html } = justHappened();
  if (nowEl.dataset.key !== html) {
    nowEl.dataset.key = html;
    nowEl.className = `p-tile p-now ${cls}`;
    nowEl.innerHTML = html;
  }
}

// ============================================================ pipeline
const pipeNodes = () => [...document.querySelectorAll('.pn')];

function buildPipe() {
  el('#pipe').innerHTML = '<div class="pipe-line"></div>'
    + PIPELINE.map(([name, note], i) => `<div class="pn ${i === STAGE.AGENT ? 'agent' : ''}" data-i="${i}"><b>${name}</b><span>${note}</span></div>`).join('');
}

function renderPipeLabels() {
  const nodes = pipeNodes();
  if (!nodes.length) return;
  const extractor = app.health?.extractor ?? (app.mode === 'replay' ? app.snap?.health?.extractor ?? '' : '');
  nodes[STAGE.READER].querySelector('b').textContent = /^llm/.test(extractor) ? 'Claude' : 'Rules';
  const hasState = app.state?.state_version != null || app.ctx;
  nodes[STAGE.STATE].querySelector('span').textContent = hasState ? `v${app.state?.state_version ?? app.ctx?.meta?.state_version}` : 'empty';
  nodes[STAGE.COMPILER].querySelector('span').textContent = app.briefingTokens ? `~${app.briefingTokens.toLocaleString()} tok` : 'briefing';
}

// which pipeline stages are busy while a beat runs
const INBOUND_BEATS = [1, 3, 4, 6];
const AGENT_BEATS = [0, 5, 7];
function renderPipeBusy() {
  const nodes = pipeNodes();
  nodes.forEach((n) => n.classList.remove('busy'));
  const beat = app.running;
  if (beat == null) return;
  if (INBOUND_BEATS.includes(beat)) {
    nodes[STAGE.PRIMITIVE].classList.add('busy');
    nodes[STAGE.READER].classList.add('busy');
  }
  if (AGENT_BEATS.includes(beat)) {
    nodes[STAGE.COMPILER].classList.add('busy');
    nodes[STAGE.AGENT].classList.add('busy');
  }
}

// packets travel one at a time, queued
let packetQueue = Promise.resolve();
function flow(from, to, outbound) {
  packetQueue = packetQueue.then(() => sendPacket(from, to, outbound));
  return packetQueue;
}

async function sendPacket(from, to, outbound) {
  const pipe = el('#pipe');
  const nodes = pipeNodes();
  if (!nodes.length || noMotion) return;
  const origin = pipe.getBoundingClientRect();
  const centreX = (i) => {
    const box = nodes[i].getBoundingClientRect();
    return box.left - origin.left + box.width / 2;
  };
  const packet = document.createElement('div');
  packet.className = `pkt ${outbound ? 'out' : ''}`;
  pipe.appendChild(packet);
  const dir = from < to ? 1 : -1;
  for (let i = from; ; i += dir) {
    const node = nodes[i];
    node.classList.add('lit');
    setTimeout(() => node.classList.remove('lit'), 650);
    if (i === to) break;
    await packet.animate(
      [{ left: `${centreX(i)}px` }, { left: `${centreX(i + dir)}px` }],
      { duration: 230, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards' },
    ).finished;
  }
  packet.remove();
}

// ============================================================ evidence stream
function emptyMailNote() {
  if (app.mode === 'stage') return 'Press <b>Start the story</b> (or →).';
  if (app.mode === 'replay') return 'Press <b>Start the story</b> (or →) to replay.';
  return '';
}

function renderEvidence() {
  const events = [...(app.timeline?.events ?? [])].reverse();
  const threadNo = Object.fromEntries((app.timeline?.threads ?? []).map((t, i) => [t.thread_id, i + 1]));

  const cards = events.map((e) => {
    const isNew = app.newEvents.has(e.id);
    const shown = (e.transitions ?? []).filter((t) => t.type !== 'event_ingested');
    const when = (e.occurred_at ?? '').slice(5, 16).replace('T', ' ');
    const files = e.attachments?.length
      ? `<div class="ev-a">${e.attachments.map((a) => `<span class="tag">📎 ${esc(a.filename)}</span>`).join('')}</div>`
      : '';
    const chips = shown.length
      ? `<div class="trs">${shown.map((t, i) => `<span class="tr ${esc(t.type)} ${isNew ? 'new' : ''}" style="--i:${i}">${esc(t.summary)}</span>`).join('')}</div>`
      : '';
    return `<div class="ev ${e.direction === 'outbound' ? 'out' : ''}" ${isNew ? '' : 'style="animation:none"'}>
      <div class="ev-h"><span class="who">${esc(e.from_label)}<i>→</i>${esc((e.to_labels ?? []).join(', '))}</span><span class="id">${esc(e.id)}</span><span class="meta">thread #${threadNo[e.thread_id] ?? '?'} · ${esc(when)}</span></div>
      <div class="ev-s">${esc(e.body_text)}</div>
      ${files}
      ${chips}
    </div>`;
  }).join('');

  const strays = (app.timeline?.unlinked ?? []).map((u) => `<div class="ev unlinked"><div class="ev-h"><span class="who">${esc(u.from)}</span><span class="id">${esc(u.id)}</span><span class="meta">not linked to any task · never merged by similarity</span></div><div class="ev-s">${esc(u.subject)}</div></div>`).join('');

  el('#v-evidence').innerHTML = (cards + strays) || `<div class="empty" style="padding:30px 4px">No mail yet. ${emptyMailNote()}</div>`;

  const transitionCount = events.reduce((sum, e) => sum + (e.transitions?.length ?? 0), 0);
  el('#stream-meta').textContent = events.length ? `${events.length} events · ${transitionCount} transitions` : '';
}

// ============================================================ handoff + briefing
function handoffCard(run) {
  const d = run.decision;
  const actions = (run.context?.suggested_actions ?? []).slice(0, 4);
  const mail = (d.messages ?? [])
    .map((m) => `<div class="ho-k"><span>email → ${esc(m.to)}</span><span>${d.sent?.length ? `sent ${esc(d.sent.join(', '))}` : ''}</span></div><pre>${esc(m.body)}</pre>`)
    .join('<br>');
  const actionList = actions.map((a) => `<div><b>P${a.priority}</b>${esc(a.action)}</div>`).join('') || `<div>${esc(d.rationale ?? '')}</div>`;
  const blocked = d.blocked?.length ? '<div class="ho-k blocked"><span>blocked by send guard</span></div>' : '';
  return `<div class="handoff">
      <div class="ho-card">
        <div class="ho-k"><span>${esc(run.agent_id)} · pid ${esc(d.pid ?? '?')}</span><span>${esc(d.wake_reason ?? '')}</span></div>
        <div class="ho-big">
          <div class="${d.prior_messages_in_process_memory === 0 ? 'zero' : ''}"><b>${d.prior_messages_in_process_memory ?? '?'}</b><span>messages in memory</span></div>
          <div><b>${(run.context_tokens ?? 0).toLocaleString()}</b><span>briefing tokens</span></div>
          <div><b>${(run.transcript_tokens ?? 0).toLocaleString()}</b><span>transcript would be</span></div>
        </div>
        <div class="ho-acts">${actionList}</div>
      </div>
      <div class="ho-card mail">${mail || `<div class="ho-k"><span>decision: ${esc(d.action)}</span></div><pre>${esc(d.rationale ?? '')}</pre>`}${blocked}</div>
    </div>`;
}

function renderHandoff() {
  const runs = app.runs.filter((r) => r.decision).reverse();
  el('#v-handoff').innerHTML = runs.map(handoffCard).join('') || '<div class="empty" style="padding:30px 4px">No agent has woken up yet.</div>';
}

function renderBriefing() {
  const text = app.briefing || '';
  el('#briefing').innerHTML = text
    ? esc(text).replace(/^(#+ .*)$/gm, '<span class="h">$1</span>')
    : '<span class="empty">The compiled briefing appears once the task has mail.</span>';
}

function selectTab(name) {
  app.tab = name;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === name));
  for (const key of ['evidence', 'handoff', 'briefing']) el(`#v-${key}`).hidden = key !== name;
  if (name === 'handoff') el('#handoff-dot').textContent = '';
}

// ============================================================ process output
function log(proc, line, cls = '') {
  const pre = el('#term');
  const row = document.createElement('span');
  const tone = cls || (/sent ev_|→ sent/.test(line) ? 'l-mail' : /SIGKILL|killed|failed/i.test(line) ? 'l-kill' : '');
  row.className = `ln ${tone}`;
  row.innerHTML = `<span class="p ${esc(proc)}">${esc(proc)}</span> ${esc(line.replace(/^\[agent-[abc] pid \d+\]\s*/, ''))}`;
  const pinnedToBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
  pre.appendChild(row);
  while (pre.childNodes.length > 500) pre.firstChild.remove();
  if (pinnedToBottom) pre.scrollTop = pre.scrollHeight;
}

// ============================================================ full-screen moments
let momentTimer = 0;

function moment(kind, title, kicker, sub) {
  if (noMotion) return;
  const overlay = el('#flashover');
  overlay.className = `flashover ${kind}`;
  el('#fo-k').textContent = kicker;
  el('#fo-t').innerHTML = kind === 'end' ? title : esc(title);
  el('#fo-s').textContent = sub;
  requestAnimationFrame(() => overlay.classList.add('on'));
  clearTimeout(momentTimer);
  momentTimer = setTimeout(() => overlay.classList.remove('on'), kind === 'kill' ? 2000 : 1500);
}

function finale() {
  const coldStarts = app.runs.filter((r) => r.decision?.prior_messages_in_process_memory === 0).length;
  const agentCount = new Set(app.runs.map((r) => r.agent_id)).size;
  const emails = app.timeline?.events?.length ?? 0;
  const threads = app.timeline?.threads?.length ?? 0;
  moment('end', 'One unbroken thread.',
    `${agentCount} agents · ${emails} emails · ${threads} threads`,
    `${coldStarts} cold starts with 0 messages in memory · every send checked against state`);
  clearTimeout(momentTimer);
  momentTimer = setTimeout(() => el('#flashover').classList.remove('on'), 5200);
}

// ============================================================ replay mode (no server)
async function startReplay() {
  try {
    app.snap = await fetch('assets/snapshot.json').then((r) => r.json());
  } catch {
    el('#goal').textContent = 'No engine reachable and no recording found.';
    return;
  }
  app.health = app.snap.health;
  el('#reset').textContent = 'Restart';
  log('stage', `replay mode — no engine reachable; stepping through a recorded run (${app.snap.captured_at.slice(0, 10)})`);
  replayRestart();
}

function replayRestart() {
  app.replayBeat = 0;
  app.running = null;
  app.procs.clear();
  app.seenEvents.clear();
  app.seenRuns.clear();
  app.prevCtx = null;
  app.ctx = null;
  ingest({
    health: app.snap.health, state: null,
    timeline: { events: [], threads: [], unlinked: [] },
    ctx: null, briefing: '', briefingTokens: 0, transcriptTokens: 0, runs: [],
  });
  renderBeats();
}

async function replayAdvance() {
  if (app.running != null || app.replayBeat >= REPLAY_SCRIPT.length) return;
  const i = app.replayBeat;
  const step = REPLAY_SCRIPT[i];
  const snap = app.snap;
  app.running = i;
  renderBeats();
  renderPipeBusy();
  log('stage', `▶ ${i + 1}. ${step.title}`);
  await pause(900);

  const events = snap.timeline.events;
  const cut = events.findIndex((e) => e.id === step.at);
  const runs = snap.runs.slice(0, step.runs);

  for (const [name, state] of Object.entries(step.procs ?? {})) {
    const firstRun = snap.runs.find((r) => r.agent_id === name);
    const before = app.procs.get(name)?.state;
    const proc = { ...(app.procs.get(name) ?? {}), name, pid: firstRun?.decision?.pid, state };
    if (state === 'killed' && proc.killedAt == null) proc.killedAt = cut + 0.45;
    app.procs.set(name, proc);
    if (before !== state && state === 'killed') moment('kill', 'SIGKILL', `${name} · pid ${firstRun?.decision?.pid ?? ''}`, 'agents running: 0 · the thread keeps going');
  }

  if (step.moment && step.moment !== 'kill') {
    const firstRun = snap.runs.find((r) => r.agent_id === step.moment);
    moment('born', step.moment, 'new process', `pid ${firstRun?.decision?.pid ?? ''} · prior messages in memory: 0`);
    await pause(1300);
  }

  for (const r of runs.filter((x) => !app.seenRuns.has(x.id))) {
    log(r.agent_id, `wake (${r.decision?.wake_reason ?? ''}) — ${r.decision?.action}: ${r.decision?.rationale ?? ''}`);
  }

  const asOf = snap.as_of[step.at];
  ingest({
    health: snap.health,
    state: { state_version: asOf.context.meta.state_version, task: { goal: asOf.context.task.goal, alias: asOf.context.meta.alias } },
    timeline: { ...snap.timeline, events: events.slice(0, cut + 1), unlinked: step.unlinked ? snap.timeline.unlinked : [] },
    ctx: asOf.context,
    briefing: asOf.briefing ?? '',
    briefingTokens: asOf.briefing_tokens,
    transcriptTokens: asOf.transcript_tokens,
    runs,
  });

  app.replayBeat = i + 1;
  app.running = null;
  if (app.replayBeat === REPLAY_SCRIPT.length) setTimeout(finale, 2600);
  renderBeats();
  renderPipeBusy();
  renderProcs();
  renderThread();
}

// ============================================================ wiring + boot
el('#next').onclick = advance;
el('#reset').onclick = restart;
el('#p-details').onclick = () => showDetails(true);
el('#flashover').addEventListener('click', () => el('#flashover').classList.remove('on'));
document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => selectTab(b.dataset.t); });
// linked evidence bodies expand on click
el('#v-evidence').addEventListener('click', (e) => e.target.closest('.ev:not(.unlinked) > .ev-s')?.classList.toggle('open'));
setupTheme();
addEventListener('keydown', onKey);
addEventListener('resize', () => renderThread());
if (new URLSearchParams(location.search).has('details')) document.body.classList.add('details');

async function detectMode() {
  try {
    app.stage = await getJSON('/stage/status');
    return 'stage';
  } catch {
    try {
      await getJSON('/api/health');
      return 'engine';
    } catch {
      return 'replay';
    }
  }
}

(async function boot() {
  app.mode = await detectMode();
  const tag = el('#mode-tag');
  tag.textContent = MODE_LABEL[app.mode];
  tag.className = `tag ${app.mode === 'replay' ? 'open' : 'ok'}`;
  buildPipe();
  if (app.mode === 'replay') return startReplay();
  if (app.mode === 'stage') {
    openStream();
  } else {
    el('#next').hidden = true;
    el('#reset').hidden = true;
  }
  renderBeats();
  await refresh();
  follow();
})();
