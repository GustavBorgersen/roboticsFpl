// api/_lib/tournament.js — scoring and bracket logic for the international break tournament
'use strict';

const POINTS = {
  goal: 5,
  assist: 3,
  clean_sheet: 4,
  pen_save: 5,
  yellow: -1,
  red: -3,
  own_goal: -2,
  pen_miss: -2
};

const CARD_TYPES = new Set(['yellow', 'red']);

// FPL element_type: 1 = GK, 2 = DEF, 3 = MID, 4 = FWD
const CLEAN_SHEET_POSITIONS = new Set([1, 2]);

const GROUP_NAMES = ['A', 'B', 'C', 'D'];

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' for an ISO timestamp (or Date) in the given IANA timezone. */
function dateInTz(value, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(value));
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Every 'YYYY-MM-DD' from start to end inclusive. */
function dateRange(start, end) {
  const dates = [];
  for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d);
  return dates;
}

/** The break whose [start, end + graceDays] window contains today, or null. */
function findActiveBreak(config, today) {
  return config.breaks.find(b =>
    today >= b.start && today <= addDays(b.end, config.graceDays || 0)
  ) || null;
}

function roundStatus(round, today) {
  if (today > round.end) return 'final';
  if (today >= round.start) return 'live';
  return 'upcoming';
}

// ---------------------------------------------------------------------------
// FPL → ESPN player mapping
// ---------------------------------------------------------------------------

const normalize = (s) => (s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/ø/gi, 'o').replace(/æ/gi, 'ae').replace(/ß/g, 'ss').replace(/ł/gi, 'l')
  .toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

// ESPN player citizenship → ESPN national team name, where they differ
const NATION_ALIASES = {
  'usa': 'united states',
  'bosnia and herzegovina': 'bosnia herzegovina'
};

const normalizeNation = (s) => {
  const n = normalize(s);
  return NATION_ALIASES[n] || n;
};

const TEAM_ALIASES = {
  'man city': 'manchester city',
  'man utd': 'manchester united',
  'spurs': 'tottenham hotspur',
  'nott m forest': 'nottingham forest',
  'leeds': 'leeds united',
  'newcastle': 'newcastle united',
  'brighton': 'brighton hove albion',
  'bournemouth': 'afc bournemouth',
  'wolves': 'wolverhampton wanderers',
  'west ham': 'west ham united',
  'sheffield utd': 'sheffield united',
  'leicester': 'leicester city',
  'luton': 'luton town'
};

function findEspnTeam(fplTeamName, espnRosters) {
  const name = normalize(fplTeamName);
  const target = TEAM_ALIASES[name] || name;
  return espnRosters.find(t => normalize(t.espnTeamName) === target)
    || espnRosters.find(t => normalize(t.espnTeamName).includes(target))
    || null;
}

/** Higher is a better match between an FPL element and an ESPN athlete. */
function nameMatchScore(el, athlete) {
  const fplFull = normalize(`${el.first_name} ${el.second_name}`);
  const fplLast = normalize(el.second_name);
  const fplWeb = normalize(el.web_name);
  const espnFull = normalize(athlete.displayName);
  const espnFirstLast = normalize(`${athlete.firstName} ${athlete.lastName}`);
  const espnLast = normalize(athlete.lastName);

  if (fplFull === espnFull || fplFull === espnFirstLast) return 100;
  if (fplLast && fplLast === espnLast) {
    const sameInitial = normalize(el.first_name)[0] === normalize(athlete.firstName)[0];
    return sameInitial ? 90 : 75;
  }
  if (fplWeb && (fplWeb === espnFull || fplWeb === espnLast)) return 70;

  const fplTokens = new Set(fplFull.split(' ').filter(t => t.length > 1));
  const espnTokens = espnFull.split(' ').filter(t => t.length > 1);
  const shared = espnTokens.filter(t => fplTokens.has(t)).length;
  return shared * 25;
}

/**
 * Map FPL element IDs to ESPN athletes, matching by name within the same club.
 * overrides: { fplId: espnAthleteId } for players the name matching gets wrong.
 * Returns { mapping: Map(fplId → { espnId, espnName, nation }), unmatched: [...] }
 */
function mapPlayers(fplIds, elementsById, teamsById, espnRosters, overrides = {}) {
  const athletesById = new Map();
  for (const team of espnRosters) {
    for (const a of team.athletes) athletesById.set(String(a.id), a);
  }

  const mapping = new Map();
  const unmatched = [];

  for (const fplId of fplIds) {
    const el = elementsById.get(fplId);
    if (!el) continue;

    const overrideId = overrides[String(fplId)];
    if (overrideId) {
      const a = athletesById.get(String(overrideId));
      mapping.set(fplId, {
        espnId: String(overrideId),
        espnName: a ? a.displayName : el.web_name,
        nation: a ? a.citizenship : null
      });
      continue;
    }

    const fplTeam = teamsById.get(el.team);
    const espnTeam = fplTeam ? findEspnTeam(fplTeam.name, espnRosters) : null;
    const candidates = espnTeam ? espnTeam.athletes : [];

    let best = null;
    let bestScore = 0;
    let tie = false;
    for (const a of candidates) {
      const score = nameMatchScore(el, a);
      if (score > bestScore) { best = a; bestScore = score; tie = false; }
      else if (score === bestScore && score > 0) tie = true;
    }

    if (best && bestScore >= 50 && !tie) {
      mapping.set(fplId, { espnId: String(best.id), espnName: best.displayName, nation: best.citizenship });
    } else {
      unmatched.push({ fplId, name: `${el.first_name} ${el.second_name}`, team: fplTeam ? fplTeam.name : null });
    }
  }

  return { mapping, unmatched };
}

// ---------------------------------------------------------------------------
// Match scoring
// ---------------------------------------------------------------------------

const statValue = (rosterEntry, name) => {
  const s = (rosterEntry.stats || []).find(x => x.name === name);
  return s ? Number(s.value) || 0 : 0;
};

const clockMinute = (keyEvent) => {
  const seconds = keyEvent.clock && typeof keyEvent.clock.value === 'number' ? keyEvent.clock.value : null;
  return seconds === null ? null : Math.min(90, Math.floor(seconds / 60));
};

const isGoalType = (type) => type === 'Penalty - Scored' || type.startsWith('Goal');

/**
 * Score one ESPN match summary for the tracked athletes.
 * tracked: Map(espnId → FPL element_type)
 * Returns { match, athletes: Map(espnId → { minutes, events: [{ type, points, minute }] }) } or null
 */
function scoreMatch(summary, tracked) {
  const competition = summary.header && summary.header.competitions && summary.header.competitions[0];
  if (!competition) return null;

  const statusType = competition.status.type;
  const competitors = competition.competitors.map(c => ({
    teamId: String(c.team.id),
    name: c.team.displayName,
    score: c.score != null ? Number(c.score) : null,
    homeAway: c.homeAway
  }));

  const match = {
    id: String(competition.id || summary.header.id),
    date: competition.date,
    state: statusType.state,            // 'pre' | 'in' | 'post'
    completed: !!statusType.completed,
    detail: statusType.shortDetail || statusType.detail || '',
    competitors
  };

  // Roster lookup: espnId → { teamId, entry }
  const rosterById = new Map();
  const teamRosters = new Map();
  for (const r of summary.rosters || []) {
    const teamId = String(r.team.id);
    teamRosters.set(teamId, r.roster || []);
    for (const entry of r.roster || []) {
      rosterById.set(String(entry.athlete.id), { teamId, entry });
    }
  }

  const keyEvents = (summary.keyEvents || []).filter(k => !k.shootout);
  const hasKeyEvents = keyEvents.length > 0;

  const subOn = new Map();   // espnId → minute
  const subOff = new Map();  // espnId → minute
  const sentOff = new Map(); // espnId → minute
  const events = new Map();  // espnId → [{ type, points, minute }]

  const addEvent = (espnId, type, minute) => {
    if (!tracked.has(espnId)) return;
    if (!events.has(espnId)) events.set(espnId, []);
    events.get(espnId).push({ type, points: POINTS[type], minute });
  };

  const findSavingKeeper = (k, takerId) => {
    const text = k.text || '';
    const byIndex = text.lastIndexOf(' by ');
    if (byIndex >= 0) {
      const name = normalize(text.slice(byIndex + 4).replace(/\.$/, ''));
      for (const [id, { entry }] of rosterById) {
        if (id !== takerId && normalize(entry.athlete.displayName) === name) return id;
      }
    }
    // Fallback: the opposing team's starting goalkeeper
    const takerTeam = rosterById.get(takerId);
    for (const [teamId, roster] of teamRosters) {
      if (takerTeam && teamId === takerTeam.teamId) continue;
      const gk = roster.find(e => e.starter && e.position && e.position.abbreviation === 'G');
      if (gk) return String(gk.athlete.id);
    }
    return null;
  };

  if (hasKeyEvents) {
    for (const k of keyEvents) {
      const type = (k.type && k.type.text) || '';
      const ids = (k.participants || []).map(p => String(p.athlete.id));
      const minute = clockMinute(k);

      if (type === 'Substitution') {
        if (ids[0]) subOn.set(ids[0], minute);
        if (ids[1]) subOff.set(ids[1], minute);
      } else if (isGoalType(type)) {
        if (ids[0]) addEvent(ids[0], 'goal', minute);
        if (type !== 'Penalty - Scored' && ids[1]) addEvent(ids[1], 'assist', minute);
      } else if (type === 'Own Goal') {
        if (ids[0]) addEvent(ids[0], 'own_goal', minute);
      } else if (type === 'Penalty - Missed') {
        if (ids[0]) addEvent(ids[0], 'pen_miss', minute);
      } else if (type === 'Penalty - Saved') {
        if (ids[0]) {
          addEvent(ids[0], 'pen_miss', minute);
          const keeper = findSavingKeeper(k, ids[0]);
          if (keeper) addEvent(keeper, 'pen_save', minute);
        }
      } else if (type === 'Yellow Card') {
        if (ids[0]) addEvent(ids[0], 'yellow', minute);
      } else if (type === 'Red Card') {
        if (!ids[0]) continue;
        sentOff.set(ids[0], minute);
        // A second yellow counts as a red only: drop the earlier yellow
        if (/second yellow/i.test(k.text || '') && events.has(ids[0])) {
          const list = events.get(ids[0]);
          const idx = list.map(e => e.type).lastIndexOf('yellow');
          if (idx >= 0) list.splice(idx, 1);
        }
        addEvent(ids[0], 'red', minute);
      }
    }
  } else {
    // No play-by-play: fall back to box-score totals (no minutes, no penalty detail)
    for (const [id, { entry }] of rosterById) {
      if (!tracked.has(id)) continue;
      for (let i = 0; i < statValue(entry, 'totalGoals'); i++) addEvent(id, 'goal', null);
      for (let i = 0; i < statValue(entry, 'goalAssists'); i++) addEvent(id, 'assist', null);
      for (let i = 0; i < statValue(entry, 'ownGoals'); i++) addEvent(id, 'own_goal', null);
      if (statValue(entry, 'redCards') > 0) addEvent(id, 'red', null);
      else if (statValue(entry, 'yellowCards') > 0) addEvent(id, 'yellow', null);
    }
  }

  // Minutes played + clean sheets for tracked athletes who appeared
  const athletes = new Map();
  for (const espnId of tracked.keys()) {
    const inRoster = rosterById.get(espnId);
    const playerEvents = events.get(espnId) || [];
    if (!inRoster && playerEvents.length === 0) continue;

    let minutes = null;
    let appeared = playerEvents.length > 0;
    if (inRoster) {
      const { entry } = inRoster;
      appeared = appeared || entry.starter || entry.subbedIn || statValue(entry, 'appearances') > 0;
      if (entry.starter) {
        const off = entry.subbedOut ? subOff.get(espnId) : undefined;
        minutes = entry.subbedOut ? (off != null ? off : null) : 90;
      } else if (entry.subbedIn) {
        const on = subOn.get(espnId);
        minutes = on != null ? 90 - on : null;
        if (minutes !== null && entry.subbedOut && subOff.get(espnId) != null) {
          minutes = subOff.get(espnId) - on;
        }
      } else {
        minutes = 0;
      }
      if (minutes !== null && sentOff.has(espnId) && sentOff.get(espnId) != null) {
        const start = entry.starter ? 0 : (subOn.get(espnId) || 0);
        minutes = Math.min(minutes, sentOff.get(espnId) - start);
      }

      const position = tracked.get(espnId);
      if (match.completed && CLEAN_SHEET_POSITIONS.has(position) &&
          minutes !== null && minutes >= 60 && statValue(entry, 'goalsConceded') === 0) {
        playerEvents.push({ type: 'clean_sheet', points: POINTS.clean_sheet, minute: null });
      }
    }

    if (!appeared) continue;
    const teamId = inRoster ? inRoster.teamId : null;
    athletes.set(espnId, { minutes, teamId, events: playerEvents });
  }

  return { match, athletes };
}

// ---------------------------------------------------------------------------
// Tournament
// ---------------------------------------------------------------------------

const sumPoints = (events) => events.reduce((s, e) => s + e.points, 0);
const countType = (events, type) => events.filter(e => e.type === type).length;
const cardPoints = (events) => -events.filter(e => CARD_TYPES.has(e.type)).reduce((s, e) => s + e.points, 0);

/**
 * Sort comparator for managers on a set of rounds:
 * points desc → goals desc → card deductions asc → snapshot league rank asc.
 */
const compareOn = (rounds) => (a, b) => {
  const pick = (m, key) => rounds.reduce((s, r) => s + m.rounds[r - 1][key], 0);
  return (pick(b, 'points') - pick(a, 'points'))
    || (pick(b, 'goals') - pick(a, 'goals'))
    || (pick(a, 'cardPoints') - pick(b, 'cardPoints'))
    || (a.leagueRank - b.leagueRank);
};

/** Snake-draft managers (sorted by rank) into groups A–D. */
function assignGroups(managersByRank) {
  const groups = GROUP_NAMES.map(name => ({ name, managerIds: [] }));
  managersByRank.forEach((m, i) => {
    const lap = Math.floor(i / groups.length);
    const pos = i % groups.length;
    const g = lap % 2 === 0 ? pos : groups.length - 1 - pos;
    groups[g].managerIds.push(m.managerId);
    m.group = groups[g].name;
  });
  return groups;
}

function headToHead(a, b, round, status, label) {
  if (!a || !b) return { label, round, status, home: a ? a.managerId : null, away: b ? b.managerId : null, winner: null, loser: null };
  const [first] = [a, b].sort(compareOn([round]));
  const winner = first;
  const loser = first === a ? b : a;
  return {
    label, round, status,
    home: a.managerId, away: b.managerId,
    homePoints: a.rounds[round - 1].points,
    awayPoints: b.rounds[round - 1].points,
    // While the round is still being played, the "winner" is only who is currently ahead
    winner: winner.managerId,
    loser: loser.managerId
  };
}

/**
 * Build the full tournament state.
 * managers: [{ managerId, managerName, teamName, leagueRank, picks: [fplId, ...] }]
 * players:  Map(fplId → { fplId, name, position, team, espnId, nation })
 * scoredMatches: [{ match, athletes: Map(espnId → {...}) }]
 */
function buildTournament({ breakConfig, today, timezone, managers, players, scoredMatches }) {
  const rounds = breakConfig.rounds.map(r => ({ ...r, status: roundStatus(r, today) }));
  const roundForDate = (dateStr) => rounds.find(r => dateStr >= r.start && dateStr <= r.end) || null;

  // Per-player appearances, each tagged with its round
  const byEspnId = new Map(); // espnId → [{ round, matchId, opponent, minutes, events, points }]
  const matchesOut = [];
  for (const { match, athletes } of scoredMatches) {
    const localDate = dateInTz(match.date, timezone);
    const round = roundForDate(localDate);
    if (!round) continue;
    matchesOut.push({ ...match, localDate, round: round.round });

    for (const [espnId, a] of athletes) {
      const own = match.competitors.find(c => c.teamId === a.teamId);
      const opp = match.competitors.find(c => c.teamId !== a.teamId);
      if (!byEspnId.has(espnId)) byEspnId.set(espnId, []);
      byEspnId.get(espnId).push({
        round: round.round,
        matchId: match.id,
        date: match.date,
        state: match.state,
        nation: own ? own.name : null,
        opponent: opp ? opp.name : null,
        score: own && opp && own.score !== null ? `${own.score}–${opp.score}` : null,
        minutes: a.minutes,
        events: a.events,
        points: sumPoints(a.events)
      });
    }
  }

  // Per-manager round totals
  const managersOut = managers.map(m => {
    const roundTotals = rounds.map(() => ({ points: 0, goals: 0, cardPoints: 0 }));
    const squad = m.picks.map(fplId => {
      const p = players.get(fplId) || { fplId, name: `Player ${fplId}` };
      const appearances = p.espnId ? (byEspnId.get(p.espnId) || []) : [];
      for (const app of appearances) {
        const t = roundTotals[app.round - 1];
        t.points += app.points;
        t.goals += countType(app.events, 'goal');
        t.cardPoints += cardPoints(app.events);
      }
      return {
        fplId,
        name: p.name,
        position: p.position,
        team: p.team,
        nation: p.nation || null,
        mapped: !!p.espnId,
        points: appearances.reduce((s, a) => s + a.points, 0),
        appearances
      };
    }).sort((a, b) => b.points - a.points || a.position - b.position);

    return {
      managerId: m.managerId,
      managerName: m.managerName,
      teamName: m.teamName,
      leagueRank: m.leagueRank,
      group: null,
      rounds: roundTotals,
      total: roundTotals.reduce((s, r) => s + r.points, 0),
      squad
    };
  });

  const byId = new Map(managersOut.map(m => [m.managerId, m]));

  // Group stage (rounds 1–2)
  const groups = assignGroups([...managersOut].sort((a, b) => a.leagueRank - b.leagueRank));
  const groupRounds = rounds.filter(r => r.stage === 'group').map(r => r.round);
  const groupStageStatus = rounds.filter(r => r.stage === 'group').every(r => r.status === 'final') ? 'final'
    : rounds.some(r => r.stage === 'group' && r.status === 'live') ? 'live' : 'upcoming';

  const groupsOut = groups.map(g => {
    const standings = g.managerIds.map(id => byId.get(id)).sort(compareOn(groupRounds));
    return {
      name: g.name,
      status: groupStageStatus,
      standings: standings.map(m => ({
        managerId: m.managerId,
        points: groupRounds.reduce((s, r) => s + m.rounds[r - 1].points, 0),
        goals: groupRounds.reduce((s, r) => s + m.rounds[r - 1].goals, 0),
        cardPoints: groupRounds.reduce((s, r) => s + m.rounds[r - 1].cardPoints, 0)
      })),
      leader: standings[0] ? standings[0].managerId : null
    };
  });

  // Knockouts: group winners seeded 1–4 on group-stage record
  const semiRound = rounds.find(r => r.stage === 'semi');
  const finalRound = rounds.find(r => r.stage === 'final');
  const seeds = groupsOut.map(g => byId.get(g.leader)).filter(Boolean).sort(compareOn(groupRounds));

  const semis = [
    headToHead(seeds[0], seeds[3], semiRound.round, semiRound.status, 'Semi-final 1'),
    headToHead(seeds[1], seeds[2], semiRound.round, semiRound.status, 'Semi-final 2')
  ];
  const final = headToHead(byId.get(semis[0].winner), byId.get(semis[1].winner), finalRound.round, finalRound.status, 'Final');
  const thirdPlace = headToHead(byId.get(semis[0].loser), byId.get(semis[1].loser), finalRound.round, finalRound.status, '3rd place');

  // Golden Boot: everyone, all rounds
  const allRounds = rounds.map(r => r.round);
  const goldenBoot = [...managersOut].sort(compareOn(allRounds)).map(m => m.managerId);

  const current = rounds.find(r => r.status === 'live')
    || rounds.find(r => r.status === 'upcoming')
    || rounds[rounds.length - 1];

  return {
    rounds,
    currentRound: current.round,
    groupStageStatus,
    groups: groupsOut,
    knockout: {
      seeds: seeds.map(m => m.managerId),
      semis,
      final,
      thirdPlace
    },
    goldenBoot,
    managers: managersOut,
    matches: matchesOut.sort((a, b) => a.date.localeCompare(b.date))
  };
}

module.exports = {
  POINTS,
  dateInTz,
  addDays,
  dateRange,
  findActiveBreak,
  normalize,
  normalizeNation,
  mapPlayers,
  scoreMatch,
  buildTournament
};
