// api/get-auto-subs.js
const LEAGUE_API_URL = 'https://fantasy.premierleague.com/api/leagues-classic/';
const TEAM_API_URL = 'https://fantasy.premierleague.com/api/entry/';
const BOOTSTRAP_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';
const PLAYER_API_URL = 'https://fantasy.premierleague.com/api/element-summary/';
const FPL_HEADERS = { 'User-Agent': 'RoboticsFPL/1.0' };

// Vercel serverless function entry point
module.exports = async (req, res) => {
  console.log('--- FPL Auto-Sub Points Request ---');
  try {
    const leagueId = req.query.leagueId;
    console.log(`Received request for League ID: ${leagueId}`);

    if (!leagueId) {
      console.error('Error: leagueId parameter is missing.');
      return res.status(400).json({ error: 'Please provide a leagueId parameter.' });
    }

    // Step 1: Get general data to find out the current gameweek
    console.log('Step 1: Fetching current gameweek...');
    const bootstrapResponse = await fetch(BOOTSTRAP_URL, { headers: FPL_HEADERS });
    const bootstrapData = await bootstrapResponse.json();
    const currentGameweek = bootstrapData.events.find(event => event.is_current).id;
    console.log(`Current Gameweek is: ${currentGameweek}`);

    // Step 2: Fetch the league standings to get a list of all managers
    console.log(`Step 2: Fetching league standings for league ID: ${leagueId}`);
    const leagueResponse = await fetch(`${LEAGUE_API_URL}${leagueId}/standings/`, { headers: FPL_HEADERS });
    const leagueData = await leagueResponse.json();

    if (leagueData.detail === 'Not found.') {
      console.error('Error: League not found.');
      return res.status(404).json({ error: 'League not found. Please check the League ID.' });
    }

    const managerTotals = new Map();
    for (const manager of leagueData.standings.results) {
      managerTotals.set(manager.entry, {
        managerName: manager.player_name,
        teamName: manager.entry_name,
        totalAutoSubPoints: 0,
      });
    }

    // Step 3: Loop through each gameweek and each manager to find auto-subs
    console.log('Step 3: Looping through managers and gameweeks to calculate points...');
    for (const manager of leagueData.standings.results) {
      const managerId = manager.entry;
      console.log(`Processing manager: ${manager.player_name} (ID: ${managerId})`);

      for (let gw = 1; gw <= currentGameweek; gw++) {
        const picksResponse = await fetch(`${TEAM_API_URL}${managerId}/event/${gw}/picks/`, { headers: FPL_HEADERS });
        const picksData = await picksResponse.json();

        if (picksData.automatic_subs && picksData.automatic_subs.length > 0) {
          console.log(`  Found ${picksData.automatic_subs.length} auto-subs for GW${gw}`);
          for (const sub of picksData.automatic_subs) {
            const playerInId = sub.element_in;
            console.log(`  Auto-subbed player in: ${playerInId}`);

            // NEW: Fetch the specific player's data to get their points for this gameweek
            const playerResponse = await fetch(`${PLAYER_API_URL}${playerInId}/`, { headers: FPL_HEADERS });
            const playerData = await playerResponse.json();

            const gameweekHistory = playerData.history.find(event => event.round === gw);

            if (gameweekHistory) {
              const autoSubPoints = gameweekHistory.total_points;
              console.log(`  Player earned ${autoSubPoints} points for GW${gw}`);

              const currentData = managerTotals.get(managerId);
              currentData.totalAutoSubPoints += autoSubPoints;
              managerTotals.set(managerId, currentData);
            } else {
              console.warn(`  Warning: Could not find gameweek history for player ${playerInId} in GW${gw}. Points will be skipped.`);
            }
          }
        }
      }
    }

    // Step 4: Convert the Map to an array, sort, and send the response
    console.log('Step 4: Sorting and preparing final response...');
    const results = Array.from(managerTotals.values());
    results.sort((a, b) => b.totalAutoSubPoints - a.totalAutoSubPoints);

    console.log('--- Request Complete ---');
    res.status(200).json({
      gameweek: currentGameweek,
      results
    });

  } catch (error) {
    console.error('An unhandled error occurred:', error);
    res.status(500).json({ error: 'Internal server error. Please try again later.' });
  }
};