// api/get-player-contributions.js
const BOOTSTRAP_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';
const LEAGUE_API_URL = 'https://fantasy.premierleague.com/api/leagues-classic/';
const TEAM_API_URL = 'https://fantasy.premierleague.com/api/entry/';
const LIVE_API_URL = 'https://fantasy.premierleague.com/api/event/';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const FPL_HEADERS = { 'User-Agent': 'RoboticsFPL/1.0' };

const fetchWithRetry = async (url, retries = 4, baseDelay = 2000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { headers: FPL_HEADERS });
      if (response.ok) return response;
      if (attempt < retries) {
        const wait = baseDelay * attempt; // exponential-ish: 2s, 4s, 6s
        console.warn(`  Attempt ${attempt} failed for ${url}. Status: ${response.status}. Retrying in ${wait}ms...`);
        await sleep(wait);
      }
    } catch (error) {
      if (attempt < retries) {
        const wait = baseDelay * attempt;
        console.warn(`  Attempt ${attempt} failed for ${url}. Error: ${error.message}. Retrying in ${wait}ms...`);
        await sleep(wait);
      } else {
        throw error;
      }
    }
  }
  throw new Error(`Failed to fetch ${url} after ${retries} attempts.`);
};

/**
 * Simulate auto-subs for a given set of picks in a GW.
 * If a starter has 0 minutes, swap in the first eligible bench player (by position order)
 * with >0 minutes, inheriting the starter's multiplier.
 */
function simulateAutoSubs(picks, playerDataForGW) {
  const starters = picks
    .filter(p => p.position >= 1 && p.position <= 11)
    .sort((a, b) => a.position - b.position);

  const bench = picks
    .filter(p => p.position >= 12 && p.position <= 15)
    .sort((a, b) => a.position - b.position);

  const usedBenchPlayers = new Set();
  const effectiveLineup = [];

  for (const starter of starters) {
    const starterData = playerDataForGW[starter.element];
    const starterMinutes = starterData ? starterData.minutes : 0;

    if (starterMinutes > 0) {
      effectiveLineup.push({ element: starter.element, multiplier: starter.multiplier });
    } else {
      let subbed = false;
      for (const benchPlayer of bench) {
        if (usedBenchPlayers.has(benchPlayer.element)) continue;
        const benchData = playerDataForGW[benchPlayer.element];
        const benchMinutes = benchData ? benchData.minutes : 0;
        if (benchMinutes > 0) {
          effectiveLineup.push({ element: benchPlayer.element, multiplier: starter.multiplier });
          usedBenchPlayers.add(benchPlayer.element);
          subbed = true;
          break;
        }
      }
      if (!subbed) {
        effectiveLineup.push({ element: starter.element, multiplier: starter.multiplier });
      }
    }
  }

  return effectiveLineup;
}

/**
 * Fetch picks for a single manager/GW. Returns null if the entry doesn't exist
 * for that GW (404) rather than throwing, so mid-season joiners are handled gracefully.
 */
const fetchPicksSafe = async (url) => {
  const retries = 4;
  const baseDelay = 2000;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { headers: FPL_HEADERS });
      if (response.ok) return response;
      if (response.status === 404) return null; // Manager didn't participate this GW
      if (attempt < retries) {
        const wait = baseDelay * attempt;
        console.warn(`  Attempt ${attempt} failed for ${url}. Status: ${response.status}. Retrying in ${wait}ms...`);
        await sleep(wait);
      }
    } catch (error) {
      if (attempt < retries) {
        const wait = baseDelay * attempt;
        console.warn(`  Attempt ${attempt} failed for ${url}. Error: ${error.message}. Retrying in ${wait}ms...`);
        await sleep(wait);
      } else {
        throw error;
      }
    }
  }
  return null;
};

/**
 * Run an array of async task functions in batches, with a delay between batches.
 */
async function batchFetch(tasks, batchSize = 5, delayMs = 200) {
  const results = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn => fn()));
    results.push(...batchResults);
    if (i + batchSize < tasks.length) await sleep(delayMs);
  }
  return results;
}

module.exports = async (req, res) => {
  console.log('--- FPL Player Contributions Request ---');
  try {
    const { leagueId } = req.query;
    if (!leagueId) {
      return res.status(400).json({ error: 'leagueId is required.' });
    }

    // Step 1: Fetch bootstrap-static and league standings in parallel
    console.log('Step 1: Fetching bootstrap & league standings...');
    const [bootstrapResponse, leagueResponse] = await Promise.all([
      fetchWithRetry(BOOTSTRAP_URL),
      fetchWithRetry(`${LEAGUE_API_URL}${leagueId}/standings/`)
    ]);
    const bootstrapData = await bootstrapResponse.json();
    const leagueData = await leagueResponse.json();

    // Build player info map: id → { name, position (element_type) }
    const playerInfo = {};
    for (const el of bootstrapData.elements) {
      playerInfo[el.id] = { name: el.web_name, position: el.element_type };
    }

    // Collect finished GWs
    const finishedGWs = bootstrapData.events
      .filter(e => e.finished)
      .map(e => e.id);
    console.log(`Finished GWs: ${finishedGWs.length} (up to GW${finishedGWs[finishedGWs.length - 1]})`);

    // Collect all managers from standings
    const managers = leagueData.standings.results.map(m => ({
      managerId: m.entry,
      managerName: m.player_name,
      teamName: m.entry_name,
      totalPoints: m.total
    }));
    console.log(`Managers: ${managers.length}`);

    // Step 2: Fetch live GW data for all finished GWs (batched)
    console.log('Step 2: Fetching live GW data...');
    const gwLiveTasks = finishedGWs.map(gw => () =>
      fetchWithRetry(`${LIVE_API_URL}${gw}/live/`)
        .then(r => r.json())
        .then(data => ({ gw, data }))
    );
    const liveResults = await batchFetch(gwLiveTasks, 3, 500);

    const gwPlayerData = {};
    for (const { gw, data } of liveResults) {
      gwPlayerData[gw] = {};
      for (const el of data.elements) {
        gwPlayerData[gw][el.id] = {
          points: el.stats.total_points,
          minutes: el.stats.minutes
        };
      }
    }
    console.log(`Live data fetched for ${Object.keys(gwPlayerData).length} GWs`);

    // Step 3: Fetch picks for all managers × all finished GWs (batched)
    console.log('Step 3: Fetching all manager picks...');
    const picksTasks = [];
    for (const manager of managers) {
      for (const gw of finishedGWs) {
        picksTasks.push(() =>
          fetchPicksSafe(`${TEAM_API_URL}${manager.managerId}/event/${gw}/picks/`)
            .then(r => r ? r.json() : null)
            .then(data => ({ managerId: manager.managerId, gw, data }))
        );
      }
    }
    const picksResults = await batchFetch(picksTasks, 3, 500);

    // Organise picks: managerId → gw → picksData
    const picksByManager = {};
    for (const { managerId, gw, data } of picksResults) {
      if (!picksByManager[managerId]) picksByManager[managerId] = {};
      picksByManager[managerId][gw] = data;
    }
    console.log(`Picks fetched for ${managers.length} managers across ${finishedGWs.length} GWs`);

    // Step 4: Compute per-player point contributions per manager
    console.log('Step 4: Computing contributions...');
    const playerTotals = {}; // { managerId: { playerId: points } }

    for (const manager of managers) {
      playerTotals[manager.managerId] = {};
      const managerPicks = picksByManager[manager.managerId] || {};

      for (const gw of finishedGWs) {
        const picksData = managerPicks[gw];
        if (!picksData || !Array.isArray(picksData.picks)) continue;

        const picks = picksData.picks;
        const activeChip = picksData.active_chip;
        const gwData = gwPlayerData[gw] || {};

        let effectivePicks;
        if (activeChip === 'bboost') {
          // Bench Boost: all 15 players contribute directly (bench already has multiplier=1)
          effectivePicks = picks.map(p => ({ element: p.element, multiplier: p.multiplier }));
        } else {
          // Normal: apply auto-sub logic (only positions 1-11 starters, bench subs in for 0-min starters)
          effectivePicks = simulateAutoSubs(picks, gwData);
        }

        const totals = playerTotals[manager.managerId];
        for (const pick of effectivePicks) {
          if (pick.multiplier === 0) continue;
          const pData = gwData[pick.element];
          const rawPoints = pData ? pData.points : 0;
          const contributed = rawPoints * pick.multiplier;
          if (contributed <= 0) continue;
          totals[pick.element] = (totals[pick.element] || 0) + contributed;
        }
      }
    }

    // Step 5: Build response — sort managers by totalPoints desc, players by contribution desc
    console.log('Step 5: Building response...');
    const managersResponse = managers.map(manager => {
      const totals = playerTotals[manager.managerId] || {};
      const players = Object.entries(totals)
        .map(([playerId, points]) => {
          const info = playerInfo[parseInt(playerId)] || { name: `Player ${playerId}`, position: 0 };
          return { id: parseInt(playerId), name: info.name, position: info.position, points };
        })
        .filter(p => p.points > 0)
        .sort((a, b) => b.points - a.points);

      return {
        managerId: manager.managerId,
        managerName: manager.managerName,
        teamName: manager.teamName,
        totalPoints: manager.totalPoints,
        players
      };
    }).sort((a, b) => b.totalPoints - a.totalPoints);

    console.log('--- Player Contributions Request Complete ---');
    return res.status(200).json({ managers: managersResponse });

  } catch (error) {
    console.error('An unhandled error occurred:', error);
    return res.status(500).json({ error: 'Internal server error. Please try again later.' });
  }
};
