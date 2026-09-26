// api/get-break-tournament.js
// International break tournament: scores every manager's squad (locked at the GW before
// the break) on real international matches, then builds groups, knockouts and Golden Boot.
const { fetchWithRetry, fetchPicksSafe, batchFetch } = require('./_lib/fpl');
const { fetchPremierLeagueRosters, fetchScoreboards, fetchSummaries } = require('./_lib/espn');
const {
  dateInTz, addDays, dateRange, findActiveBreak, normalizeNation, mapPlayers, scoreMatch, buildTournament
} = require('./_lib/tournament');
const config = require('../breaks.json');

const BOOTSTRAP_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';
const LEAGUE_API_URL = 'https://fantasy.premierleague.com/api/leagues-classic/';
const TEAM_API_URL = 'https://fantasy.premierleague.com/api/entry/';

module.exports = async (req, res) => {
  console.log('--- Break Tournament Request ---');
  try {
    const timezone = config.timezone || 'Europe/Stockholm';
    // ?date=YYYY-MM-DD and ?breakId= are for testing / looking back at past breaks
    const today = req.query.date || dateInTz(new Date(), timezone);
    const breakConfig = req.query.breakId
      ? config.breaks.find(b => b.id === req.query.breakId)
      : findActiveBreak(config, today);

    if (!breakConfig) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
      return res.status(200).json({ active: false });
    }
    console.log(`Break: ${breakConfig.id} (today ${today})`);

    const leagueId = req.query.leagueId || config.leagueId;

    // Step 1: FPL side (bootstrap, standings, squads) and ESPN PL rosters in parallel
    console.log('Step 1: Fetching FPL data and ESPN rosters...');
    const [bootstrapData, leagueData, espnRosters] = await Promise.all([
      fetchWithRetry(BOOTSTRAP_URL).then(r => r.json()),
      fetchWithRetry(`${LEAGUE_API_URL}${leagueId}/standings/`).then(r => r.json()),
      fetchPremierLeagueRosters()
    ]);

    if (leagueData.detail === 'Not found.') {
      return res.status(404).json({ error: 'League not found. Please check the League ID.' });
    }

    const elementsById = new Map(bootstrapData.elements.map(e => [e.id, e]));
    const teamsById = new Map(bootstrapData.teams.map(t => [t.id, t]));

    const standings = leagueData.standings.results;
    const picksTasks = standings.map(m => () =>
      fetchPicksSafe(`${TEAM_API_URL}${m.entry}/event/${breakConfig.snapshotGW}/picks/`)
        .then(r => r ? r.json() : null)
        .then(data => ({ managerId: m.entry, data }))
    );
    const picksResults = await batchFetch(picksTasks, 10, 250);
    const picksById = new Map(picksResults.map(p => [p.managerId, p.data]));

    // Seed on total points at the snapshot GW (ties → current league rank)
    const managers = standings
      .map(m => {
        const data = picksById.get(m.entry);
        return {
          managerId: m.entry,
          managerName: m.player_name,
          teamName: m.entry_name,
          snapshotTotal: data && data.entry_history ? data.entry_history.total_points : 0,
          currentRank: m.rank,
          picks: data && Array.isArray(data.picks) ? data.picks.map(p => p.element) : []
        };
      })
      .sort((a, b) => b.snapshotTotal - a.snapshotTotal || a.currentRank - b.currentRank)
      .map((m, i) => ({ ...m, leagueRank: i + 1 }));

    // Step 2: Map every squad player to an ESPN athlete
    console.log('Step 2: Mapping players...');
    const fplIds = [...new Set(managers.flatMap(m => m.picks))];
    const { mapping, unmatched } = mapPlayers(
      fplIds, elementsById, teamsById, espnRosters, breakConfig.playerOverrides || {}
    );
    const extraNations = breakConfig.extraNations || {};

    const players = new Map();
    const tracked = new Map(); // espnId → FPL element_type
    for (const fplId of fplIds) {
      const el = elementsById.get(fplId);
      const m = mapping.get(fplId);
      const team = el ? teamsById.get(el.team) : null;
      players.set(fplId, {
        fplId,
        name: el ? el.web_name : `Player ${fplId}`,
        position: el ? el.element_type : 0,
        team: team ? team.short_name : null,
        espnId: m ? m.espnId : null,
        nation: m ? (extraNations[m.espnId] || m.nation) : null
      });
      if (m && el) tracked.set(m.espnId, el.element_type);
    }
    console.log(`Mapped ${mapping.size}/${fplIds.length} players (${unmatched.length} unmatched)`);

    // Step 3: Find international matches involving our players' nations
    console.log('Step 3: Fetching scoreboards...');
    const nations = new Set([...players.values()].map(p => normalizeNation(p.nation)).filter(Boolean));
    // Scoreboard dates are US-based, so pad a day either side and filter by local date below
    const lastDate = today < breakConfig.end ? addDays(today, 1) : addDays(breakConfig.end, 1);
    const events = await fetchScoreboards(dateRange(addDays(breakConfig.start, -1), lastDate));

    const seen = new Set();
    const candidateIds = [];
    for (const e of events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const localDate = dateInTz(e.date, timezone);
      if (localDate < breakConfig.start || localDate > breakConfig.end) continue;
      if (e.status && e.status.type && e.status.type.state === 'pre') continue;
      const competitors = e.competitions && e.competitions[0] ? e.competitions[0].competitors : [];
      if (competitors.some(c => nations.has(normalizeNation(c.team.displayName)))) candidateIds.push(e.id);
    }
    console.log(`Candidate matches: ${candidateIds.length}`);

    // Step 4: Score each match. Club/women's matches can match a nation name too, but they
    // score nothing because none of our tracked ESPN athletes appear in them.
    console.log('Step 4: Fetching and scoring match summaries...');
    const summaries = await fetchSummaries(candidateIds);
    const scoredMatches = [];
    const matchesWithoutData = [];
    for (const { id, data } of summaries) {
      if (!data) { matchesWithoutData.push(id); continue; }
      const scored = scoreMatch(data, tracked);
      if (!scored) continue;
      if (!(data.rosters || []).some(r => (r.roster || []).length)) {
        matchesWithoutData.push(`${scored.match.competitors.map(c => c.name).join(' v ')}`);
      }
      if (scored.athletes.size > 0) scoredMatches.push(scored);
    }
    console.log(`Scored ${scoredMatches.length} matches with tracked players`);

    // Step 5: Build tournament
    const tournament = buildTournament({ breakConfig, today, timezone, managers, players, scoredMatches });

    const matchedNations = new Set();
    for (const { match } of scoredMatches) {
      for (const c of match.competitors) matchedNations.add(normalizeNation(c.name));
    }
    const nationsWithoutMatches = [...new Set([...players.values()].map(p => p.nation).filter(Boolean))]
      .filter(n => !matchedNations.has(normalizeNation(n)))
      .sort();

    console.log('--- Break Tournament Request Complete ---');
    const allFinal = tournament.rounds.every(r => r.status === 'final');
    res.setHeader('Cache-Control', allFinal
      ? 's-maxage=21600, stale-while-revalidate=86400'
      : 's-maxage=600, stale-while-revalidate=1800');
    return res.status(200).json({
      active: true,
      today,
      generatedAt: new Date().toISOString(),
      break: {
        id: breakConfig.id,
        name: breakConfig.name,
        start: breakConfig.start,
        end: breakConfig.end,
        snapshotGW: breakConfig.snapshotGW
      },
      ...tournament,
      diagnostics: {
        unmatchedPlayers: unmatched,
        nationsWithoutMatches,
        matchesWithoutData
      }
    });

  } catch (error) {
    console.error('An unhandled error occurred:', error);
    return res.status(500).json({ error: 'Internal server error. Please try again later.' });
  }
};
