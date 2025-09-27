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

    // Step 3: Get live data for each manager
    console.log('Step 3: Fetching live data for each manager...');
    const liveStandings = [];

    for (const manager of leagueData.standings.results) {
      const managerId = manager.entry;
      console.log(`Processing manager: ${manager.player_name} (ID: ${managerId})`);

      try {
        // Get current gameweek live data
        const currentGwResponse = await fetchWithRetry(`${TEAM_API_URL}${managerId}/event/${currentGameweek}/picks/`);
        const currentGwData = await currentGwResponse.json();

        // Get previous gameweek data for position comparison
        let previousGwPoints = 0;
        if (currentGameweek > 1) {
          try {
            const previousGwResponse = await fetchWithRetry(`${TEAM_API_URL}${managerId}/event/${currentGameweek - 1}/picks/`);
            const previousGwData = await previousGwResponse.json();
            if (previousGwData.entry_history) {
              previousGwPoints = previousGwData.entry_history.total_points;
            }
          } catch (error) {
            console.warn(`Could not fetch previous gameweek data for manager ${managerId}`);
          }
        }

        // Calculate live points and this week's points
        const currentGwPoints = currentGwData.entry_history ? currentGwData.entry_history.points : 0;
        const livePoints = currentGwData.entry_history ? currentGwData.entry_history.total_points : manager.total;

        // Find last week's position (current position in league standings)
        const lastWeekPosition = manager.rank;

        liveStandings.push({
          managerId: managerId,
          managerName: manager.player_name,
          teamName: manager.entry_name,
          livePoints: livePoints,
          pointsThisWeek: currentGwPoints,
          lastWeekPosition: lastWeekPosition,
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
          lastWeekPosition: manager.rank,
          lastWeekPoints: manager.total
        });
      }
    }

    // Step 4: Sort by live points and calculate position changes
    console.log('Step 4: Calculating live positions and changes...');
    liveStandings.sort((a, b) => b.livePoints - a.livePoints);

    // Add current live position and calculate change
    const results = liveStandings.map((manager, index) => {
      const currentPosition = index + 1;
      const positionChange = manager.lastWeekPosition - currentPosition;

      return {
        ...manager,
        currentPosition: currentPosition,
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