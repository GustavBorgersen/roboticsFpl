// api/get-live-standings.js
const { fetchWithRetry, sleep } = require('./_lib/fpl');

const LEAGUE_API_URL = 'https://fantasy.premierleague.com/api/leagues-classic/';
const TEAM_API_URL = 'https://fantasy.premierleague.com/api/entry/';
const BOOTSTRAP_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';

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

    // Step 1: Fetch bootstrap + standings in parallel
    console.log('Step 1: Fetching bootstrap & league standings...');
    const [bootstrapResponse, leagueResponse] = await Promise.all([
      fetchWithRetry(BOOTSTRAP_URL),
      fetchWithRetry(`${LEAGUE_API_URL}${leagueId}/standings/`)
    ]);
    const bootstrapData = await bootstrapResponse.json();
    const leagueData = await leagueResponse.json();

    if (leagueData.detail === 'Not found.') {
      console.error('Error: League not found.');
      return res.status(404).json({ error: 'League not found. Please check the League ID.' });
    }

    const currentGameweek = bootstrapData.events.find(event => event.is_current).id;
    console.log(`Current Gameweek is: ${currentGameweek}`);

    // Step 2: Get live player data for the current gameweek
    console.log('Step 2: Fetching live player data...');
    let livePlayerData = {};
    try {
      const liveResponse = await fetchWithRetry(`https://fantasy.premierleague.com/api/event/${currentGameweek}/live/`);
      const liveData = await liveResponse.json();
      livePlayerData = liveData.elements.reduce((acc, player) => {
        acc[player.id] = player.stats.total_points;
        return acc;
      }, {});
      console.log(`Live data fetched for ${Object.keys(livePlayerData).length} players`);
    } catch (error) {
      console.warn('Could not fetch live player data, will use static points:', error.message);
    }

    // Step 3: Get data for each manager and calculate live points
    console.log('Step 3: Processing each manager...');
    const liveStandings = [];

    for (const manager of leagueData.standings.results) {
      const managerId = manager.entry;
      console.log(`Processing manager: ${manager.player_name} (ID: ${managerId})`);

      try {
        const currentGwResponse = await fetchWithRetry(`${TEAM_API_URL}${managerId}/event/${currentGameweek}/picks/`);
        const currentGwData = await currentGwResponse.json();

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
            const currentGwPoints = currentGwData.entry_history ? currentGwData.entry_history.points : 0;
            const currentTotal = currentGwData.entry_history ? currentGwData.entry_history.total_points : manager.total;
            lastGameweekTotalPoints = currentTotal - currentGwPoints;
          }
        }

        const staticGwPoints = currentGwData.entry_history ? currentGwData.entry_history.points : 0;
        const staticTotalPoints = currentGwData.entry_history ? currentGwData.entry_history.total_points : manager.total;

        let liveGwPoints = staticGwPoints;
        if (Object.keys(livePlayerData).length > 0 && currentGwData.picks) {
          liveGwPoints = 0;
          currentGwData.picks.forEach(pick => {
            const playerLivePoints = livePlayerData[pick.element] || 0;
            liveGwPoints += playerLivePoints * pick.multiplier;
          });

        }

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

        await sleep(100);

      } catch (error) {
        console.error(`Error fetching data for manager ${managerId}:`, error);
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

    // Step 4: Calculate last gameweek positions and position changes
    console.log('Step 4: Calculating positions and changes...');
    const lastGameweekStandings = [...liveStandings].sort((a, b) => b.lastGameweekTotalPoints - a.lastGameweekTotalPoints);
    const lastGameweekPositions = new Map();
    lastGameweekStandings.forEach((manager, index) => {
      lastGameweekPositions.set(manager.managerId, index + 1);
    });

    liveStandings.sort((a, b) => b.livePoints - a.livePoints);

    const results = liveStandings.map((manager, index) => {
      const currentPosition = index + 1;
      const lastGameweekPosition = lastGameweekPositions.get(manager.managerId) || currentPosition;
      const positionChange = lastGameweekPosition - currentPosition;
      return {
        ...manager,
        currentPosition,
        lastGameweekPosition,
        positionChange,
        changeDirection: positionChange > 0 ? 'up' : positionChange < 0 ? 'down' : 'same'
      };
    });

    console.log('--- Request Complete ---');
    res.status(200).json({ gameweek: currentGameweek, results });

  } catch (error) {
    console.error('An unhandled error occurred:', error);
    res.status(500).json({ error: 'Internal server error. Please try again later.' });
  }
};
