// The live engine console. The mode is chosen once, at load:
//   stage  — served by `npm run stage`: drives the story (POST /stage/next) and streams process output over SSE
//   engine — pointed at a plain Continuity server: read-only, follows state through the /wait long-poll
//   replay — nothing reachable: steps through the recorded run in assets/snapshot.json
// Two faces render the same state: the presenter view (default: the inbox beside what Continuity knows)
// and the details console (D).
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
  health: null, state: null, timeline: null, ctx: null, runs: [], approvals: [],
  briefing: '', briefingTokens: 0, transcriptTokens: 0,
  prevCtx: null,
  // stage + processes
  stage: null,
  procs: new Map(),
  running: null,       // index of the beat in flight
  // bookkeeping for "what is new"
  seenEvents: new Set(), seenRuns: new Set(), newEvents: new Set(),
  // presenter inbox: mail that just arrived, the message the viewer opened, where Agent A died in the feed
  freshMail: new Set(), openMail: null, killFeedLen: null,
  // the last answer given from this page, shown until the agent's next email lands
  answered: null, answering: false,
  tab: 'evidence',
  waitCtl: null,
  // replay
  snap: null,
  replayBeat: 0,
};

const MODE_LABEL = { stage: 'live · stage', engine: 'live · read-only', replay: 'replay' };

// the recorded run, beat by beat: what to reveal and which processes exist at that point
const REPLAY_SCRIPT = [
  { title: 'A deal begins.', caption: 'Agent A emails the supplier and finance.', at: 'ev_3', procs: { 'agent-a': 'running' }, runs: 2 },
  { title: 'Agent A dies.', caption: 'The deal keeps moving without it.', at: 'ev_6', procs: { 'agent-a': 'killed' }, runs: 2 },
  { title: 'Agent B wakes up.', caption: 'Brand-new process. Zero memory.', at: 'ev_7', procs: { 'agent-a': 'killed', 'agent-b': 'exited' }, runs: 3, moment: 'agent-b' },
  { title: 'The supplier fixes it.', caption: 'All 500 by Friday. Revised quote attached.', at: 'ev_8', procs: { 'agent-a': 'killed', 'agent-b': 'exited' }, runs: 3 },
  { title: 'Agent C closes.', caption: 'Agents propose. You decide.', at: 'ev_9', procs: { 'agent-a': 'killed', 'agent-b': 'exited', 'agent-c': 'exited' }, runs: 4, moment: 'agent-c' },
];

// Captions and a spotlight, beat by beat: what to say while it runs, then what to point at once it lands.
// Each cue is [selector, text]; a cue whose element is missing still shows its caption.
const tok = () => (app.briefingTokens ? `~${(Math.round(app.briefingTokens / 100) / 10).toFixed(1)}k tokens` : 'a short briefing');
const CUES = [
  {
    running: () => `Agent A emails the supplier and finance.${app.health?.transport === 'primitive' ? ' Real mail.' : ''}`,
    done: [
      ['#mail-open', 'The supplier quotes. PDF attached.'],
      ['#en-mem .mem', 'Continuity reads it into memory, with sources.'],
      ['#en-mem [data-k="flags"]', 'A hidden instruction in the PDF. Quarantined.'],
    ],
  },
  {
    running: 'Agent A is killed. Its memory is gone.',
    done: [
      ['#mail', 'Mail keeps coming. Nobody is reading.'],
      ['#en-mem [data-k="delivery.schedule"]', 'Delivery changed. The old value is kept, struck out.'],
      ['#en-mem [data-k="owed"]', 'The supplier now owes a revised quote.'],
    ],
  },
  {
    running: 'Agent B starts. Zero messages in memory.',
    retrieve: 'One call: Continuity hands it the state.',
    done: [
      ['#en-now', () => `It reads ${tok()} of state, not the inbox.`],
      ['#mail-open', 'Then writes the right email. Never saw the thread.'],
    ],
  },
  {
    running: 'The supplier answers Agent B.',
    done: [
      ['#en-mem [data-k="owed"]', 'Promise kept. The loop closes itself.'],
      ['#en-mem [data-k="checks"]', 'Every requirement passes.'],
    ],
  },
  {
    running: 'Agent C, another fresh process, drafts the order.',
    human: ['#en-now', 'Committing money waits for a human.'],
    answered: ['#mail-list .mrow.open', () => (app.health?.transport === 'primitive' ? 'Approved. Sent through Primitive.' : 'Approved. Sent.')],
    done: [],
  },
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
const actorWord = (who) => ({ us: 'Us', them: 'Them', human: 'You' })[who] ?? 'Nobody';

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
  const [health, state, timeline, live, runs, approvals] = await Promise.all([
    getJSON('/api/health'),
    getJSON(`${base}/state`),
    getJSON(`${base}/timeline`),
    getJSON(`${base}/context`),
    getJSON(`${base}/agent-runs`),
    getJSON(`${base}/approvals`).catch(() => []),
  ]);
  app.version = state.state_version;
  ingest({
    health, state, timeline, runs, approvals,
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
    if (!e.busy) {
      const landed = app.cueDone;
      app.cueDone = null;
      refresh().then(() => { if (landed != null) playCues(landed); });
    }
  },
  beat(e) {
    app.running = e.status === 'running' ? e.index : null;
    if (e.status === 'running' && !e.replay) app.freshMail = new Set();
    if (!e.replay && e.status === 'running') cue(CUES[e.index]?.running);
    if (!e.replay && e.status === 'done') app.cueDone = e.index;
    if (app.stage) app.stage.busy = e.status === 'running';
    if (e.status === 'error') log('stage', `beat ${e.index + 1} failed: ${e.error}`, 'l-kill');
    else if (!e.replay) log('stage', `${e.status === 'running' ? '▶' : '✓'} ${e.index + 1}. ${e.title}`);
    if (e.status === 'done' && !e.replay && app.stage && e.index === app.stage.beats.length - 1) {
      app.finaleDue = true;
      setTimeout(maybeFinale, 2600);
    }
    renderBeats();
    renderPipeBusy();
  },
  log(e) {
    log(e.proc, e.line);
    if (!e.replay && /compiled context v/.test(e.line)) {
      flow(STAGE.STATE, STAGE.AGENT, false);
      if (e.proc !== 'agent-a') {
        // the "new process" moment covers the page for a beat; show the retrieval once it lifts
        const beat = app.running;
        pause(el('#flashover').classList.contains('on') ? 1700 : 0).then(() => {
          cue(CUES[beat]?.retrieve, '#en-mem');
          retrieveSweep();
        });
      }
    }
  },
  say(e) {
    log('stage', e.text);
  },
  proc(e) {
    const proc = app.procs.get(e.name) ?? { name: e.name };
    Object.assign(proc, { pid: e.pid, state: e.state, started: proc.started ?? e.t });
    if (e.state === 'killed' && !e.replay && app.timeline && proc.killedAt == null) {
      proc.killedAt = Math.max(0, (app.timeline?.events?.length ?? 1) - 1) + 0.45;
      if (e.name === 'agent-a') app.killFeedLen = mailFeed().length;
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
    app.freshMail = new Set();
    app.openMail = null;
    app.killFeedLen = null;
    app.answered = null;
    askedFor = null;
    app.finaleDue = false;
    cue(null);
    shownRows.clear();
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
  // while a person is being asked, the keys answer (presenter view only)
  const ask = !document.body.classList.contains('details') && openHuman()[0];
  if (ask && !e.metaKey && !e.ctrlKey) {
    const k = e.key.toLowerCase();
    let option = null;
    if (k === 'a') option = ask.kind === 'approval' ? 'approve' : 'verified';
    else if (k === 'r' && !e.shiftKey) option = 'reject';
    if (option) {
      e.preventDefault();
      answerHuman(ask.id, option);
      return;
    }
  }
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
    case 'c':
    case 'C':
      document.body.classList.toggle('no-cap');
      placeSpot();
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
    Object.assign(app, { state: null, timeline: null, ctx: null, briefing: '', runs: [], approvals: [] });
    render();
    return;
  }
  const freshEvents = data.timeline.events.filter((e) => !app.seenEvents.has(e.id));
  const freshStrays = (data.timeline.unlinked ?? []).filter((u) => !app.seenEvents.has(u.id));
  const freshRuns = data.runs.filter((r) => !app.seenRuns.has(r.id));
  const firstLoad = app.seenEvents.size === 0 && app.seenRuns.size === 0;

  app.prevCtx = app.ctx;
  Object.assign(app, data);
  app.newEvents = new Set(firstLoad ? [] : freshEvents.map((e) => e.id));
  const freshMail = firstLoad ? [] : [...freshEvents.map((e) => e.id), ...freshStrays.map((u) => u.id)];
  // "fresh" means new in the current beat (a beat can bring several refreshes); following a plain engine, new in this refresh
  if (freshMail.length) {
    if (app.mode === 'engine') app.freshMail = new Set();
    freshMail.forEach((id) => app.freshMail.add(id));
    app.openMail = null;
  }
  freshEvents.forEach((e) => app.seenEvents.add(e.id));
  freshStrays.forEach((u) => app.seenEvents.add(u.id));
  freshRuns.forEach((r) => app.seenRuns.add(r.id));
  render();
  if (firstLoad) return;
  animateArrivals(mailFeed().filter((item) => app.freshMail.has(item.id) && freshMail.includes(item.id)));

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
  if (version != null) pills.push(`<span class="pill v">state v${esc(version)}</span>`);
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
    return `<div class="proc ${esc(cls)}"><span class="nm">${esc(p.name)}</span><span class="pid">${p.pid ? `pid ${esc(p.pid)}` : ''}</span>${tail}<span class="sub">${esc(procSubtitle(p))}</span></div>`;
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
  paint(el('#p-thread'), 118);
  el('#thread-meta').textContent = count
    ? `${count} emails · ${app.timeline?.threads?.length ?? 0} threads · ${alive ? `${alive} agent running` : 'no agent running'}`
    : '';
}

// ============================================================ presenter view: the inbox | what Continuity knows
// Left: the agent's mailbox as any mail client would show it. Right: the state Continuity compiled from that mail.
// The contrast is the pitch: after Agent A dies, mail piles up unread on the left, while the right side keeps
// up, and a new agent acts from the right side alone.
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
      return hit ? ['', `${esc(TERM_NAMES[hit[1]] ?? hit[1])}: <s>${esc(hit[2])}</s> → ${esc(hit[3])}`] : ['', esc(text)];
    }
    case 'injection_quarantined':
      return ['bad', 'Hidden instruction in the PDF: quarantined, never obeyed.'];
    case 'obligation_opened':
      return /committed to/.test(text) ? ['', `They now owe us: ${esc(text.split('committed to:')[1]?.trim() ?? text)}`] : null;
    case 'artifact_status':
      return /partially stale/.test(text) ? ['', `${esc(grab(/^(\S+)/)?.[1] ?? 'The quote')} is now partly stale (delivery only).`] : ['', esc(text)];
    case 'artifact_superseded':
      return ['', esc(text)];
    case 'obligation_resolved':
      return /fulfilled/.test(text) ? ['ok', `✓ Promise kept: ${esc(grab(/"(.*?)"/)?.[1] ?? '')}`] : null;
    case 'claim_added':
      return /decision\.order/.test(text) ? ['ok', '✓ Order accepted.'] : null;
    default:
      return null;
  }
}
const PLAIN_PRIORITY = ['conflict_detected', 'conflict_resolved', 'claim_superseded', 'injection_quarantined', 'obligation_opened', 'artifact_status', 'artifact_superseded', 'claim_added', 'obligation_resolved'];
const priorityOf = (type) => (PLAIN_PRIORITY.indexOf(type) + 99) % 99; // unknown types sort last

const TERM_NAMES = {
  'price.unit': 'price',
  'delivery.schedule': 'delivery',
  'order.quantity': 'quantity',
  'payment.terms': 'payment',
  'quote.valid_until': 'valid until',
  'budget.max_unit_price': 'budget',
  'decision.order': 'order',
};

const presenterCheck = (label) => label
  .replace('All units by ', 'All by ')
  .replace('Unit price within budget', 'Price within budget')
  .replace('Quantity 500 units', '500 units');

// greetings and sign-offs are not what the presenter wants to show
const isPleasantry = (line) => /^(hi|hello|dear|best|regards|best regards,?)\b/i.test(line)
  || (/^(thanks|thank you)\b/i.test(line) && line.length < 48)
  || /^(acme|\(po-)/i.test(line);

function restartAnimation(node) {
  node.style.animation = 'none';
  void node.offsetWidth;
  node.style.animation = '';
}

// ---------------------------------------------------------------- the mailbox model
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const mailTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${DAYS[d.getUTCDay()]} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dueDay = (day) => {
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
const partyOf = (label) => (app.ctx?.task?.parties ?? []).find((p) => p.label === label);
const personName = (name) => String(name ?? '').replace(/\s*\(.*\)\s*$/, '');
const initials = (name) => personName(name).split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const firstSentences = (body, n = 2) => {
  const prose = String(body ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !isPleasantry(l) && !/^>/.test(l)).join(' ');
  // a sentence ends at . ? ! followed by a space or the end ("$11.48" does not end one)
  return (prose.match(/.+?[.?!]+(?=\s|$)/g) ?? [prose]).slice(0, n).join(' ').trim();
};

/** Every message the inbox holds, oldest first: the task's mail plus anything that was never linked to it. */
function mailFeed() {
  const events = app.timeline?.events ?? [];
  const writer = new Map();
  for (const run of app.runs) for (const id of run.decision?.sent ?? []) writer.set(id, run);
  const items = events.map((e, index) => {
    const out = e.direction === 'outbound';
    const to = partyOf(e.to_labels?.[0]);
    const from = e.from_name ?? personName(partyOf(e.from_label)?.name) ?? e.from;
    return {
      id: e.id, index, at: e.occurred_at, out, stray: false,
      who: out ? `To: ${personName(to?.name) || e.to?.[0] || ''}` : from,
      face: out ? 'Acme' : from,
      addr: e.from, to: e.to ?? [], subject: e.subject ?? '', body: e.body_text ?? '',
      files: e.attachments ?? [], run: writer.get(e.id), event: e,
    };
  });
  for (const u of app.timeline?.unlinked ?? []) {
    items.push({ id: u.id, index: -1, at: u.at, out: false, stray: true, who: u.from, face: u.from, addr: u.from, to: [], subject: u.subject ?? '', body: '', files: [] });
  }
  // an email Continuity is holding for a person sits in the outbox, unsent
  for (const r of openHuman().filter((x) => x.kind === 'approval' && x.draft)) {
    const to = partyOf(r.draft.to);
    items.push({
      id: r.id, index: events.length, at: r.since, out: true, stray: false, held: true, asker: r.asked_by,
      who: `To: ${personName(to?.name) || r.draft.to}`, face: 'Acme', addr: app.ctx?.task?.you_are?.match(/<(.*)>/)?.[1] ?? '',
      to: [to?.address ?? r.draft.to], subject: r.draft.subject, body: r.draft.body, files: [], run: null, event: null,
    });
  }
  return items.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.index - b.index);
}

/** Position in the feed from which nobody was running to read the mail (null while Agent A lives). */
function killPoint(feed) {
  if (app.killFeedLen != null) return app.killFeedLen;
  // after a page reload the kill moment is gone; Agent A's last run says how far into the mail it got
  if (app.procs.get('agent-a')?.state !== 'killed') return null;
  const seen = Math.max(0, ...app.runs.filter((r) => r.agent_id === 'agent-a').map((r) => r.context?.meta?.events_total ?? 0));
  const at = feed.findIndex((item) => !item.stray && item.index >= seen);
  return at < 0 ? feed.length : at;
}

const isCold = (run) => run && run.agent_id !== 'agent-a';

/**
 * What waits on a person right now: approval cards (a held send, or a payment detail to verify), in the
 * shape the page draws. `draft.to` is the party label.
 */
const openHuman = () => (app.approvals ?? []).filter((a) => a.status === 'pending' || a.status === 'held').map((a) => {
  const party = (app.ctx?.task?.parties ?? []).find((p) => p.address.toLowerCase() === a.draft?.to?.toLowerCase());
  return {
    id: a.id, kind: a.kind === 'send' ? 'approval' : 'verify', asked_by: a.draft?.agent_id ?? 'Continuity', since: a.created_at, title: a.title,
    party: party?.label ?? null,
    draft: a.draft ? { to: party?.label ?? a.draft.to, subject: a.draft.subject ?? '', body: a.draft.body } : null,
  };
});

/** The message the beat is about: the newest task mail that just arrived (a stray promo never steals focus). */
function focusItem(feed) {
  const held = feed.find((i) => i.held);
  if (held) return held;
  const fresh = feed.filter((i) => app.freshMail.has(i.id));
  const pool = fresh.length ? fresh : feed;
  return pool.filter((i) => !i.stray).at(-1) ?? pool.at(-1);
}

const shownRows = new Set(); // rows that already played their arrival animation

function cleanBody(text) {
  const cut = text.search(/\n\s*On [^\n]+wrote:\s*\n/);
  const main = (cut >= 0 ? text.slice(0, cut) : text).split('\n').filter((l) => !/^\s*>/.test(l)).join('\n').trim();
  return { main, quoted: cut >= 0 };
}

// ---------------------------------------------------------------- A: the inbox
function renderMail(feed) {
  const cut = killPoint(feed);
  const unread = (item, i) => !item.out && cut != null && i >= cut;
  const alive = [...app.procs.values()].some((p) => p.state === 'running');
  const orphaned = !alive && [...app.procs.values()].some((p) => p.state === 'killed');

  el('#mail-addr').textContent = app.ctx?.task?.you_are?.match(/<(.*)>/)?.[1] ?? '';
  const unreadCount = feed.filter(unread).length;
  const counter = el('#mail-unread');
  counter.textContent = feed.length ? `${unreadCount ? `${unreadCount} unread · ` : ''}${feed.length} messages` : '';
  counter.classList.toggle('some', unreadCount > 0);
  el('#mail').classList.toggle('orphaned', orphaned);
  el('#mail-dead').hidden = !orphaned;

  const openId = feed.some((i) => i.id === app.openMail) ? app.openMail : focusItem(feed)?.id;
  const rows = feed.map((item, i) => {
    const run = item.run;
    let by = item.out && run ? `<span class="by ${isCold(run) ? 'cold' : ''}">${esc(run.agent_id)}</span>` : '';
    if (item.held) by = `<span class="by held">held · ${esc(item.asker)}</span>`;
    const clip = item.files.length ? '📎' : '';
    const snippet = item.stray ? '' : firstSentences(cleanBody(item.body).main, 1);
    const cls = [
      'mrow',
      item.out ? 'out' : '',
      item.stray ? 'stray' : '',
      item.held ? 'held' : '',
      unread(item, i) ? 'unread' : '',
      item.id === openId ? 'open' : '',
      app.freshMail.has(item.id) && !shownRows.has(item.id) ? 'fresh' : '',
    ].join(' ');
    shownRows.add(item.id);
    return `<li class="${cls}" data-id="${esc(item.id)}">
      <span class="dot"></span><span class="av">${esc(initials(item.face))}</span>
      <span class="who">${esc(item.who)}</span>
      <span class="line"><span class="subj">${esc(item.subject)}</span>${snippet ? `<span class="snip"> — ${esc(snippet)}</span>` : ''}</span>
      <span class="meta">${by}${clip}<span>${esc(mailTime(item.at))}</span></span>
    </li>`;
  }).reverse().join('');
  const list = el('#mail-list');
  list.innerHTML = rows || `<li class="mail-empty">${app.mode === 'engine' ? 'No mail yet.' : 'Empty inbox. Press → to start.'}</li>`;
  list.scrollTop = 0;

  renderOpenMail(feed.find((i) => i.id === openId));
}

function renderOpenMail(item) {
  const box = el('#mail-open');
  if (!item) {
    box.innerHTML = '';
    return;
  }
  if (box.dataset.id === item.id && box.dataset.v === String(app.runs.length) && !item.held === !box.dataset.held) return;
  box.dataset.held = item.held ? '1' : '';
  box.dataset.id = item.id;
  box.dataset.v = String(app.runs.length);

  const { main, quoted } = cleanBody(item.body);
  const from = item.out ? 'Acme Procurement' : item.who;
  const to = item.out ? item.who.replace(/^To: /, '') : 'me';
  const files = item.files.map((f) => `<span class="mo-file"><i>PDF</i>${esc(f.filename)}</span>`).join('');
  const run = item.run;
  const held = item.held
    ? `<div class="mo-held"><b>Not sent yet.</b> Waiting for your OK.</div>`
    : '';
  const cold = isCold(run)
    ? `<div class="mo-by">Written by <b>${esc(run.agent_id)}</b>, which never opened this inbox.</div>`
    : '';
  box.innerHTML = `
    ${held}
    <h2 class="mo-subj">${esc(item.subject)}</h2>
    <div class="mo-from"><b>${esc(from)}</b><span>&lt;${esc(item.addr)}&gt; to ${esc(to)}</span><span class="when">${esc(mailTime(item.at))}</span></div>
    ${item.stray
      ? '<div class="mo-stray">A promo from a sender this task has never written to. Same topic, different thread.</div>'
      : `<pre class="mo-body">${esc(main)}</pre>${quoted ? '<div class="mo-quoted">··· quoted text hidden</div>' : ''}`}
    ${files ? `<div class="mo-files">${files}</div>` : ''}
    ${cold}`;
  box.scrollTop = 0;
}

// ---------------------------------------------------------------- B: Continuity
const PRES_PIPE = ['Primitive', 'Read', 'Resolve', 'State', 'Brief'];

function buildPresPipe() {
  el('#en-pipe').innerHTML = PRES_PIPE.map((name) => `<li><b>${name}</b><span></span></li>`).join('');
}

function renderPresPipe() {
  const steps = [...el('#en-pipe').children];
  if (!steps.length) return;
  const extractor = app.health?.extractor ?? '';
  const version = app.state?.state_version ?? app.ctx?.meta?.state_version;
  const notes = [
    app.health?.transport === 'primitive' ? 'live mail' : app.mode === 'replay' ? 'recorded' : 'local sim',
    /^llm/.test(extractor) ? 'Claude reads' : 'rules read',
    'claims → facts',
    version != null ? `v${version}` : 'empty',
    app.briefingTokens ? `~${app.briefingTokens.toLocaleString()} tok` : '—',
  ];
  steps.forEach((li, i) => { li.querySelector('span').textContent = notes[i]; });
  const pending = app.ctx?.processing?.pending_events?.length > 0;
  steps[1].classList.toggle('busy', pending);
  const agentBeat = app.running != null && AGENT_BEATS.includes(app.running);
  steps[4].classList.toggle('busy', agentBeat && !pending);
}

/** Light the steps one after another: inbound mail goes left to right, an agent's send right to left. */
async function lightPresPipe(outbound) {
  const steps = [...el('#en-pipe').children];
  const order = outbound ? [4, 3, 0] : [0, 1, 2, 3];
  for (const i of order) {
    steps[i]?.classList.add('lit');
    setTimeout(() => steps[i]?.classList.remove('lit'), 1400);
    await pause(noMotion ? 0 : 160);
  }
}

/** A packet crosses the seam between a row in the inbox and the Continuity side. */
async function crossSeam(id, outbound) {
  const split = el('#split');
  const row = split.querySelector(`.mrow[data-id="${CSS.escape(id)}"]`);
  if (!row || noMotion || !split.clientWidth) return;
  const origin = split.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  const engineBox = split.querySelector('.engine-side').getBoundingClientRect();
  const y = rowBox.top - origin.top + rowBox.height / 2;
  const left = rowBox.right - origin.left - 6;
  const right = engineBox.left - origin.left + 6;
  const pipeY = el('#en-pipe').getBoundingClientRect().top - origin.top + 4;
  const packet = document.createElement('div');
  packet.className = `pkt-x ${outbound ? 'out' : ''}`;
  split.appendChild(packet);
  const path = outbound
    ? [{ left: `${right}px`, top: `${pipeY}px` }, { left: `${left}px`, top: `${y}px` }]
    : [{ left: `${left}px`, top: `${y}px` }, { left: `${right}px`, top: `${pipeY}px` }];
  await packet.animate(path, { duration: 520, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards' }).finished;
  packet.remove();
}

let presQueue = Promise.resolve();
function animateArrivals(items) {
  for (const item of items) {
    presQueue = presQueue.then(async () => {
      if (item.out) {
        await lightPresPipe(true);
        await crossSeam(item.id, true);
      } else {
        await crossSeam(item.id, false);
        if (!item.stray) await lightPresPipe(false);
      }
    });
  }
}

function claimChips(event) {
  const transitions = event.transitions ?? [];
  const backed = new Set(transitions.filter((t) => t.type === 'claim_corroborated').map((t) => t.summary.match(/^\S+ ([\w.]+) =/)?.[1]));
  return transitions.filter((t) => t.type === 'claim_added').map((t, i) => {
    const hit = t.summary.match(/^[^:]+: ([\w.]+) = (.*?)(?: \(from (.*)\))?$/);
    if (!hit || hit[1] === 'decision.order') return '';
    const [, key, value, file] = hit;
    const source = backed.has(key) ? 'email + PDF' : file ? 'PDF' : 'email';
    return `<span class="chip ${file ? 'pdf' : ''}" style="--i:${i}">${esc(TERM_NAMES[key] ?? key)} <b>${esc(value)}</b><small>${source}</small></span>`;
  }).join('');
}

function nowCard(feed) {
  const head = (k, b = '') => `<div class="nk"><span>${k}</span><b>${b}</b></div>`;
  const line = (cls, html, i) => `<div class="ln ${cls}" style="--i:${i}">${html}</div>`;
  const events = app.timeline?.events ?? [];
  const killed = [...app.procs.values()].find((p) => p.state === 'killed' && p.killedAt != null && p.killedAt > events.length - 1);
  if (killed) {
    return {
      cls: 'bad',
      html: head('Just now', `${esc(killed.name)} · pid ${esc(killed.pid ?? '')}`)
        + line('bad', 'Agent A is gone, memory and all.', 0)
        + line('', 'Continuity keeps reading the mail.', 1),
    };
  }

  const asks = openHuman();
  if (asks.length) return humanCard(asks[0], head);

  // the answer just given from this page, until the agent's next email shows up
  const a = app.answered;
  if (a && feed.filter((i) => !i.held).length <= a.feedLen && !openHuman().length) {
    let next = `${esc(a.asker)} is acting on it…`;
    if (a.kind === 'approval') next = a.option === 'approve' ? 'Sending it now.' : 'Nothing was sent.';
    return { cls: 'human done', html: head('You decided', esc(a.asker)) + line('', esc(a.label), 0) + line('quiet', next, 1) };
  }

  const pending = app.ctx?.processing?.pending_events ?? [];
  if (pending.length) {
    return { cls: 'quiet', html: head('Reading', esc(pending.join(', '))) + line('quiet', `${usesClaude() ? 'Claude' : 'The rule extractor'} is reading the new email…`, 0) };
  }

  const last = focusItem(feed);
  if (!last) {
    return { cls: 'empty', html: '' };
  }

  if (last.stray) {
    return {
      cls: 'quiet',
      html: head('Just arrived', esc(last.addr))
        + line('', 'Not part of this deal. Ignored.', 0),
    };
  }

  if (last.out && isCold(last.run)) {
    const run = last.run;
    const d = run.decision ?? {};
    return {
      cls: 'agent',
      html: head(`${esc(run.agent_id)} · a brand-new process`, `pid ${esc(d.pid ?? '?')}`)
        + `<div class="ho-n"><div class="zero"><b>${esc(d.prior_messages_in_process_memory ?? 0)}</b><span>messages in memory</span></div><div><b>${esc((run.context_tokens ?? 0).toLocaleString())}</b><span>briefing tokens</span></div></div>`
        + `<div class="ho-wrote">${esc(clip(firstSentences(d.messages?.[0]?.body ?? '', 1), 120))}</div>`,
    };
  }

  if (last.out) {
    const sent = feed.filter((i) => i.out && app.freshMail.has(i.id));
    const batch = sent.length ? sent : [last];
    const asks = [...new Set(batch.flatMap((i) => (i.event.transitions ?? [])
      .filter((t) => t.type === 'obligation_opened')
      .map((t) => t.summary.replace(/ \[issue: .*\]$/, '').replace(/^Acme \(us\) (asked|requested) (\w+): /, (_, __, who) => `${who}: `))))];
    return {
      cls: '',
      html: head(`${esc(last.run?.agent_id ?? 'Acme')} sent ${batch.length} email${batch.length === 1 ? '' : 's'}`, esc(batch.map((i) => i.id).join(', ')))
        + asks.slice(0, 2).map((a, i) => line('quiet', `→ ${esc(clip(a, 80))}`, i)).join(''),
    };
  }

  const said = [...(last.event.transitions ?? [])]
    .sort((a, b) => priorityOf(a.type) - priorityOf(b.type))
    .map(sayPlainly)
    .filter(Boolean);
  const seen = new Set();
  const lines = said.filter(([, html]) => !seen.has(html) && seen.add(html)).slice(0, 3);
  const passed = (last.event.transitions ?? []).filter((t) => t.type === 'check_passed').length;
  if (passed && lines.length < 4) lines.push(['ok', `✓ ${passed} requirement${passed === 1 ? '' : 's'} now pass${passed === 1 ? 'es' : ''}`]);
  const chips = claimChips(last.event);
  const stray = feed.find((i) => i.stray && app.freshMail.has(i.id));
  if (stray) lines.push(['quiet', 'A promo also arrived. Ignored: not part of this deal.']);
  return {
    cls: lines.some(([k]) => k === 'bad') ? 'bad' : '',
    html: head(`Read ${esc(last.id)} from ${esc(last.who)}`, esc(last.event.link_reason?.replace(/^Primitive thread \S+ belongs to task$/, 'linked by Primitive thread') ?? ''))
      + (chips ? `<div class="chips">${chips}</div>` : '')
      + lines.map(([k, h], i) => line(k, h, i + 1)).join(''),
  };
}

/** The moment an agent hands over to a person: one question, what is at stake, and the choices as buttons. */
function humanCard(r, head) {
  const c = app.ctx;
  const term = (key) => c?.current_terms?.find((t) => t.term === key)?.value;
  const name = (personName(partyOf(r.party ?? r.draft?.to)?.name) || r.party || 'them').split(' ')[0];
  let question;
  let facts = '';
  let options;
  if (r.kind === 'approval') {
    question = `Send this order to ${name}?`;
    const price = parseFloat(String(term('price.unit') ?? '').replace(/[$,]/g, ''));
    const qty = parseFloat(String(term('order.quantity') ?? ''));
    const total = price && qty ? `$${(price * qty).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : null;
    const checks = c?.checks ?? [];
    const met = checks.filter((x) => x.status === 'pass').length;
    facts = `<div class="hfacts">${total ? `<span><b>${esc(total)}</b><small>${esc(term('order.quantity'))} × ${esc(term('price.unit'))}</small></span>` : ''}<span><b>${met}/${checks.length}</b><small>requirements met</small></span></div>`;
    options = [{ id: 'approve', lead: 'Approve and send', key: 'A' }, { id: 'reject', lead: 'Reject', key: 'R' }];
  } else {
    question = `${r.title}?`;
    options = [{ id: 'verified', lead: 'Verified by phone', sub: 'Apply the new detail', key: 'A' }, { id: 'reject', lead: 'Reject', sub: 'Not genuine', key: 'R' }];
  }
  const buttons = options.map((o, i) => `<button class="hopt ${i === 0 ? 'primary' : ''}" data-req="${esc(r.id)}" data-opt="${esc(o.id)}"${app.answering ? ' disabled' : ''}>
      <span class="kbd">${o.key}</span><span><b>${esc(o.lead)}</b>${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</span></button>`).join('');
  return {
    cls: 'human',
    html: head(r.kind === 'approval' ? `${esc(r.asked_by)} needs your OK` : 'Continuity needs you to verify', 'paused')
      + `<div class="hq">${esc(question)}</div>${facts}<div class="hopts ${r.kind}">${buttons}</div>`,
  };
}

/** Answer a request from the page; the agent waiting on it carries on by itself. */
async function answerHuman(id, option) {
  const req = openHuman().find((r) => r.id === id);
  if (!req || app.answering || !app.task) return;
  app.answering = true;
  document.querySelectorAll('.hopt').forEach((b) => { b.disabled = true; });
  const label = { approve: 'Approved and sent.', verified: 'Verified and applied.', reject: 'Rejected.' }[option] ?? option;
  // measured before answering: an approval sends right away, so the email may land before the reply
  const feedLen = mailFeed().filter((i) => !i.held).length;
  try {
    await getJSON(`/tasks/${encodeURIComponent(app.task)}/approvals/${encodeURIComponent(id)}/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ option, by: 'the procurement lead' }),
    });
    app.answered = { id, kind: req.kind, option, label, asker: req.asked_by, feedLen };
    log('stage', `you answered ${req.asked_by}: ${label}`);
    if (option === 'approve') {
      const [selector, text] = CUES.find((c) => c.answered)?.answered ?? [];
      // the email shows up in the inbox once the engine has sent it
      setTimeout(() => cue(text, selector), 900);
      setTimeout(maybeFinale, 4200);
    } else {
      cue(null);
    }
  } catch (err) {
    log('stage', `answer failed: ${err.message}`, 'l-kill');
  } finally {
    app.answering = false;
    await refresh();
  }
}

/** Write a card only when its content changes, and flash it when that happens mid-story. */
function setCard(node, html, cls = '') {
  if (node.dataset.key === html) return;
  const changed = node.dataset.key != null;
  node.dataset.key = html;
  node.innerHTML = html;
  node.className = `${node.id === 'en-now' ? 'en-now' : 'en-card'} ${cls}`;
  if (changed && node.id !== 'en-now') {
    node.classList.add('chg');
    restartAnimation(node);
  }
}

function renderEngine(feed) {
  const c = app.ctx;
  const version = app.state?.state_version ?? c?.meta?.state_version;
  el('#en-ver').textContent = version != null ? `state v${version}` : '';
  renderPresPipe();

  const { cls, html } = nowCard(feed);
  setCard(el('#en-now'), html, cls);

  renderMemory(c);
}

/**
 * What Continuity remembers, as one ledger: each row is a current fact with the email it came from.
 * Superseded values stay visible (struck through); a row that changed this beat flashes.
 */
const memPrev = new Map();
function memoryRows(c) {
  const terms = c.current_terms ?? [];
  const term = (key) => terms.find((t) => t.term === key);
  const src = (t) => t?.stated_in?.at(-1) ?? '';
  const rows = [];
  const order = term('decision.order');
  if (order) rows.push({ k: 'order', label: 'Order', html: '<span class="tag ok">accepted</span>', src: src(order) });
  const price = term('price.unit');
  if (price) {
    const old = (c.superseded_terms_do_not_use ?? []).filter((x) => x.term === 'price.unit').at(-1);
    rows.push({ k: 'price.unit', label: 'Price', html: `${old ? `<s>${esc(old.old_value)}</s> → ` : ''}${esc(price.value)}`, src: old?.changed_in ?? src(price), via: price.documents?.length ? 'email + PDF' : 'email' });
  }
  const delivery = term('delivery.schedule');
  if (delivery) {
    const old = (c.superseded_terms_do_not_use ?? []).filter((x) => x.term === 'delivery.schedule').at(-1);
    const late = (c.conflicts ?? []).length > 0;
    rows.push({
      k: 'delivery.schedule', label: 'Delivery', bad: late,
      html: `${old ? `<s>${esc(old.old_value)}</s> → ` : ''}${esc(delivery.value)}${late ? ' <span class="tag fail">late</span>' : ''}`,
      src: old?.changed_in ?? src(delivery),
    });
  }
  const budget = term('budget.max_unit_price');
  if (budget) rows.push({ k: 'budget', label: 'Budget', html: `up to ${esc(budget.value)} <small>finance</small>`, src: src(budget) });
  const doc = (c.documents ?? []).filter((d) => d.kind === 'quote' && d.status !== 'superseded').at(-1) ?? (c.documents ?? []).filter((d) => d.kind === 'quote').at(-1);
  if (doc) {
    const status = { partially_stale: 'partly stale', current: 'current', superseded: 'superseded' }[doc.status] ?? doc.status;
    const name = doc.filename.match(/Q-[\w-]+?(?=\.pdf$)/i)?.[0]?.replace(/-rev/, ' rev ') ?? doc.filename;
    rows.push({ k: 'quote', label: 'Quote', bad: doc.status === 'partially_stale', html: `${esc(name)} <span class="tag ${esc(doc.status)}">${esc(status)}</span>`, src: doc.received_in });
  }
  const owed = (c.waiting_on_them ?? []).find((o) => o.kind === 'commitment');
  const kept = (c.resolved_commitments ?? []).at(-1);
  if (owed) rows.push({ k: 'owed', label: 'Owed', html: `${esc(owed.owed_by)} → ${esc(clip(owed.what.replace(/ by tomorrow$/, ''), 40))}${owed.due ? ` <small>due ${esc(dueDay(owed.due))}</small>` : ''}`, src: owed.source });
  else if (kept) rows.push({ k: 'owed', label: 'Owed', ok: true, html: `✓ ${esc(kept.by ?? 'they')} kept it: ${esc(clip(kept.what.replace(/ by tomorrow$/, ''), 36))}`, src: kept.resolved_in });
  const injected = (c.flags ?? []).filter((f) => f.kind === 'prompt_injection_suspected');
  if (injected.length) rows.push({ k: 'flags', label: 'Blocked', bad: true, html: `${injected.length === 1 ? 'Hidden instruction in PDF' : `${injected.length} hidden instructions`} <span class="tag fail">quarantined</span>`, src: injected[0].event });
  return rows;
}

function renderMemory(c) {
  const box = el('#en-mem');
  if (!c || !(c.current_terms ?? []).length) {
    memPrev.clear();
    box.innerHTML = '<div class="mem-empty">Empty. Nothing learned yet.</div>';
    return;
  }
  const checks = c.checks ?? [];
  const passing = checks.filter((x) => x.status === 'pass').length;
  const rows = memoryRows(c).map((r, i) => {
    const changed = memPrev.has(r.k) && memPrev.get(r.k) !== r.html;
    const fresh = memPrev.size > 0 && !memPrev.has(r.k);
    return `<div class="mm ${r.bad ? 'bad' : ''} ${r.ok ? 'ok' : ''} ${changed ? 'chg' : ''} ${fresh ? 'new' : ''}" data-k="${esc(r.k)}" data-src="${esc(r.src ?? '')}" style="--i:${i}">
      <dt>${esc(r.label)}</dt><dd>${r.html}</dd><cite>${esc(r.src ?? '')}${r.via ? `<small>${esc(r.via)}</small>` : ''}</cite></div>`;
  });
  // requirements only show once they say something: one is broken, or all of them pass
  const failing = checks.some((x) => x.status === 'fail');
  const allPass = checks.length > 0 && passing === checks.length;
  const lights = failing || allPass ? checks.map((x) => `<span class="light ${esc(x.status)}"><i></i>${esc(presenterCheck(x.check))}</span>`).join('') : '';
  const html = `
    <div class="mem-h"><span>Memory</span><span class="mem-next" data-k="next">next: <b class="actor ${esc(c.next_actor ?? '')}">${actorWord(c.next_actor)}</b></span></div>
    <dl class="mem">${rows.join('')}</dl>
    ${lights ? `<div class="mem-checks ${failing ? 'bad' : ''}" data-k="checks">${lights}</div>` : ''}`;
  if (box.dataset.key === html) return;
  box.dataset.key = html;
  box.innerHTML = html;
  memPrev.clear();
  for (const r of memoryRows(c)) memPrev.set(r.k, r.html);
}

/** Retrieval: an agent asks Continuity for its context; every remembered fact is pulled into the briefing. */
async function retrieveSweep() {
  if (noMotion) return;
  const rows = [...document.querySelectorAll('#en-mem .mm, #en-mem .mem-next, #en-mem .mem-checks')];
  rows.forEach((row, i) => {
    setTimeout(() => {
      row.classList.remove('pull');
      void row.offsetWidth;
      row.classList.add('pull');
    }, i * 90);
  });
  await pause(rows.length * 90 + 200);
  const brief = el('#en-pipe').children[4];
  brief?.classList.add('lit');
  setTimeout(() => brief?.classList.remove('lit'), 1600);
}

function renderPresenter() {
  const { beats, cursor } = storyPosition();
  const busy = app.mode === 'replay' ? app.running != null : Boolean(app.stage?.busy);
  const current = busy ? beats[app.running ?? cursor] : beats[cursor - 1];

  // headline: the beat in flight or the last one finished
  const title = current?.title ?? (app.mode === 'engine' ? 'Following the engine.' : 'Agents forget.');
  const sub = current?.caption ?? (app.mode === 'engine' ? (app.state?.task?.goal ?? '') : 'Continuity remembers for them.');
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
  const ask = openHuman()[0];
  if (ask) hint = '<span class="you">Your call</span> press <span class="kbd">A</span> or <span class="kbd">R</span>';
  else if (busy) hint = `<span class="spin"></span>${usesClaude() && app.mode !== 'replay' ? 'Claude is working' : 'working'}`;
  else if (cursor < beats.length && app.mode !== 'engine') hint = `press <span class="kbd">→</span> ${cursor ? 'next' : 'to start'}`;
  el('#p-hint').innerHTML = hint;

  const askers = new Set(openHuman().map((r) => r.asked_by));
  // only the agent the story is about right now: the newest one
  el('#ib-agents').innerHTML = [...app.procs.values()].slice(-1).map((p) => {
    const waiting = p.state === 'running' && askers.has(p.name);
    let note = p.state === 'killed' ? 'killed' : p.state === 'running' ? 'running' : 'done';
    if (waiting) note = 'waiting on you';
    return `<span class="ag ${esc(p.state)} ${waiting ? 'wait' : ''}"><i></i>${esc(p.name)} · ${note}</span>`;
  }).join('');

  const feed = mailFeed();
  renderMail(feed);
  renderEngine(feed);
  cueHuman();
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
const AGENT_BEATS = [0, 2, 4];
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
  const actionList = actions.map((a) => `<div><b>P${esc(a.priority)}</b>${esc(a.action)}</div>`).join('') || `<div>${esc(d.rationale ?? '')}</div>`;
  const blocked = d.blocked?.length ? '<div class="ho-k blocked"><span>blocked by send guard</span></div>' : '';
  return `<div class="handoff">
      <div class="ho-card">
        <div class="ho-k"><span>${esc(run.agent_id)} · pid ${esc(d.pid ?? '?')}</span><span>${esc(d.wake_reason ?? '')}</span></div>
        <div class="ho-big">
          <div class="${d.prior_messages_in_process_memory === 0 ? 'zero' : ''}"><b>${esc(d.prior_messages_in_process_memory ?? '?')}</b><span>messages in memory</span></div>
          <div><b>${esc((run.context_tokens ?? 0).toLocaleString())}</b><span>briefing tokens</span></div>
          <div><b>${esc((run.transcript_tokens ?? 0).toLocaleString())}</b><span>transcript would be</span></div>
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

/** The closing card, once nothing waits on a person any more (the last beat ends on an approval). */
function maybeFinale() {
  if (!app.finaleDue || openHuman().length) return;
  app.finaleDue = false;
  finale();
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

// ============================================================ captions + spotlight
// One short line at a time, and a ring around the thing it is about. C hides them (e.g. when talking live).
let cueToken = 0;
let spotTarget = null;
const captionsOn = () => !document.body.classList.contains('no-cap');

function cue(text, selector = null) {
  cueToken++;
  showCue(text, selector);
}

function showCue(text, selector) {
  const line = typeof text === 'function' ? text() : text;
  const cap = el('#cap');
  if (!line) {
    cap.classList.remove('on');
    spotOn(null);
    return;
  }
  el('#cap-t').textContent = line;
  cap.classList.remove('on');
  void cap.offsetWidth;
  cap.classList.add('on');
  spotOn(selector);
}

async function playCues(index) {
  const steps = CUES[index]?.done ?? [];
  if (!steps.length) return;
  const mine = ++cueToken;
  await pause(700);
  for (const [selector, text] of steps) {
    if (mine !== cueToken) return;
    // a cue about something that is not on screen this run is skipped
    if (selector && !document.querySelector(selector)) continue;
    showCue(text, selector);
    await pause(3000);
  }
  if (mine === cueToken) spotOn(null);
}

function spotOn(selector) {
  spotTarget = selector;
  placeSpot();
}

function placeSpot() {
  const spot = el('#spot');
  const target = spotTarget && document.querySelector(spotTarget);
  const visible = target && captionsOn() && !document.body.classList.contains('details');
  spot.classList.toggle('on', Boolean(visible));
  if (!visible) return;
  const r = target.getBoundingClientRect();
  const padding = 6;
  Object.assign(spot.style, {
    left: `${r.left - padding}px`, top: `${r.top - padding}px`,
    width: `${r.width + padding * 2}px`, height: `${r.height + padding * 2}px`,
  });
}
setInterval(placeSpot, 250);
// for scripted recordings: drive a caption by hand, e.g. stageCue('Text', '#en-mem')
window.stageCue = cue;

// the person in the loop: say so when an agent hands over, and again once they answered
let askedFor = null;
function cueHuman() {
  const ask = openHuman()[0];
  if (!ask && askedFor && !app.answered) {
    askedFor = null;
    cue(null);
  }
  if (ask && askedFor !== ask.id) {
    askedFor = ask.id;
    const [selector, text] = CUES.find((c) => c.human)?.human ?? [];
    cue(text, selector);
  }
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
  cue(null);
  app.running = null;
  app.procs.clear();
  app.seenEvents.clear();
  app.seenRuns.clear();
  app.prevCtx = null;
  app.ctx = null;
  app.freshMail = new Set();
  app.openMail = null;
  app.killFeedLen = null;
  shownRows.clear();
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
  app.freshMail = new Set();
  renderBeats();
  renderPipeBusy();
  log('stage', `▶ ${i + 1}. ${step.title}`);
  cue(CUES[i]?.running);
  await pause(900);

  const events = snap.timeline.events;
  const cut = events.findIndex((e) => e.id === step.at);
  const runs = snap.runs.slice(0, step.runs);

  for (const [name, state] of Object.entries(step.procs ?? {})) {
    const firstRun = snap.runs.find((r) => r.agent_id === name);
    const before = app.procs.get(name)?.state;
    const proc = { ...(app.procs.get(name) ?? {}), name, pid: firstRun?.decision?.pid, state };
    if (state === 'killed' && proc.killedAt == null) {
      // killed before this beat's mail: the mail that arrives afterwards is what the beat is about
      const before = i > 0 ? events.findIndex((e) => e.id === REPLAY_SCRIPT[i - 1].at) : cut;
      proc.killedAt = before + 0.45;
      if (name === 'agent-a') app.killFeedLen = mailFeed().length;
    }
    app.procs.set(name, proc);
    if (before !== state && state === 'killed') moment('kill', 'SIGKILL', `${name} · pid ${firstRun?.decision?.pid ?? ''}`, 'agents running: 0 · the thread keeps going');
  }

  if (step.moment && step.moment !== 'kill') {
    const firstRun = snap.runs.find((r) => r.agent_id === step.moment);
    moment('born', step.moment, 'new process', `pid ${firstRun?.decision?.pid ?? ''} · prior messages in memory: 0`);
    await pause(1600);
    if (CUES[i]?.retrieve) {
      cue(CUES[i].retrieve, '#en-mem');
      await retrieveSweep();
      await pause(900);
    }
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
  playCues(i);
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
// the "needs you" card answers on click
el('#en-now').addEventListener('click', (e) => {
  const button = e.target.closest('[data-opt]');
  if (button && !button.disabled) answerHuman(button.dataset.req, button.dataset.opt);
});
// hovering a remembered fact lights the email it came from
el('#en-mem').addEventListener('mouseover', (e) => {
  const row = e.target.closest('[data-src]');
  document.querySelectorAll('.mrow.cited').forEach((r) => r.classList.remove('cited'));
  if (row?.dataset.src) document.querySelector(`.mrow[data-id="${CSS.escape(row.dataset.src)}"]`)?.classList.add('cited');
});
el('#en-mem').addEventListener('mouseleave', () => document.querySelectorAll('.mrow.cited').forEach((r) => r.classList.remove('cited')));
// any message in the presenter inbox opens on click
el('#mail-list').addEventListener('click', (e) => {
  const row = e.target.closest('.mrow');
  if (!row) return;
  app.openMail = row.dataset.id;
  renderPresenter();
});
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
  buildPresPipe();
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
