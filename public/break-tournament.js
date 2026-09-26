// public/break-tournament.js — International break tournament ("Robotics Nations Cup") UI.
// Renders into #breakTournament at the top of the page while a break is active.
(() => {
  const API_URL = '/api/get-break-tournament';
  const TIMEZONE = 'Europe/Stockholm';
  const REFRESH_MS = 5 * 60 * 1000;

  const root = document.getElementById('breakTournament');
  if (!root) return;

  const ICONS = {
    goal: '⚽', assist: '👟', clean_sheet: '🛡️', pen_save: '🧤',
    yellow: '🟨', red: '🟥', own_goal: '🤦', pen_miss: '❌'
  };
  const LABELS = {
    goal: 'Goal', assist: 'Assist', clean_sheet: 'Clean sheet', pen_save: 'Penalty save',
    yellow: 'Yellow card', red: 'Red card', own_goal: 'Own goal', pen_miss: 'Missed penalty'
  };
  const SCORING = [
    ['goal', '+5'], ['assist', '+3'], ['clean_sheet', '+4 GK/DEF'], ['pen_save', '+5'],
    ['yellow', '−1'], ['red', '−3'], ['own_goal', '−2'], ['pen_miss', '−2']
  ];
  const POSITIONS = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
  const STAGE_LABELS = { group: 'Group stage', semi: 'Semi-finals', final: 'Final' };

  let data = null;
  let managersById = new Map();
  let activeTab = null;
  let refreshTimer = null;
  let countdownTimer = null;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } }
  };
  const collapsedKey = () => `breakTournamentCollapsed:${data.break.id}`;
  const isCollapsed = () => storage.get(collapsedKey()) === '1';

  const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');

  const shortDate = (dateStr) => new Date(`${dateStr}T12:00:00Z`)
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

  /** Epoch ms for a wall-clock time in the tournament timezone. */
  const zonedTime = (dateStr, time) => {
    const guess = new Date(`${dateStr}T${time}Z`);
    const asZone = new Date(guess.toLocaleString('en-US', { timeZone: TIMEZONE }));
    const asUtc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
    return guess.getTime() - (asZone - asUtc);
  };

  const formatDuration = (ms) => {
    if (ms <= 0) return 'now';
    const mins = Math.floor(ms / 60000);
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };

  const managerName = (id) => managersById.get(id)?.managerName ?? 'TBD';
  const firstName = (id) => managerName(id).split(' ')[0];

  const managerButton = (id, { sub = true, cls = '' } = {}) => {
    const m = managersById.get(id);
    if (!m) return '<span class="text-gray-500 italic">TBD</span>';
    return `
      <button data-action="manager" data-id="${m.managerId}" class="text-left hover:underline decoration-dotted underline-offset-2 ${cls}">
        <span class="font-semibold">${esc(m.teamName)}</span>
        ${sub ? `<span class="block text-xs text-gray-400 font-normal">${esc(m.managerName)}</span>` : ''}
      </button>`;
  };

  const statusBadge = (status) => {
    if (status === 'live') {
      return `<span class="inline-flex items-center gap-1 rounded-full bg-red-600/90 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
        <span class="relative flex h-1.5 w-1.5"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75"></span><span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-white"></span></span>Live</span>`;
    }
    if (status === 'final') {
      return '<span class="rounded-full bg-gray-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gray-200">Final</span>';
    }
    return '<span class="rounded-full bg-gray-700 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gray-400">Upcoming</span>';
  };

  const roundOf = (n) => data.rounds.find(r => r.round === n);
  const currentRound = () => roundOf(data.currentRound);
  const tournamentOver = () => data.knockout.final.status === 'final';

  // ---------------------------------------------------------------------------
  // Latest action feed
  // ---------------------------------------------------------------------------

  const buildFeed = () => {
    const items = new Map(); // player+match → item
    for (const m of data.managers) {
      for (const p of m.squad) {
        for (const app of p.appearances) {
          if (!app.events.length) continue;
          const key = `${p.fplId}-${app.matchId}`;
          if (!items.has(key)) {
            items.set(key, { player: p, app, owners: [] });
          }
          items.get(key).owners.push(m.managerId);
        }
      }
    }
    return [...items.values()]
      .sort((a, b) => b.app.date.localeCompare(a.app.date) || b.app.points - a.app.points)
      .slice(0, 8);
  };

  const eventIcons = (events) => events.map(e => `<span title="${LABELS[e.type]}">${ICONS[e.type]}</span>`).join('');

  const renderFeed = () => {
    const feed = buildFeed();
    if (!feed.length) {
      return '<p class="text-xs text-indigo-200/80">No goals or cards from your squads yet. Kick-off can’t come soon enough.</p>';
    }
    return `<ul class="space-y-1">${feed.map(({ player, app, owners }) => {
      const names = owners.slice(0, 3).map(firstName).join(', ');
      const more = owners.length > 3 ? ` +${owners.length - 3}` : '';
      const pts = app.points;
      return `
        <li class="flex min-w-0 items-center gap-2 text-xs">
          <span class="shrink-0 w-7 text-right font-bold ${pts > 0 ? 'text-green-300' : pts < 0 ? 'text-red-300' : 'text-gray-300'}">${signed(pts)}</span>
          <span class="shrink-0">${eventIcons(app.events)}</span>
          <span class="min-w-0 truncate"><span class="font-semibold text-white">${esc(player.name)}</span>
            <span class="text-indigo-200/80">${esc(app.nation || '')} v ${esc(app.opponent || '')}${app.score ? ` ${esc(app.score)}` : ''}</span>
            <span class="text-indigo-300/70">· ${esc(names)}${more}</span></span>
        </li>`;
    }).join('')}</ul>`;
  };

  // ---------------------------------------------------------------------------
  // Hero
  // ---------------------------------------------------------------------------

  const renderProgress = () => `
    <ol class="grid grid-cols-4 gap-1.5 text-center">
      ${data.rounds.map(r => {
        const isCurrent = r.round === data.currentRound && !tournamentOver();
        const base = r.status === 'final'
          ? 'bg-white/20 text-white'
          : isCurrent ? 'bg-amber-400 text-gray-900 shadow-lg shadow-amber-500/30' : 'bg-black/20 text-indigo-200/70';
        return `
          <li class="rounded-lg px-1 py-1.5 ${base}">
            <div class="text-[10px] uppercase tracking-wider opacity-80">Round ${r.round}</div>
            <div class="text-xs font-bold leading-tight">${r.stage === 'group' ? 'Groups' : r.stage === 'semi' ? 'Semis' : 'Final'}</div>
            <div class="text-[10px] opacity-70">${shortDate(r.start)}–${shortDate(r.end)}</div>
          </li>`;
      }).join('')}
    </ol>`;

  const countdownText = () => {
    if (tournamentOver()) return '';
    const r = currentRound();
    const now = Date.now();
    if (r.status === 'live') return `Round ${r.round} ends in ${formatDuration(zonedTime(r.end, '23:59:59') - now)}`;
    return `Round ${r.round} starts in ${formatDuration(zonedTime(r.start, '00:00:00') - now)}`;
  };

  const renderChampion = () => {
    const f = data.knockout.final;
    return `
      <div class="mt-3 rounded-xl bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-400 p-3 text-center text-gray-900 shadow-lg">
        <div class="text-3xl bt-float">🏆</div>
        <div class="text-[11px] font-bold uppercase tracking-widest">Champion</div>
        <div class="text-xl font-black">${esc(managersById.get(f.winner)?.teamName)}</div>
        <div class="text-sm">${esc(managerName(f.winner))} · beat ${esc(managerName(f.loser))} ${Math.max(f.homePoints, f.awayPoints)}–${Math.min(f.homePoints, f.awayPoints)} in the final${f.homePoints === f.awayPoints ? ' (on tiebreak)' : ''}</div>
      </div>`;
  };

  const renderHero = () => {
    const r = currentRound();
    const stage = tournamentOver() ? 'Tournament complete' : `${STAGE_LABELS[r.stage]} · Round ${r.round} of ${data.rounds.length}`;
    return `
      <div class="relative overflow-hidden rounded-xl bg-gradient-to-br from-indigo-700 via-purple-700 to-fuchsia-700 p-3 md:p-4 shadow-xl">
        <div class="pointer-events-none absolute -right-6 -top-8 text-[9rem] leading-none opacity-10 select-none">🏆</div>
        <div class="relative flex items-start justify-between gap-2">
          <div class="flex items-center gap-3">
            <div class="text-4xl bt-float">🏆</div>
            <div>
              <div class="text-[11px] font-bold uppercase tracking-[0.2em] text-amber-300">International break · ${esc(data.break.name)}</div>
              <h2 class="text-xl md:text-2xl font-black text-white leading-tight">Robotics Nations Cup</h2>
              <div class="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-indigo-100">
                <span>${esc(stage)}</span>${tournamentOver() ? '' : statusBadge(r.status)}
              </div>
            </div>
          </div>
          <button data-action="collapse" title="Minimize the tournament"
            class="shrink-0 rounded-lg bg-black/25 px-2.5 py-1 text-sm font-semibold text-white hover:bg-black/40 transition-colors">
            Minimize ▴
          </button>
        </div>

        ${tournamentOver() ? renderChampion() : ''}

        <div class="relative mt-3">${renderProgress()}</div>

        <div class="relative mt-3 grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto] md:items-start">
          <div class="min-w-0 rounded-lg bg-black/20 p-2">
            <div class="mb-1 text-[10px] font-bold uppercase tracking-wider text-amber-300">Latest action</div>
            ${renderFeed()}
          </div>
          <div class="rounded-lg bg-black/20 p-2 text-center md:min-w-[11rem]">
            <div class="text-[10px] font-bold uppercase tracking-wider text-amber-300">${tournamentOver() ? 'Full time' : 'Countdown'}</div>
            <div id="btCountdown" class="text-lg font-black text-white">${esc(countdownText() || 'See you next break')}</div>
            <div class="text-[10px] text-indigo-200/80">Squads locked at GW${data.break.snapshotGW} · all 15 players count</div>
          </div>
        </div>
      </div>`;
  };

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  const TABS = [
    { id: 'groups', label: 'Groups' },
    { id: 'knockouts', label: 'Knockouts' },
    { id: 'boot', label: 'Golden Boot' }
  ];

  const defaultTab = () => (currentRound().stage === 'group' && !tournamentOver() ? 'groups' : 'knockouts');

  const renderTabs = () => `
    <div class="mt-3 flex gap-1 rounded-lg bg-gray-900/60 p-1">
      ${TABS.map(t => `
        <button data-action="tab" data-tab="${t.id}"
          class="flex-1 rounded-md px-2 py-1.5 text-sm font-semibold transition-colors ${activeTab === t.id ? 'bg-amber-400 text-gray-900' : 'text-gray-300 hover:bg-gray-700'}">
          ${t.label}
        </button>`).join('')}
    </div>`;

  // Groups ------------------------------------------------------------------

  const renderGroups = () => {
    const groupRounds = data.rounds.filter(r => r.stage === 'group');
    const done = data.groupStageStatus === 'final';
    return `
      <p class="mt-3 mb-2 text-xs text-gray-400">
        Points over rounds ${groupRounds.map(r => r.round).join(' & ')}. Only the group winner goes through to the semi-finals.
        ${done ? '' : 'Positions are provisional until the group stage ends.'}
      </p>
      <div class="grid gap-3 md:grid-cols-2">
        ${data.groups.map(g => `
          <div class="rounded-xl border border-gray-700 bg-gray-800 overflow-hidden">
            <div class="flex items-center justify-between bg-gradient-to-r from-indigo-900/80 to-gray-800 px-3 py-1.5">
              <h3 class="font-black tracking-wide text-white">Group ${g.name}</h3>
              ${statusBadge(g.status)}
            </div>
            <table class="w-full text-sm">
              <thead><tr class="text-[10px] uppercase tracking-wider text-gray-400">
                <th class="px-2 py-1 text-left w-6">#</th><th class="px-2 py-1 text-left">Manager</th>
                ${groupRounds.map(r => `<th class="px-1 py-1 text-center">R${r.round}</th>`).join('')}
                <th class="px-2 py-1 text-center">Pts</th>
              </tr></thead>
              <tbody>
                ${g.standings.map((s, i) => {
                  const m = managersById.get(s.managerId);
                  const leader = i === 0;
                  const rowCls = leader ? 'bg-amber-400/10' : done ? 'opacity-50' : '';
                  return `
                    <tr class="border-t border-gray-700/70 ${rowCls}">
                      <td class="px-2 py-1 font-bold ${leader ? 'text-amber-300' : 'text-gray-400'}">${i + 1}</td>
                      <td class="px-2 py-1">
                        <div class="flex items-center gap-1.5">
                          ${managerButton(s.managerId)}
                          ${leader ? `<span class="rounded bg-amber-400 px-1 text-[9px] font-black uppercase text-gray-900">${done ? 'Through ✓' : 'Leading'}</span>` : ''}
                        </div>
                      </td>
                      ${groupRounds.map(r => `<td class="px-1 py-1 text-center ${r.status === 'upcoming' ? 'text-gray-600' : 'text-gray-300'}">${r.status === 'upcoming' ? '–' : m.rounds[r.round - 1].points}</td>`).join('')}
                      <td class="px-2 py-1 text-center text-base font-black ${leader ? 'text-amber-300' : 'text-white'}">${s.points}</td>
                    </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>`).join('')}
      </div>`;
  };

  // Knockouts ---------------------------------------------------------------

  const matchupCard = (tie, { big = false, placeholders = ['TBD', 'TBD'], showSides = true } = {}) => {
    const round = roundOf(tie.round);
    const played = tie.status === 'live' || tie.status === 'final';
    const side = (id, pts, placeholder) => {
      if (!showSides || !id) {
        return `<div class="flex items-center justify-between px-3 py-2 text-gray-500 italic">${esc(placeholder)}<span>–</span></div>`;
      }
      const isWinner = tie.status === 'final' && tie.winner === id;
      const isAhead = tie.status === 'live' && tie.winner === id;
      const isLoser = tie.status === 'final' && tie.loser === id;
      return `
        <div class="flex items-center justify-between gap-2 px-3 py-2 ${isWinner ? 'bg-amber-400/15' : ''} ${isLoser ? 'opacity-50' : ''}">
          <div class="min-w-0 flex items-center gap-1.5">${isWinner ? '<span>✓</span>' : ''}${managerButton(id)}</div>
          <span class="text-lg font-black ${isWinner || isAhead ? 'text-amber-300' : 'text-white'}">${played ? pts : '–'}</span>
        </div>`;
    };
    return `
      <div class="rounded-xl border ${big ? 'border-amber-400/60 shadow-lg shadow-amber-500/10' : 'border-gray-700'} bg-gray-800 overflow-hidden w-full">
        <div class="flex items-center justify-between bg-gray-900/60 px-3 py-1">
          <span class="text-[11px] font-bold uppercase tracking-wider ${big ? 'text-amber-300' : 'text-gray-300'}">${big ? '🏆 ' : ''}${esc(tie.label)}</span>
          <span class="flex items-center gap-1.5 text-[10px] text-gray-400">R${tie.round} · ${shortDate(round.start)}–${shortDate(round.end)} ${statusBadge(tie.status)}</span>
        </div>
        ${side(tie.home, tie.homePoints, placeholders[0])}
        <div class="border-t border-gray-700/70"></div>
        ${side(tie.away, tie.awayPoints, placeholders[1])}
      </div>`;
  };

  const renderKnockouts = () => {
    const k = data.knockout;
    const groupsDone = data.groupStageStatus === 'final';
    const semisStarted = k.semis.every(s => s.status !== 'upcoming');
    const seedGroup = (id) => managersById.get(id)?.group;
    const semiPlaceholders = (s) => [`Winner Group ${seedGroup(s.home) || '?'}`, `Winner Group ${seedGroup(s.away) || '?'}`];

    return `
      <p class="mt-3 mb-2 text-xs text-gray-400">
        Head-to-head: highest score in the round wins. Group winners are seeded 1–4 on group points (1 v 4, 2 v 3).
        ${groupsDone ? '' : '<span class="text-amber-300">Semi-finalists are the current group leaders and will change until the group stage ends.</span>'}
      </p>
      <div class="grid gap-3 md:grid-cols-[1fr_auto_1fr] md:items-center">
        <div class="space-y-3">
          ${k.semis.map(s => matchupCard(s, { placeholders: semiPlaceholders(s) })).join('')}
        </div>
        <div class="hidden md:block text-3xl text-gray-600 text-center">→</div>
        <div class="space-y-3">
          ${matchupCard(k.final, { big: true, showSides: semisStarted, placeholders: ['Winner Semi-final 1', 'Winner Semi-final 2'] })}
          ${matchupCard(k.thirdPlace, { showSides: semisStarted, placeholders: ['Loser Semi-final 1', 'Loser Semi-final 2'] })}
        </div>
      </div>`;
  };

  // Golden Boot -------------------------------------------------------------

  const renderBoot = () => {
    const medals = ['🥇', '🥈', '🥉'];
    const last = data.goldenBoot.length - 1;
    return `
      <p class="mt-3 mb-2 text-xs text-gray-400">Everyone keeps scoring all break, knocked out or not. Total points across all ${data.rounds.length} rounds. The wooden spoon 🥄 goes to last place.</p>
      <div class="overflow-x-auto rounded-xl border border-gray-700">
        <table class="w-full bg-gray-800 text-sm">
          <thead><tr class="bg-gray-900/60 text-[10px] uppercase tracking-wider text-gray-400">
            <th class="px-2 py-1.5 text-left">#</th><th class="px-2 py-1.5 text-left">Manager</th>
            <th class="px-1 py-1.5 text-center">Grp</th>
            ${data.rounds.map(r => `<th class="px-1 py-1.5 text-center">R${r.round}</th>`).join('')}
            <th class="px-1 py-1.5 text-center" title="Goals">⚽</th>
            <th class="px-2 py-1.5 text-center">Total</th>
          </tr></thead>
          <tbody>
            ${data.goldenBoot.map((id, i) => {
              const m = managersById.get(id);
              const goals = m.rounds.reduce((s, r) => s + r.goals, 0);
              const badge = i < 3 ? medals[i] : i === last ? '🥄' : i + 1;
              return `
                <tr class="border-t border-gray-700/70 ${i < 3 ? 'bg-amber-400/5' : ''} ${i === last ? 'bg-amber-900/20' : ''}">
                  <td class="px-2 py-1 font-bold text-gray-300">${badge}</td>
                  <td class="px-2 py-1">${managerButton(id)}</td>
                  <td class="px-1 py-1 text-center text-gray-400">${m.group}</td>
                  ${m.rounds.map((r, ri) => `<td class="px-1 py-1 text-center ${data.rounds[ri].status === 'upcoming' ? 'text-gray-600' : 'text-gray-300'}">${data.rounds[ri].status === 'upcoming' ? '–' : r.points}</td>`).join('')}
                  <td class="px-1 py-1 text-center text-gray-300">${goals}</td>
                  <td class="px-2 py-1 text-center text-base font-black text-white">${m.total}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  };

  // ---------------------------------------------------------------------------
  // Manager squad modal
  // ---------------------------------------------------------------------------

  const closeModal = () => {
    document.getElementById('btModal')?.remove();
    document.removeEventListener('keydown', onModalKey);
  };
  const onModalKey = (e) => { if (e.key === 'Escape') closeModal(); };

  const openManager = (id) => {
    const m = managersById.get(id);
    if (!m) return;
    closeModal();

    const playerRow = (p) => {
      const apps = p.appearances.length
        ? p.appearances.map(a => `
            <div class="flex items-center justify-between gap-2 text-xs text-gray-400">
              <span class="truncate">R${a.round} · ${esc(a.nation || '')} v ${esc(a.opponent || '')}${a.score ? ` ${esc(a.score)}` : ''}${a.minutes != null && a.state !== 'in' ? ` · ${a.minutes}'` : ''}${a.state === 'in' ? ' · <span class="text-red-400 font-bold">LIVE</span>' : ''}</span>
              <span class="shrink-0">${a.events.map(e => `<span title="${LABELS[e.type]}${e.minute != null ? ` ${e.minute}'` : ''}">${ICONS[e.type]}</span>`).join('')}
                <span class="ml-1 font-bold ${a.points > 0 ? 'text-green-400' : a.points < 0 ? 'text-red-400' : 'text-gray-500'}">${signed(a.points)}</span></span>
            </div>`).join('')
        : `<div class="text-xs text-gray-500 italic">${p.mapped ? 'No international minutes yet' : 'Not tracked (not found in ESPN data)'}</div>`;
      return `
        <li class="border-t border-gray-700/70 px-3 py-2">
          <div class="flex items-center justify-between gap-2">
            <div class="min-w-0">
              <span class="font-semibold text-white">${esc(p.name)}</span>
              <span class="ml-1 text-[10px] text-gray-400">${POSITIONS[p.position] || ''} · ${esc(p.team || '')}${p.nation ? ` · ${esc(p.nation)}` : ''}</span>
            </div>
            <span class="shrink-0 text-base font-black ${p.points > 0 ? 'text-amber-300' : p.points < 0 ? 'text-red-400' : 'text-gray-500'}">${p.points}</span>
          </div>
          <div class="mt-0.5 space-y-0.5">${apps}</div>
        </li>`;
    };

    const bootRank = data.goldenBoot.indexOf(id) + 1;
    const modal = document.createElement('div');
    modal.id = 'btModal';
    modal.className = 'fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/70 p-0 md:p-4';
    modal.innerHTML = `
      <div class="w-full max-w-lg max-h-[90vh] overflow-hidden rounded-t-2xl md:rounded-2xl bg-gray-800 shadow-2xl flex flex-col" role="dialog" aria-modal="true">
        <div class="bg-gradient-to-br from-indigo-700 via-purple-700 to-fuchsia-700 px-4 py-3">
          <div class="flex items-start justify-between gap-2">
            <div>
              <div class="text-[11px] font-bold uppercase tracking-widest text-amber-300">Group ${m.group} · Golden Boot #${bootRank}</div>
              <div class="text-lg font-black text-white">${esc(m.teamName)}</div>
              <div class="text-sm text-indigo-100">${esc(m.managerName)}</div>
            </div>
            <button data-close class="rounded-lg bg-black/25 px-2.5 py-1 text-white hover:bg-black/40" aria-label="Close">✕</button>
          </div>
          <div class="mt-2 grid grid-cols-5 gap-1 text-center">
            ${m.rounds.map((r, i) => `<div class="rounded bg-black/20 py-1"><div class="text-[10px] text-indigo-200">R${i + 1}</div><div class="font-bold text-white">${data.rounds[i].status === 'upcoming' ? '–' : r.points}</div></div>`).join('')}
            <div class="rounded bg-amber-400 py-1 text-gray-900"><div class="text-[10px]">Total</div><div class="font-black">${m.total}</div></div>
          </div>
        </div>
        <ul class="overflow-y-auto">${m.squad.map(playerRow).join('')}</ul>
      </div>`;
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('[data-close]')) closeModal();
      const btn = e.target.closest('[data-action="manager"]');
      if (btn) openManager(Number(btn.dataset.id));
    });
    document.body.appendChild(modal);
    document.addEventListener('keydown', onModalKey);
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const renderCollapsed = () => {
    const r = currentRound();
    let summary;
    if (tournamentOver()) {
      summary = `Champion: <span class="font-bold text-white">${esc(managerName(data.knockout.final.winner))}</span>`;
    } else {
      const leaderId = data.goldenBoot[0];
      summary = `Round ${r.round} ${r.status === 'live' ? 'live' : r.status} · Golden Boot leader: <span class="font-bold text-white">${esc(firstName(leaderId))}</span>`;
    }
    return `
      <button data-action="expand" class="w-full flex items-center justify-between gap-2 rounded-xl bg-gradient-to-r from-indigo-700 via-purple-700 to-fuchsia-700 px-3 py-2 text-left shadow-lg hover:brightness-110 transition">
        <span class="flex items-center gap-2 min-w-0 text-sm text-indigo-100">
          <span class="text-xl">🏆</span>
          <span class="font-black text-white whitespace-nowrap">Robotics Nations Cup</span>
          <span class="hidden sm:inline truncate">· ${summary}</span>
        </span>
        <span class="shrink-0 rounded-lg bg-black/25 px-2.5 py-1 text-sm font-semibold text-white">Show ▾</span>
      </button>`;
  };

  const renderFull = () => {
    const body = activeTab === 'groups' ? renderGroups()
      : activeTab === 'knockouts' ? renderKnockouts()
      : renderBoot();
    return `
      <div class="rounded-xl bg-gray-800/60 p-2 md:p-3 ring-1 ring-purple-500/30 shadow-lg">
        ${renderHero()}
        ${renderTabs()}
        ${body}
        <div class="mt-3 flex flex-wrap items-center justify-center gap-1.5 text-[11px] text-gray-400">
          ${SCORING.map(([type, pts]) => `<span class="rounded-full bg-gray-900/60 px-2 py-0.5">${ICONS[type]} ${LABELS[type]} <span class="font-bold text-gray-200">${pts}</span></span>`).join('')}
        </div>
        <div class="mt-2 text-center text-[10px] text-gray-500">
          Every international match counts, by kick-off date (Swedish time). Updated ${new Date(data.generatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.
        </div>
      </div>`;
  };

  const render = () => {
    root.innerHTML = isCollapsed() ? renderCollapsed() : renderFull();
    root.hidden = false;
  };

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'collapse') {
      storage.set(collapsedKey(), '1');
      render();
    } else if (action === 'expand') {
      storage.set(collapsedKey(), '0');
      render();
    } else if (action === 'tab') {
      activeTab = el.dataset.tab;
      render();
    } else if (action === 'manager') {
      openManager(Number(el.dataset.id));
    }
  });

  const tickCountdown = () => {
    const el = document.getElementById('btCountdown');
    const text = data && countdownText();
    if (el && text) el.textContent = text;
  };

  const load = async () => {
    try {
      const response = await fetch(API_URL);
      if (!response.ok) return;
      const json = await response.json();
      if (!json.active) {
        root.hidden = true;
        return;
      }
      data = json;
      managersById = new Map(data.managers.map(m => [m.managerId, m]));
      if (!activeTab) activeTab = defaultTab();
      render();

      clearInterval(countdownTimer);
      countdownTimer = setInterval(tickCountdown, 30000);
      clearTimeout(refreshTimer);
      if (data.rounds.some(r => r.status !== 'final')) refreshTimer = setTimeout(load, REFRESH_MS);
    } catch (err) {
      // The tournament is a bonus: never let it break the rest of the page
      console.error('Break tournament error:', err);
    }
  };

  load();
})();
