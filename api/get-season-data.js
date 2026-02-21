// api/get-season-data.js
// Consolidated endpoint: computes auto-subs, transfer costs, and player contributions
// from a single shared fetch of bootstrap, standings, live GW data, and picks.
const { fetchWithRetry, fetchPicksSafe, batchFetch, simulateAutoSubs } = require('./_lib/fpl');

const BOOTSTRAP_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';
const LEAGUE_API_URL = 'https://fantasy.premierleague.com/api/leagues-classic/';
const TEAM_API_URL = 'https://fantasy.premierleague.com/api/entry/';
const LIVE_API_URL = 'https://fantasy.premierleague.com/api/event/';

module.exports = async (req, res) => {
  console.log('--- FPL Season Data Request ---');
  try {
    const { leagueId } = req.query;
    if (!leagueId) {
      return res.status(400).json({ error: 'leagueId is required.' });
    }

    // Step 1: Fetch bootstrap + standings in parallel
    console.log('Step 1: Fetching bootstrap & league standings...');
    const [bootstrapResponse, leagueResponse] = await Promise.all([
      fetchWithRetry(BOOTSTRAP_URL),
      fetchWithRetry(`${LEAGUE_API_URL}${leagueId}/standings/`)
    ]);
    const bootstrapData = await bootstrapResponse.json();
    const leagueData = await leagueResponse.json();

    if (leagueData.detail === 'Not found.') {
      return res.status(404).json({ error: 'League not found. Please check the League ID.' });
    }

    const currentGameweek = bootstrapData.events.find(e => e.is_current).id;
    const finishedGWs = bootstrapData.events.filter(e => e.finished).map(e => e.id);
    console.log(`Current GW: ${currentGameweek}, Finished GWs: ${finishedGWs.length}`);

    // Build player info map: id → { name, position (element_type) }
    const playerInfo = {};
    for (const el of bootstrapData.elements) {
      playerInfo[el.id] = { name: el.web_name, position: el.element_type };
    }

    // Collect managers from standings
    const managers = leagueData.standings.results.map(m => ({
      managerId: m.entry,
      managerName: m.player_name,
      teamName: m.entry_name,
      totalPoints: m.total
    }));
    console.log(`Managers: ${managers.length}`);

    // Step 2: Batch-fetch live GW data for all finished GWs
    console.log('Step 2: Fetching live GW data...');
    const gwLiveTasks = finishedGWs.map(gw => () =>
      fetchWithRetry(`${LIVE_API_URL}${gw}/live/`)
        .then(r => r.json())
        .then(data => ({ gw, data }))
    );
    const liveResults = await batchFetch(gwLiveTasks, 5, 300);

    // gwPlayerData[gw][playerId] = { points, minutes }
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

    // Step 3: Batch-fetch picks for all managers × all finished GWs
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
    const picksResults = await batchFetch(picksTasks, 10, 250);

    // Organise picks: managerId → gw → picksData
    const picksByManager = {};
    for (const { managerId, gw, data } of picksResults) {
      if (!picksByManager[managerId]) picksByManager[managerId] = {};
      picksByManager[managerId][gw] = data;
    }
    console.log(`Picks fetched for ${managers.length} managers across ${finishedGWs.length} GWs`);

    // Step 4: Compute all three metrics from shared data
    console.log('Step 4: Computing metrics...');

    const autoSubTotals = {};      // managerId → total points from auto-subs
    const transferCostTotals = {}; // managerId → total transfer cost penalty
    const playerTotals = {};       // managerId → { playerId → contributed points }

    for (const manager of managers) {
      autoSubTotals[manager.managerId] = 0;
      transferCostTotals[manager.managerId] = 0;
      playerTotals[manager.managerId] = {};

      const managerPicks = picksByManager[manager.managerId] || {};

      for (const gw of finishedGWs) {
        const picksData = managerPicks[gw];
        if (!picksData) continue;

        const gwData = gwPlayerData[gw] || {};

        // --- Auto-subs: use FPL's actual automatic_subs, points from live GW data ---
        if (picksData.automatic_subs && picksData.automatic_subs.length > 0) {
          for (const sub of picksData.automatic_subs) {
            const playerIn = gwData[sub.element_in];
            if (playerIn) {
              autoSubTotals[manager.managerId] += playerIn.points;
            }
          }
        }

        // --- Transfer costs: read penalty directly from entry_history ---
        if (picksData.entry_history) {
          transferCostTotals[manager.managerId] += picksData.entry_history.event_transfers_cost;
        }

        // --- Player contributions: simulate auto-subs, accumulate points × multiplier ---
        if (!Array.isArray(picksData.picks)) continue;

        const picks = picksData.picks;
        const activeChip = picksData.active_chip;

        let effectivePicks;
        if (activeChip === 'bboost') {
          // Bench Boost: all 15 players contribute (bench already has multiplier=1)
          effectivePicks = picks.map(p => ({ element: p.element, multiplier: p.multiplier }));
        } else {
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

    // Step 5: Build response
    console.log('Step 5: Building response...');

    // Auto-subs: sorted descending by totalAutoSubPoints
    const autoSubs = managers
      .map(m => ({
        managerName: m.managerName,
        teamName: m.teamName,
        totalAutoSubPoints: autoSubTotals[m.managerId] || 0
      }))
      .sort((a, b) => b.totalAutoSubPoints - a.totalAutoSubPoints);

    // Transfer costs: sorted descending by totalTransferCost (most costly first)
    const transferCosts = managers
      .map(m => ({
        managerName: m.managerName,
        teamName: m.teamName,
        totalTransferCost: transferCostTotals[m.managerId] || 0
      }))
      .sort((a, b) => b.totalTransferCost - a.totalTransferCost);

    // Player contributions: sorted managers desc by totalPoints, players desc by points
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

    console.log('--- Season Data Request Complete ---');
    return res.status(200).json({
      gameweek: currentGameweek,
      autoSubs,
      transferCosts,
      playerContributions: { managers: managersResponse }
    });

  } catch (error) {
    console.error('An unhandled error occurred:', error);
    return res.status(500).json({ error: 'Internal server error. Please try again later.' });
  }
};
