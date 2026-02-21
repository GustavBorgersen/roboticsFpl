// api/_lib/fpl.js — shared utilities for FPL serverless functions
'use strict';

const FPL_HEADERS = { 'User-Agent': 'RoboticsFPL/1.0' };

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetch with exponential backoff retry.
 * Waits baseDelay*attempt ms between retries (2s, 4s, 6s, 8s by default).
 */
const fetchWithRetry = async (url, retries = 4, baseDelay = 2000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { headers: FPL_HEADERS });
      if (response.ok) return response;
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
  throw new Error(`Failed to fetch ${url} after ${retries} attempts.`);
};

/**
 * Fetch picks for a single manager/GW. Returns null on 404 (mid-season joiners)
 * instead of throwing.
 */
const fetchPicksSafe = async (url) => {
  const retries = 4;
  const baseDelay = 2000;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { headers: FPL_HEADERS });
      if (response.ok) return response;
      if (response.status === 404) return null;
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

/**
 * Simulate auto-subs for a given set of picks in a GW.
 * If a starter has 0 minutes, swap in the first eligible bench player (by position
 * order 12–15) with >0 minutes, inheriting the starter's multiplier.
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

module.exports = { FPL_HEADERS, sleep, fetchWithRetry, fetchPicksSafe, batchFetch, simulateAutoSubs };
