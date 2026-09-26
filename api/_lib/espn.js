// api/_lib/espn.js — ESPN public soccer API helpers for the international break tournament
'use strict';

const { fetchWithRetry, batchFetch } = require('./fpl');

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

// ESPN rejects the custom FPL User-Agent, so send no extra headers
const getJson = (url) => fetchWithRetry(url, 3, 1000, {}).then(r => r.json());

/**
 * Fetch every Premier League squad from ESPN.
 * Returns [{ espnTeamId, espnTeamName, athletes: [{ id, displayName, firstName, lastName, citizenship }] }]
 */
async function fetchPremierLeagueRosters() {
  const teamsData = await getJson(`${ESPN_BASE}/eng.1/teams`);
  const teams = teamsData.sports[0].leagues[0].teams.map(t => t.team);

  const tasks = teams.map(team => () =>
    getJson(`${ESPN_BASE}/eng.1/teams/${team.id}/roster`).then(data => ({
      espnTeamId: team.id,
      espnTeamName: team.displayName,
      athletes: (data.athletes || []).map(a => ({
        id: a.id,
        displayName: a.displayName || '',
        firstName: a.firstName || '',
        lastName: a.lastName || '',
        citizenship: a.citizenship || null
      }))
    }))
  );
  return batchFetch(tasks, 10, 100);
}

/**
 * Fetch the all-competitions scoreboard for each date (YYYY-MM-DD strings).
 * Returns a flat array of ESPN events.
 */
async function fetchScoreboards(dates) {
  const tasks = dates.map(date => () =>
    getJson(`${ESPN_BASE}/all/scoreboard?dates=${date.replace(/-/g, '')}&limit=1000`)
      .then(data => data.events || [])
  );
  const results = await batchFetch(tasks, 10, 100);
  return results.flat();
}

/** Fetch match summaries (rosters + key events) for a list of event IDs. */
async function fetchSummaries(eventIds) {
  const tasks = eventIds.map(id => () =>
    getJson(`${ESPN_BASE}/all/summary?event=${id}`)
      .then(data => ({ id, data }))
      .catch(error => {
        console.warn(`  Could not fetch summary for event ${id}: ${error.message}`);
        return { id, data: null };
      })
  );
  return batchFetch(tasks, 8, 150);
}

module.exports = { fetchPremierLeagueRosters, fetchScoreboards, fetchSummaries };
