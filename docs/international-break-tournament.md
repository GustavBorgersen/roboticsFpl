# International Break Tournament 🏆

A mini game for **The Robotics Premiership** (league `144226`, 30 managers) that runs while normal FPL is paused for an international break. Managers compete with their FPL squads, scored on how their players do for their national teams.

The tournament is the first thing you see on the roboticsFpl page during an active break. The normal FPL page is still there below it: scroll down, or press the minimize button to collapse the tournament.

---

## 1. Rules

### Squads
- Each manager's squad is **locked to the gameweek immediately before the break** (`snapshotGW` in the break config).
- **All 15 players count** (starting XI + bench). No captain, no bench order, no transfers.
- Squads are fetched from the FPL API's historical picks endpoint, so nothing needs to be snapshotted or stored.

### Which matches count
- **Every international match** a squad player plays during the break counts: Nations League, World Cup/continental qualifiers, friendlies, etc.
- A match belongs to the round whose date range contains its kickoff date, in **Swedish time** (`Europe/Stockholm`).
- A player who plays twice within one round's date range scores for both matches. A player with no match in a round scores 0 for that round.

### Scoring

| Event | Points | Eligibility |
| :--- | :---: | :--- |
| Goal | **+5** | All positions |
| Assist | **+3** | All positions |
| Clean sheet | **+4** | GK & DEF only (min. 60 mins played, 0 conceded) |
| Penalty save | **+5** | GK only |
| Yellow card | **−1** | All positions |
| Red card | **−3** | All positions (direct or second yellow) |
| Own goal / missed penalty | **−2** | All positions |

Appearance points and bonus points are deliberately left out.

---

## 2. Format

The break is split into **4 rounds**, each defined by a date range in the break config.

### Rounds 1–2: Group stage
- 30 managers are split into **4 groups** (A, B, C, D) of 8, 8, 7 and 7.
- Groups are **seeded by mini-league rank at the snapshot GW** using a snake draft, so they are balanced and always computed the same way:
  - Ranks 1–4 → A, B, C, D
  - Ranks 5–8 → D, C, B, A
  - Ranks 9–12 → A, B, C, D … and so on.
- A manager's group score is their **total points over rounds 1 and 2**.
- **Only the group winner advances.** Four managers reach the semi-finals.

### Round 3: Semi-finals (head-to-head)
- The group winners are ranked by group-stage points (1–4).
- **Semi 1:** seed 1 vs seed 4 · **Semi 2:** seed 2 vs seed 3.
- Higher round 3 score wins.

### Round 4: Final & 3rd place (head-to-head)
- **Final:** the semi-final winners. Highest round 4 score lifts the trophy.
- **3rd place match:** the semi-final losers.

### Tiebreakers
Used for group positions and head-to-head ties, in this order:
1. Most goals scored (in the stage being decided).
2. Fewest card deductions.
3. Higher mini-league rank at the snapshot GW.

### Golden Boot: the overall leaderboard
Every manager keeps scoring all break, eliminated or not. A separate **Golden Boot** table ranks all 30 managers by total points across all 4 rounds, so everyone still has something to play for (and something to be mocked for: the bottom spot gets the 🥄 wooden spoon).

---

## 3. Break config (manual step)

Before each break, someone edits `breaks.json` in the repo with the dates. That's about 3 times a season.

```json
{
  "breaks": [
    {
      "id": "2026-10",
      "name": "October Break",
      "snapshotGW": 7,
      "start": "2026-10-05",
      "end": "2026-10-14",
      "rounds": [
        { "round": 1, "stage": "group", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
        { "round": 2, "stage": "group", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
        { "round": 3, "stage": "semi",  "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
        { "round": 4, "stage": "final", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" }
      ]
    }
  ]
}
```

*(The dates above are placeholders; the real schedule for this break still has to be checked.)*

- **Active break:** today is between `start` and a few days after `end` (grace period so the final result stays up). While a break is active, the tournament is shown at the top of the page.
- **Round status:** a round is **Live / provisional** until its `end` date has passed, then **Final**. Group qualification and semi-final results only lock once their rounds are final.
- Past breaks stay in the file, which keeps a history of winners.

---

## 4. Page experience

The tournament should feel like a proper cup competition, not another stats table. Ideas for the look:

- **Hero banner** at the top: tournament name, current round and stage ("Group stage · Round 2 of 4"), a Live badge while matches are being played, and a countdown to the end of the round.
- **Group cards:** four cards (A–D) side by side on desktop and stacked on mobile. Each shows its managers with points; the current leader is highlighted as "advancing".
- **Knockout bracket:** semi-finals → final, with a 🏆 at the end and the 3rd place match below. Before round 3 it shows the group winners filling in as they're decided.
- **Golden Boot table:** all 30 managers, top 3 highlighted, 🥄 on the last place.
- **Squad drill-down:** tap a manager to see which of their players scored what (e.g. "Haaland ⚽⚽ +10", "Saka 🟨 −1"). This is where most of the banter comes from.
- **Minimize button:** collapses the tournament into a slim bar ("🏆 International Break Tournament: Round 2 live · show"). The choice is remembered in the browser, so it stays collapsed on the next visit.
- Below the tournament, the normal FPL page continues unchanged.
- Outside an active break, the page looks exactly as it does today.

---

## 5. Technical design

### Fits the existing Vercel app
- **No GitHub Action or daily job.** Standings are computed on request by a new serverless endpoint, `api/get-break-tournament.js`.
- **Caching:** the response is cached at Vercel's CDN (`Cache-Control: s-maxage=…, stale-while-revalidate`), so the external football API is only called a few times per hour at most, no matter how many people visit. Finished rounds could be cached much longer.
- Reuses `fetchPicksSafe`, `batchFetch` and `fetchWithRetry` from `api/_lib/fpl.js` for the FPL side.

### Data flow
1. Read `breaks.json` and find the active break.
2. Fetch league standings (for seeding) and every manager's picks for `snapshotGW` from the FPL API.
3. Fetch international fixtures within the break's date range from the football data API, then events and lineups for each finished or live fixture.
4. Match events to squad players via `players.json`, apply scoring and the round/stage logic.
5. Return groups, bracket, Golden Boot table and per-player breakdowns as JSON.

### Player mapping (`players.json`)
- The FPL API and the football data API use different player IDs, and names don't match reliably (Rodri vs. Rodrigo, mononyms, accents).
- Before each break, a one-off script lists the unique players across all 30 squads (roughly 150–250), matches them to the football API by name plus nationality, and writes `players.json`: `fpl_element_id → { name, nation, external_id }`.
- The few that don't match are fixed by hand. The file grows over the season, so later breaks need less work.

---

## 6. Open questions / to verify

- [ ] **Football data API:** confirm which provider's free tier covers all international competitions (including friendlies and non-UEFA qualifiers) for the current season, with events and lineups. API-Football is the first candidate.
- [ ] **This break's schedule:** verify online that the current break has 4 matches per team, and set the real round dates.
- [ ] **Request budget:** estimate daily API calls (fixture list + per-fixture events/lineups) against the free tier limit, and pick the cache duration accordingly.
- [ ] **Tiebreaker data:** confirm goals and cards can be counted from the same event data used for scoring.
