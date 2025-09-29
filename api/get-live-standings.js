// api/get-live-standings.js
const LEAGUE_API_URL = 'https://fantasy.premierleague.com/api/leagues-classic/';
const TEAM_API_URL = 'https://fantasy.premierleague.com/api/entry/';
const BOOTSTRAP_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';

// Helper function to introduce a delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to fetch with retry logic
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

// Vercel serverless function entry point
module.exports = async (req, res) => {
  console.log('--- FPL Live Standings Request ---');
  try {
    const leagueId = req.query.leagueId;
    console.log(`Received request for League ID: ${leagueId}`);

    if (!leagueId) {
      console.error('Error: leagueId parameter is missing.');
      return res.status(400).json({ error: 'Please provide a leagueId parameter.' });
    }

    // Step 1: Get current gameweek information
    console.log('Step 1: Fetching current gameweek...');
    const bootstrapResponse = await fetchWithRetry(BOOTSTRAP_URL);
    const bootstrapData = await bootstrapResponse.json();
    const currentGameweek = bootstrapData.events.find(event => event.is_current).id;
    console.log(`Current Gameweek is: ${currentGameweek}`);

    // Step 2: Fetch league standings to get managers and their last week positions
    console.log(`Step 2: Fetching league standings for league ID: ${leagueId}`);
    const leagueResponse = await fetchWithRetry(`${LEAGUE_API_URL}${leagueId}/standings/`);
    const leagueData = await leagueResponse.json();

    if (leagueData.detail === 'Not found.') {
      console.error('Error: League not found.');
      return res.status(404).json({ error: 'League not found. Please check the League ID.' });
    }

    // Step 3: Get live player data for the current gameweek
    console.log('Step 3: Fetching live player data...');
    let livePlayerData = {};
    try {
      const liveResponse = await fetchWithRetry(`https://fantasy.premierleague.com/api/event/${currentGameweek}/live/`);
      const liveData = await liveResponse.json();
      // Create a map of player_id -> live_points for quick lookup
      livePlayerData = liveData.elements.reduce((acc, player) => {
        acc[player.id] = player.stats.total_points;
        return acc;
      }, {});
      console.log(`Live data fetched for ${Object.keys(livePlayerData).length} players`);
    } catch (error) {
      console.warn('Could not fetch live player data, will use static points:', error.message);
    }

    // Step 4: Get data for each manager and calculate live points
    console.log('Step 4: Processing each manager...');
    const liveStandings = [];

    for (const manager of leagueData.standings.results) {
      const managerId = manager.entry;
      console.log(`Processing manager: ${manager.player_name} (ID: ${managerId})`);

      try {
        // Get current gameweek picks
        const currentGwResponse = await fetchWithRetry(`${TEAM_API_URL}${managerId}/event/${currentGameweek}/picks/`);
        const currentGwData = await currentGwResponse.json();

        // Get previous gameweek data to calculate last gameweek total points
        let lastGameweekTotalPoints = 0;
        if (currentGameweek > 1) {
          try {
            const previousGwResponse = await fetchWithRetry(`${TEAM_API_URL}${managerId}/event/${currentGameweek - 1}/picks/`);
            const previousGwData = await previousGwResponse.json();
            if (previousGwData.entry_history) {
              lastGameweekTotalPoints = previousGwData.entry_history.total_points;
            }
          } catch (error) {
            console.warn(`Could not fetch previous gameweek data for manager ${managerId}`);
            // Fallback: use current total minus current gameweek points
            const currentGwPoints = currentGwData.entry_history ? currentGwData.entry_history.points : 0;
            const currentTotal = currentGwData.entry_history ? currentGwData.entry_history.total_points : manager.total;
            lastGameweekTotalPoints = currentTotal - currentGwPoints;
          }
        }

        // Calculate live points by combining picks with live player data
        const staticGwPoints = currentGwData.entry_history ? currentGwData.entry_history.points : 0;
        const staticTotalPoints = currentGwData.entry_history ? currentGwData.entry_history.total_points : manager.total;

        // Calculate live gameweek points if live data is available
        let liveGwPoints = staticGwPoints;
        if (Object.keys(livePlayerData).length > 0 && currentGwData.picks) {
          liveGwPoints = 0;
          currentGwData.picks.forEach(pick => {
            const playerId = pick.element;
            const playerLivePoints = livePlayerData[playerId] || 0;
            const multiplier = pick.multiplier;
            liveGwPoints += playerLivePoints * multiplier;
          });

          // Add any automatic substitution points
          if (currentGwData.automatic_subs) {
            currentGwData.automatic_subs.forEach(sub => {
              const subInPoints = livePlayerData[sub.element_in] || 0;
              const subOutPoints = livePlayerData[sub.element_out] || 0;
              liveGwPoints += subInPoints - subOutPoints;
            });
          }
        }

        // Calculate live total points
        const livePoints = staticTotalPoints - staticGwPoints + liveGwPoints;

        liveStandings.push({
          managerId: managerId,
          managerName: manager.player_name,
          teamName: manager.entry_name,
          livePoints: livePoints,
          pointsThisWeek: liveGwPoints,
          lastGameweekTotalPoints: lastGameweekTotalPoints,
          lastWeekPoints: manager.total
        });

        // Add small delay to avoid overwhelming the API
        await sleep(100);

      } catch (error) {
        console.error(`Error fetching data for manager ${managerId}:`, error);
        // Add manager with fallback data
        liveStandings.push({
          managerId: managerId,
          managerName: manager.player_name,
          teamName: manager.entry_name,
          livePoints: manager.total,
          pointsThisWeek: 0,
          lastGameweekTotalPoints: manager.total,
          lastWeekPoints: manager.total
        });
      }
    }

    // Step 5: Calculate last gameweek positions based on last gameweek total points
    console.log('Step 5: Calculating last gameweek positions...');
    const lastGameweekStandings = [...liveStandings].sort((a, b) => b.lastGameweekTotalPoints - a.lastGameweekTotalPoints);

    // Create a map of manager ID to last gameweek position
    const lastGameweekPositions = new Map();
    lastGameweekStandings.forEach((manager, index) => {
      lastGameweekPositions.set(manager.managerId, index + 1);
    });

    // Step 6: Sort by live points and calculate position changes
    console.log('Step 6: Calculating live positions and changes...');
    liveStandings.sort((a, b) => b.livePoints - a.livePoints);

    // Add current live position and calculate change from last gameweek
    const results = liveStandings.map((manager, index) => {
      const currentPosition = index + 1;
      const lastGameweekPosition = lastGameweekPositions.get(manager.managerId) || currentPosition;
      const positionChange = lastGameweekPosition - currentPosition;

      return {
        ...manager,
        currentPosition: currentPosition,
        lastGameweekPosition: lastGameweekPosition,
        positionChange: positionChange,
        changeDirection: positionChange > 0 ? 'up' : positionChange < 0 ? 'down' : 'same'
      };
    });

    console.log('--- Request Complete ---');
    res.status(200).json({
      gameweek: currentGameweek,
      results: results
    });

  } catch (error) {
    console.error('An unhandled error occurred:', error);
    res.status(500).json({ error: 'Internal server error. Please try again later.' });
  }
};