// api/get-transfer-cost.js
const LEAGUE_API_URL = 'https://fantasy.premierleague.com/api/leagues-classic/';
const TEAM_API_URL = 'https://fantasy.premierleague.com/api/entry/';
const BOOTSTRAP_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';

// Helper function to introduce a delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to fetch with retry logic
const FPL_HEADERS = { 'User-Agent': 'RoboticsFPL/1.0' };

const fetchWithRetry = async (url, retries = 3, delay = 1000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { headers: FPL_HEADERS });
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
        throw error; // Throw the error if all retries are exhausted
      }
    }
  }
  throw new Error(`Failed to fetch ${url} after ${retries} attempts.`);
};

// Vercel serverless function entry point
module.exports = async (req, res) => {
  console.log('--- FPL Transfer Cost Request ---');
  try {
    const leagueId = req.query.leagueId;
    console.log(`Received request for League ID: ${leagueId}`);

    if (!leagueId) {
      console.error('Error: leagueId parameter is missing.');
      return res.status(400).json({ error: 'Please provide a leagueId parameter.' });
    }

    // Step 1: Get general data to find out the current gameweek
    console.log('Step 1: Fetching current gameweek...');
    const bootstrapResponse = await fetchWithRetry(BOOTSTRAP_URL);
    const bootstrapData = await bootstrapResponse.json();
    const currentGameweek = bootstrapData.events.find(event => event.is_current).id;
    console.log(`Current Gameweek is: ${currentGameweek}`);

    // Step 2: Fetch the league standings to get a list of all managers
    console.log(`Step 2: Fetching league standings for league ID: ${leagueId}`);
    const leagueResponse = await fetchWithRetry(`${LEAGUE_API_URL}${leagueId}/standings/`);
    const leagueData = await leagueResponse.json();

    if (leagueData.detail === 'Not found.') {
      console.error('Error: League not found.');
      return res.status(404).json({ error: 'League not found. Please check the League ID.' });
    }

    const managerCosts = new Map();
    for (const manager of leagueData.standings.results) {
      managerCosts.set(manager.entry, {
        managerName: manager.player_name,
        teamName: manager.entry_name,
        totalTransferCost: 0,
      });
    }

    // Step 3: Loop through each gameweek and each manager to find transfer costs
    console.log('Step 3: Looping through managers and gameweeks to calculate costs...');
    for (const manager of leagueData.standings.results) {
      const managerId = manager.entry;
      console.log(`Processing manager: ${manager.player_name} (ID: ${managerId})`);

      for (let gw = 1; gw <= currentGameweek; gw++) {
        try {
          const picksResponse = await fetchWithRetry(`${TEAM_API_URL}${managerId}/event/${gw}/picks/`);
          const picksData = await picksResponse.json();

          if (picksData && picksData.entry_history) {
            const transferCost = picksData.entry_history.event_transfers_cost;
            console.log(`  Transfer cost for GW${gw}: ${transferCost}`);

            const currentData = managerCosts.get(managerId);
            currentData.totalTransferCost += transferCost;
            managerCosts.set(managerId, currentData);
          } else {
            console.warn(`  Warning: Missing 'entry_history' data for manager ${managerId} in GW${gw}. Skipping.`);
          }
        } catch (error) {
          console.error(`  Error fetching data for manager ${managerId}, GW${gw}:`, error);
        }
      }
    }

    // Step 4: Convert the Map to an array, sort, and send the response
    console.log('Step 4: Sorting and preparing final response...');
    const results = Array.from(managerCosts.values());
    results.sort((a, b) => b.totalTransferCost - a.totalTransferCost);

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