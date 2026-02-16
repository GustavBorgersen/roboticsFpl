// api/get-what-if.js
const BOOTSTRAP_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';
const LEAGUE_API_URL = 'https://fantasy.premierleague.com/api/leagues-classic/';
const TEAM_API_URL = 'https://fantasy.premierleague.com/api/entry/';
const LIVE_API_URL = 'https://fantasy.premierleague.com/api/event/';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const fetchWithRetry = async (url, retries = 3, delay = 1000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      if (attempt < retries) {
        console.warn(`  Attempt ${attempt} failed for ${url}. Status: ${response.status}. Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    } catch (error) {
      if (attempt < retries) {
        console.warn(`  Attempt ${attempt} failed for ${url}. Error: ${error.message}. Retrying in ${delay}ms...`);
        await sleep(delay);
      } else {
        throw error;
      }
    }
  }
  throw new Error(`Failed to fetch ${url} after ${retries} attempts.`);
};

/**
 * Simulate auto-subs for a frozen team in a given GW.
 * Returns the effective lineup: array of { element, multiplier } for active players.
 *
 * If a starter has 0 minutes, the first bench player (by position order 12-15)
 * with >0 minutes subs in, inheriting the starter's multiplier.
 */
function simulateAutoSubs(frozenPicks, playerDataForGW) {
  const starters = frozenPicks
    .filter(p => p.position >= 1 && p.position <= 11)
    .sort((a, b) => a.position - b.position);

  const bench = frozenPicks
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

module.exports = async (req, res) => {
  console.log('--- FPL What-If Request ---');
  try {
    const { leagueId, managerId } = req.query;
    console.log(`Received request for League: ${leagueId}, Manager: ${managerId}`);

    if (!leagueId || !managerId) {
      return res.status(400).json({ error: 'leagueId and managerId are required.' });
    }

    // Step 1: Get current gameweek
    console.log('Step 1: Fetching current gameweek...');
    const bootstrapResponse = await fetchWithRetry(BOOTSTRAP_URL);
    const bootstrapData = await bootstrapResponse.json();
    const currentGW = bootstrapData.events.find(e => e.is_current).id;
    console.log(`Current Gameweek: ${currentGW}`);

    // Step 2: Fetch manager's transfer history
    console.log('Step 2: Fetching transfer history...');
    const transfersResponse = await fetchWithRetry(`${TEAM_API_URL}${managerId}/transfers/`);
    const transfersData = await transfersResponse.json();
    const transferGWs = [...new Set(transfersData.map(t => t.event))].sort((a, b) => a - b);
    console.log(`Transfer GWs: [${transferGWs.join(', ')}]`);

    // Step 3: Fetch picks for every GW (batched in groups of 5)
    console.log('Step 3: Fetching picks for all gameweeks...');
    const picksMap = {};
    const batchSize = 5;
    for (let i = 0; i < currentGW; i += batchSize) {
      const batch = [];
      for (let j = i; j < Math.min(i + batchSize, currentGW); j++) {
        const gw = j + 1;
        batch.push(
          fetchWithRetry(`${TEAM_API_URL}${managerId}/event/${gw}/picks/`)
            .then(r => r.json())
            .then(data => ({ gw, data }))
        );
      }
      const results = await Promise.all(batch);
      for (const { gw, data } of results) {
        if (data.picks && Array.isArray(data.picks)) {
          picksMap[gw] = data;
        } else {
          picksMap[gw] = null;
        }
      }
      if (i + batchSize < currentGW) await sleep(200);
    }
    console.log(`Fetched picks for ${Object.keys(picksMap).length} gameweeks`);

    // Step 4: Fetch live player data for every GW (parallel)
    console.log('Step 4: Fetching live player data for all gameweeks...');
    const gwPlayerData = {};
    const livePromises = [];
    for (let gw = 1; gw <= currentGW; gw++) {
      livePromises.push(
        fetchWithRetry(`${LIVE_API_URL}${gw}/live/`)
          .then(r => r.json())
          .then(data => ({ gw, data }))
      );
    }
    const liveResults = await Promise.all(livePromises);
    for (const { gw, data } of liveResults) {
      gwPlayerData[gw] = {};
      for (const el of data.elements) {
        gwPlayerData[gw][el.id] = {
          points: el.stats.total_points,
          minutes: el.stats.minutes
        };
      }
    }
    console.log(`Fetched live data for ${Object.keys(gwPlayerData).length} gameweeks`);

    // Step 5: Build actual cumulative points
    console.log('Step 5: Building actual cumulative points...');
    const actual = [];
    for (let gw = 1; gw <= currentGW; gw++) {
      const history = picksMap[gw]?.entry_history;
      actual.push({
        gw,
        points: history ? history.total_points : null
      });
    }

    // Step 6: Determine freeze points (GW 1 + every transfer GW, excluding Free Hit GWs)
    const freeHitGWs = new Set();
    for (let gw = 1; gw <= currentGW; gw++) {
      if (picksMap[gw]?.active_chip === 'freehit') {
        freeHitGWs.add(gw);
      }
    }
    if (freeHitGWs.size > 0) {
      console.log(`Free Hit GWs (excluded from branches): [${[...freeHitGWs].join(', ')}]`);
    }

    const allFreezeGWs = [1, ...transferGWs.filter(gw => gw !== 1)]
      .filter(gw => !freeHitGWs.has(gw))
      .sort((a, b) => a - b);
    console.log(`Freeze points: [${allFreezeGWs.join(', ')}]`);

    // Step 7: Compute branches
    console.log('Step 7: Computing branch simulations...');
    const branches = [];

    for (const freezeGW of allFreezeGWs) {
      const frozenPicksData = picksMap[freezeGW];
      if (!frozenPicksData || !frozenPicksData.picks) continue;

      const frozenPicks = frozenPicksData.picks;

      // Normalize chip multipliers for subsequent GWs:
      // - Triple Captain (3) reverts to normal Captain (2)
      // - Bench Boost (bench players with multiplier 1) revert to bench (0)
      const normalizedPicks = frozenPicks.map(p => ({
        ...p,
        multiplier: p.position >= 12 ? 0 : (p.multiplier === 3 ? 2 : p.multiplier)
      }));

      // Base points: actual total at end of (freezeGW - 1)
      let basePoints = 0;
      if (freezeGW > 1 && picksMap[freezeGW - 1]?.entry_history) {
        basePoints = picksMap[freezeGW - 1].entry_history.total_points;
      }

      const branchData = [];
      let runningTotal = basePoints;

      for (let gw = freezeGW; gw <= currentGW; gw++) {
        if (!gwPlayerData[gw]) {
          branchData.push({ gw, points: runningTotal });
          continue;
        }

        // Use original multipliers for the freeze GW (chip was active), normalized for subsequent GWs
        const picksForGW = (gw === freezeGW) ? frozenPicks : normalizedPicks;
        const effectiveLineup = simulateAutoSubs(picksForGW, gwPlayerData[gw]);

        let gwPoints = 0;
        for (const player of effectiveLineup) {
          const pData = gwPlayerData[gw][player.element];
          const rawPoints = pData ? pData.points : 0;
          gwPoints += rawPoints * player.multiplier;
        }

        runningTotal += gwPoints;
        branchData.push({ gw, points: runningTotal });
      }

      branches.push({
        freezeGW,
        label: `GW${freezeGW} freeze`,
        data: branchData
      });
    }

    console.log(`Computed ${branches.length} branches`);
    console.log('--- Request Complete ---');

    res.status(200).json({
      managerId: parseInt(managerId),
      currentGW,
      actual,
      branches
    });

  } catch (error) {
    console.error('An unhandled error occurred:', error);
    res.status(500).json({ error: 'Internal server error. Please try again later.' });
  }
};
