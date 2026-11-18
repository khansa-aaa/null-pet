// null's loop. A session goes idle → (debounce) → plan for THAT project only → a card for
// the user (manual) or straight to dispatch (auto, safe actions only) → sessions go busy → idle → …
const EventEmitter = require('events');
const crypto = require('crypto');
const settings = require('./settings');
const memory = require('./memory');
const snapshot = require('./snapshot');
const planner = require('./planner');
const summary = require('./summary');
const roster = require('./roster');
const abilities = require('./abilities');
const usage = require('./usage');
const { riskOf } = require('./risk');
const { log } = require('./log');

const CARD_FRESH_MS = 10 * 60 * 1000; // a pending card younger than this isn't re-planned on every idle
const AUTO_PER_HOUR = 12; // runaway guard for auto mode, per project

class Brain extends EventEmitter {
  constructor(watcher, dispatcher, { closer, opener } = {}) {
    super();
    this.watcher = watcher;
    this.dispatcher = dispatcher; // (project, actions, opts) => results
    this.closer = closer || (async () => ({}));
    this.opener = opener || (async () => ({ where: 'nowhere' }));
    this.cards = new Map(); // project id -> card
    this.planning = new Set(); // project ids with a planner run in flight
    this.again = new Map(); // project id -> reason, when a trigger arrived mid-plan
    this.debounce = new Map(); // project id -> timer
    this.autoLog = new Map(); // project id -> [timestamps]
    this.errors = new Map(); // project id -> last error message
    this.notes = new Map(); // project id -> [{ from, text }]: /summary results and chat without a card
    this.summarizing = new Set();
    this.needs = new Map(); // project id -> the latest needs_you list from the planner
    this.closing = new Set(); // pids being closed
    this.rosterTimer = null;

    watcher.on('idle', (pid, s) => this.onIdle(pid, s));
    watcher.on('change', () => {
      this.emitState();
      clearTimeout(this.rosterTimer);
      this.rosterTimer = setTimeout(() => this.labelSessions(), 10 * 1000);
    });
  }

  sessions(pid) {
    return this.watcher.list()[pid] || [];
  }

  // The sessions null may plan for and send to: not paused, with their purpose attached.
  workable(pid) {
    return this.sessions(pid)
      .filter((s) => !roster.isPaused(pid, s.sessionId))
      .map((s) => ({ ...s, purpose: roster.purposeOf(pid, s.sessionId) }));
  }

  // Writes the one-line purpose of new or much-changed sessions (one short run per project).
  async labelSessions() {
    for (const p of settings.read().projects.filter((x) => x.enabled !== false)) {
      try {
        if (await roster.refresh(p, this.sessions(p.id))) this.emitState();
      } catch (e) {
        log('labels failed', p.id, e.message);
      }
    }
  }

  state() {
    const s = settings.read();
    const by = this.watcher.list();
    return {
      mode: s.mode,
      paused: s.paused,
      usage: usage.summary(),
      projects: s.projects.map((p) => ({
        id: p.id,
        name: p.name,
        enabled: p.enabled !== false,
        planning: this.planning.has(p.id),
        summarizing: this.summarizing.has(p.id),
        notes: (this.notes.get(p.id) || []).slice(-6),
        error: this.errors.get(p.id) || null,
        sessions: (by[p.id] || []).map((x) => ({ name: x.name, status: x.status })),
        roster: this.rosterView(p, by[p.id] || []),
        closing: [...this.closing],
        needs: this.needs.get(p.id) || []
      })),
      cards: [...this.cards.values()]
    };
  }

  rosterView(p, live) {
    try {
      return roster.view(p, live);
    } catch (e) {
      log('roster failed', p.id, e.message);
      return { open: live.map((s) => ({ pid: s.pid, sessionId: s.sessionId, name: s.name, status: s.status })), closed: [] };
    }
  }

  emitState() {
    this.emit('state', this.state());
  }

  onIdle(pid, session) {
    const p = settings.project(pid);
    if (!p || p.enabled === false || settings.read().paused) return;
    if (roster.isPaused(pid, session.sessionId)) return;
    clearTimeout(this.debounce.get(pid));
    const wait = (settings.read().idle_debounce_s || 20) * 1000;
    this.debounce.set(
      pid,
      setTimeout(() => {
        const now = this.sessions(pid).find((s) => s.pid === session.pid);
        if (!now || now.status !== 'idle') return; // the user (or someone) already gave it more work
        const card = this.cards.get(pid);
        if (card && Date.now() - card.createdAt < CARD_FRESH_MS) {
          this.emitState(); // the card stays; its idle list refreshes in the UI
          return;
        }
        this.trigger(pid, `session "${session.name}" just finished its turn`);
      }, wait)
    );
  }

  async trigger(pid, reason) {
    const p = settings.project(pid);
    if (!p || p.enabled === false) return;
    if (this.planning.has(pid)) {
      this.again.set(pid, reason);
      return;
    }
    this.planning.add(pid);
    this.errors.delete(pid);
    this.emit('thinking', true);
    this.emitState();
    try {
      const sessions = this.workable(pid);
      const snap = await snapshot.build(p, sessions);
      const s = settings.read();
      const { rec, session, denials } = await planner.recommend(p, snap, sessions, { reason, usage: usage.summary(), maxBusy: s.max_busy_per_project });
      await this.accept(p, rec, session, { reason, denials });
    } catch (e) {
      log('plan failed', pid, e.message);
      this.errors.set(pid, e.message);
      this.emit('error', { project: pid, message: e.message });
    } finally {
      this.planning.delete(pid);
      this.emit('thinking', this.planning.size > 0);
      this.emitState();
      const again = this.again.get(pid);
      if (again) {
        this.again.delete(pid);
        if (!this.cards.has(pid)) setTimeout(() => this.trigger(pid, again), 1000);
      }
    }
  }

  // Turn the planner's answer into a card, checking every target against the live sessions.
  normalize(p, rec) {
    const sessions = this.workable(p.id);
    const idle = new Set(sessions.filter((s) => s.status === 'idle').map((s) => s.name));
    const used = new Set();
    return (rec.actions || []).map((a) => {
      const act = { id: crypto.randomUUID(), ...a };
      if (act.target_kind === 'existing' && (!idle.has(act.target_session) || used.has(act.target_session))) {
        const spare = [...idle].find((n) => !used.has(n));
        if (spare) act.target_session = spare;
        else {
          act.target_kind = 'new';
          act.target_session = '';
        }
      }
      if (act.target_kind === 'existing') used.add(act.target_session);
      act.risk = riskOf(act);
      return act;
    });
  }

  autoAllowed(pid) {
    const s = settings.read();
    if (s.mode !== 'auto' || s.paused) return false;
    const u = usage.summary();
    if (u.limited) return false;
    if (u.week && u.week.utilization >= (s.week_cap || 0.95)) return false;
    const recent = (this.autoLog.get(pid) || []).filter((t) => Date.now() - t < 3600 * 1000);
    this.autoLog.set(pid, recent);
    return recent.length < AUTO_PER_HOUR;
  }

  async accept(p, rec, plannerSession, { reason, chat = [], denials = [] }) {
    const requests = abilities.requestsFrom(denials);
    if (requests.length) log('abilities requested', p.id, requests.map((r) => r.rule).join(', '));
    if (rec.memory_update) memory.writeMemory(p.id, rec.memory_update);
    if (Array.isArray(rec.needs_you)) this.needs.set(p.id, rec.needs_you.filter((n) => n && n.ask));
    const actions = this.normalize(p, rec);
    memory.addHistory(p.id, { event: 'recommended', title: actions.map((a) => a.title).join(' | ') || '(nothing)', note: rec.status });
    let pending = actions;
    if (this.autoAllowed(p.id)) {
      const safe = actions.filter((a) => !a.risk);
      pending = actions.filter((a) => a.risk);
      if (safe.length) {
        this.autoLog.get(p.id).push(...safe.map(() => Date.now()));
        await this.run(p, safe, { auto: true });
      }
    }
    if (!pending.length && !rec.reply && !requests.length && !(this.needs.get(p.id) || []).length) {
      this.cards.delete(p.id);
      if (!actions.length) this.emit('toast', { project: p.id, text: `${p.name}: ${rec.status || 'nothing to do right now.'}` });
      return;
    }
    const card = {
      id: crypto.randomUUID(),
      project: p.id,
      projectName: p.name,
      status: rec.status,
      reason,
      actions: pending,
      plannerSession,
      chat: rec.reply ? [...chat, { from: 'null', text: rec.reply }] : chat,
      requests, // abilities the planner was refused: Allow always / Not now
      createdAt: Date.now(),
      busy: false
    };
    this.cards.set(p.id, card);
    this.emit('card', card);
  }

  async run(p, actions, { auto }) {
    // Last check: a target that went busy (or was paused) since planning gets another idle session or a new tab.
    const sessions = this.workable(p.id);
    const idle = sessions.filter((s) => s.status === 'idle').map((s) => s.name);
    const taken = new Set();
    for (const a of actions) {
      if (a.target_kind !== 'existing') continue;
      if (idle.includes(a.target_session) && !taken.has(a.target_session)) taken.add(a.target_session);
      else {
        const spare = idle.find((n) => !taken.has(n));
        if (spare) {
          a.target_session = spare;
          taken.add(spare);
        } else {
          a.target_kind = 'new';
          a.target_session = '';
        }
      }
    }
    this.emit('sending', { project: p.id, count: actions.length });
    const results = await this.dispatcher(p, actions, { auto });
    for (const r of results) {
      memory.addHistory(p.id, { event: r.ok ? (auto ? 'auto-sent' : 'sent') : 'send-failed', title: r.action.title, target: r.target, note: r.ok ? '' : r.detail });
    }
    this.emit('sent', { project: p.id, results: results.map((r) => ({ title: r.action.title, ok: r.ok, target: r.target, detail: r.detail })) });
    return results;
  }

  async approve(cardId, actionIds) {
    const card = [...this.cards.values()].find((c) => c.id === cardId);
    if (!card || card.busy) return;
    const p = settings.project(card.project);
    const chosen = card.actions.filter((a) => !actionIds || actionIds.includes(a.id));
    const skipped = card.actions.filter((a) => !chosen.includes(a));
    card.busy = true;
    this.emitState();
    for (const a of skipped) memory.addHistory(p.id, { event: 'skipped', title: a.title });
    try {
      await this.run(p, chosen, { auto: false });
    } finally {
      this.cards.delete(card.project);
      this.emitState();
    }
  }

  async reject(cardId, why) {
    const card = [...this.cards.values()].find((c) => c.id === cardId);
    if (!card || card.busy) return;
    const p = settings.project(card.project);
    for (const a of card.actions) memory.addHistory(p.id, { event: 'rejected', title: a.title, note: why || '' });
    const text = `The user rejected these: ${card.actions.map((a) => `"${a.title}"`).join(', ')}.${why ? ` Reason: ${why}` : ' No reason given.'} Remember this in memory_update, and recommend something different.`;
    await this.converse(card, text, { from: 'you', text: why ? `Rejected: ${why}` : 'Rejected.' });
  }

  async chat(cardId, text) {
    const card = [...this.cards.values()].find((c) => c.id === cardId);
    if (!card || card.busy || !String(text || '').trim()) return;
    await this.converse(card, text, { from: 'you', text });
  }

  note(pid, entry) {
    const list = [...(this.notes.get(pid) || []), entry].slice(-12);
    this.notes.set(pid, list);
    this.emitState();
  }

  // Anything typed in a project's chat box: /summary, chat about the waiting card, or (no card) a
  // request that null plans around.
  async say(pid, text) {
    const t = String(text || '').trim();
    const p = settings.project(pid);
    if (!p || !t) return;
    if (/^\/summary\b/i.test(t)) return this.summary(p);
    const card = this.cards.get(pid);
    if (card) return this.chat(card.id, t);
    this.note(pid, { from: 'you', text: t });
    return this.trigger(pid, `The user asked: ${t}`);
  }

  async summary(p) {
    if (this.summarizing.has(p.id)) return;
    this.summarizing.add(p.id);
    this.note(p.id, { from: 'you', text: '/summary' });
    this.emit('thinking', true);
    try {
      this.note(p.id, { from: 'null', text: await summary.run(p), kind: 'summary' });
    } catch (e) {
      log('summary failed', p.id, e.message);
      this.note(p.id, { from: 'null', text: `Summary failed: ${e.message}` });
    } finally {
      this.summarizing.delete(p.id);
      this.emit('thinking', this.planning.size > 0);
      this.emitState();
    }
  }

  async converse(card, text, shown) {
    const p = settings.project(card.project);
    card.busy = true;
    card.chat = [...card.chat, shown];
    this.emit('thinking', true);
    this.emitState();
    try {
      const idle = this.workable(p.id).filter((s) => s.status === 'idle').map((s) => s.name);
      const { rec, session, denials } = await planner.followUp(p, card.plannerSession, text, { idle, maxBusy: settings.read().max_busy_per_project });
      this.cards.delete(p.id);
      await this.accept(p, rec, session, { reason: card.reason, chat: card.chat, denials });
    } catch (e) {
      card.busy = false;
      card.chat = [...card.chat, { from: 'null', text: `Something went wrong: ${e.message}` }];
      this.emitState();
    } finally {
      this.emit('thinking', this.planning.size > 0);
      this.emitState();
    }
  }

  liveSession(pid) {
    for (const [projectId, list] of Object.entries(this.watcher.list())) {
      const s = list.find((x) => x.pid === pid);
      if (s) return { projectId, s };
    }
    return null;
  }

  // Ends an idle session (it can be reopened). Never one that is working.
  async closeSession(pid) {
    const hit = this.liveSession(Number(pid));
    if (!hit) return { ok: false, text: 'That session is already gone.' };
    if (hit.s.status !== 'idle') return { ok: false, text: `${hit.s.name} is working; close it when it's idle.` };
    this.closing.add(hit.s.pid);
    this.emitState();
    try {
      const r = await this.closer(hit.s);
      memory.addHistory(hit.projectId, { event: 'closed', title: hit.s.name });
      return { ok: true, text: `Closed ${hit.s.name}${r && r.tab ? ' and its tab' : ''}. Open it again any time.` };
    } catch (e) {
      return { ok: false, text: `Couldn't close ${hit.s.name}: ${e.message}` };
    } finally {
      this.closing.delete(hit.s.pid);
      this.emitState();
    }
  }

  async openSession(projectId, sessionId) {
    const p = settings.project(projectId);
    if (!p) return { ok: false, text: 'Unknown project.' };
    const c = roster.closedSessions(p, this.sessions(projectId)).find((x) => x.sessionId === sessionId);
    if (!c) return { ok: false, text: 'That session is open already, or too old to reopen here.' };
    try {
      const r = await this.opener(c);
      memory.addHistory(projectId, { event: 'reopened', title: c.name });
      return { ok: true, text: `Reopened ${c.name} in ${r.where}.` };
    } catch (e) {
      return { ok: false, text: `Couldn't reopen ${c.name}: ${e.message}` };
    }
  }

  // An ability the planner asked for. Allow always saves the rule for every future run; once every
  // request on the card is answered and something was allowed, the planner tries again with it.
  async answerAbility(cardId, rule, allow) {
    const card = [...this.cards.values()].find((c) => c.id === cardId);
    if (!card || card.busy) return;
    const req = (card.requests || []).find((r) => r.rule === rule);
    if (!req) return;
    card.requests = card.requests.filter((r) => r !== req);
    card.allowedNow = [...(card.allowedNow || []), ...(allow ? [req] : [])];
    if (allow) abilities.grant(rule);
    memory.addHistory(card.project, { event: allow ? 'ability-allowed' : 'ability-declined', title: req.label, note: rule });
    if (card.requests.length || !card.allowedNow.length) return this.emitState();
    const names = card.allowedNow.map((r) => r.label).join(', ');
    card.allowedNow = [];
    await this.converse(card, `The user allowed: ${names}. Use it now to do what you couldn't before, then answer again with the updated card.`, { from: 'you', text: `Allowed: ${names}` });
  }

  pauseSession(projectId, sessionId, paused) {
    if (!settings.project(projectId) || !sessionId) return { ok: false, text: 'Unknown session.' };
    roster.setPaused(projectId, sessionId, paused);
    memory.addHistory(projectId, { event: paused ? 'paused' : 'resumed', title: sessionId.slice(0, 8) });
    this.emitState();
    return { ok: true, text: paused ? 'Paused: null will send it nothing until you resume it.' : 'Resumed: null can give it work again.' };
  }

  dismiss(cardId) {
    const card = [...this.cards.values()].find((c) => c.id === cardId);
    if (!card) return;
    memory.addHistory(card.project, { event: 'dismissed', title: card.actions.map((a) => a.title).join(' | ') });
    this.cards.delete(card.project);
    this.emitState();
  }
}

module.exports = { Brain };
