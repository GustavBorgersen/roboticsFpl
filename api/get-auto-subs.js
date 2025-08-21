// api/get-auto-subs.js
const LEAGUE_API_URL = 'https://fantasy.premierleague.com/api/leagues-classic/';
const TEAM_API_URL = 'https://fantasy.premierleague.com/api/entry/';
const BOOTSTRAP_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';

// Vercel serverless function entry point
module.exports = async (req, res) => {
  // Use a try-catch block to handle any errors gracefully
  try {
    // Extract the leagueId from the query parameters, defaulting to a specific ID for testing
    const leagueId = req.query.leagueId; 

    if (!leagueId) {
      return res.status(400).json({ error: 'Please provide a leagueId parameter.' });
    }

    // Step 1: Get general data to find out the current gameweek
    const bootstrapResponse = await fetch(BOOTSTRAP_URL);
    const bootstrapData = await bootstrapResponse.json();
    const currentGameweek = bootstrapData.events.find(event => event.is_current).id;

    // Step 2: Fetch the league standings to get a list of all managers
    const leagueResponse = await fetch(`${LEAGUE_API_URL}${leagueId}/standings/`);
    const leagueData = await leagueResponse.json();

    // Check if the league exists
    if (leagueData.detail === 'Not found.') {
      return res.status(404).json({ error: 'League not found. Please check the League ID.' });
    }

    // Use a Map to store and accumulate each manager's total auto-sub points for the season
    const managerTotals = new Map();

    // Initialize the Map with manager names and zero points
    for (const manager of leagueData.standings.results) {
      managerTotals.set(manager.entry, {
        managerName: manager.player_name,
        teamName: manager.entry_name,
        totalAutoSubPoints: 0,
      });
    }

    // Step 3: Loop through each gameweek from the beginning of the season to the current one
    for (let gw = 1; gw <= currentGameweek; gw++) {
      // Step 4: Loop through each manager in the league
      for (const manager of leagueData.standings.results) {
        const managerId = manager.entry;
        
        // Fetch the team's picks for the specific gameweek
        const picksResponse = await fetch(`${TEAM_API_URL}${managerId}/event/${gw}/picks/`);
        const picksData = await picksResponse.json();

        // Check if there are substitutions for this gameweek
        if (picksData.automatic_subs && picksData.automatic_subs.length > 0) {
          // Identify the players who were auto-substituted in
          for (const sub of picksData.automatic_subs) {
            const playerInId = sub.element_in;
            
            // Find the substituted-in player's score from the main picks list
            const substitutedPlayer = picksData.picks.find(p => p.element === playerInId);
            if (substitutedPlayer) {
              // Get the manager's current total from the map
              const currentData = managerTotals.get(managerId);
              // Add the new points and update the map
              currentData.totalAutoSubPoints += substitutedPlayer.points;
              managerTotals.set(managerId, currentData);
            }
          }
        }
      }
    }

    // Step 5: Convert the Map values to an array for final sorting and display
    const results = Array.from(managerTotals.values());

    // Step 6: Sort the results by total auto-sub points in descending order
    results.sort((a, b) => b.totalAutoSubPoints - a.totalAutoSubPoints);

    // Send the final JSON response
    res.status(200).json({
      gameweek: currentGameweek,
      results
    });

  } catch (error) {
    // Log the error for debugging purposes on the Vercel dashboard
    console.error('Error fetching FPL data:', error);
    res.status(500).json({ error: 'Internal server error. Please try again later.' });
  }
};
