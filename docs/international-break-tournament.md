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

Details:
- A **second yellow** counts as a red card only (−3 total, the earlier yellow is dropped).
- A **saved penalty** is a missed penalty for the taker (−2) and a penalty save for the keeper (+5).
- A penalty goal gets no assist. Penalty shoot-outs don't count.
- Clean sheets are only given once the match has finished.

---

## 2. Format

The break is split into **4 rounds**, each defined by a date range in the break config.

### Rounds 1–2: Group stage
- 30 managers are split into **4 groups** (A, B, C, D): two groups of 8 and two of 7.
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

Before each break, someone edits `breaks.json` in the repo root with the dates. That's about 3 times a season. A good way to pick round dates is to follow the UEFA Nations League matchdays and stretch the first and last rounds to cover the whole break (from the day after the last PL game to the day before the next deadline).

```json
{
  "breaks": [
    {
      "id": "2026-09",
      "name": "September Break",
      "snapshotGW": 5,
      "start": "2026-09-22",
      "end": "2026-10-08",
      "rounds": [
        { "round": 1, "stage": "group", "start": "2026-09-22", "end": "2026-09-26" },
        { "round": 2, "stage": "group", "start": "2026-09-27", "end": "2026-09-30" },
        { "round": 3, "stage": "semi",  "start": "2026-10-01", "end": "2026-10-03" },
        { "round": 4, "stage": "final", "start": "2026-10-04", "end": "2026-10-08" }
      ],
      "playerOverrides": {},
      "extraNations": {}
    }
  ]
}
```

- `playerOverrides`: `{ "<fplElementId>": "<espnAthleteId>" }` for players the automatic name matching gets wrong or can't find.
- `extraNations`: `{ "<espnAthleteId>": "<ESPN national team name>" }` for players whose ESPN citizenship isn't the country they play for.
- The top-level `graceDays` (default 4) sets how long the result stays up after the break ends.

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
- **No GitHub Action or daily job.** Standings are computed on request by `api/get-break-tournament.js`.
- **Caching:** the response is cached at Vercel's CDN for 10 minutes (`s-maxage=600, stale-while-revalidate=1800`), and for 6 hours once every round is final. Outside a break the endpoint returns `{ "active": false }` without calling any external API.
- Reuses `fetchWithRetry`, `fetchPicksSafe` and `batchFetch` from `api/_lib/fpl.js`.
- Code layout:
  - `api/_lib/espn.js`: ESPN API calls.
  - `api/_lib/tournament.js`: player mapping, match scoring, groups/bracket logic.
  - `public/break-tournament.js`: the UI, rendered into `#breakTournament` at the top of `public/index.html`.

### Data source: ESPN's public soccer API
- `site.api.espn.com/apis/site/v2/sports/soccer/...`: free, no API key, covers every international competition (Nations League, friendlies, CONCACAF Nations League, AFCON and Asian qualifiers…).
- It is unofficial and undocumented, so it could change without notice. It rejects the custom `RoboticsFPL/1.0` User-Agent, so ESPN requests are sent without it.
- Endpoints used:
  - `eng.1/teams` and `eng.1/teams/{id}/roster`: Premier League squads with ESPN athlete IDs and citizenship.
  - `all/scoreboard?dates=YYYYMMDD&limit=1000`: every match on a date, all competitions.
  - `all/summary?event={id}`: line-ups, per-player box score (incl. goals conceded while on the pitch) and key events (goals with assister, cards, subs, penalties with minute).
- A few minor matches have no line-ups or key events. When key events are missing, box-score totals are used instead (no penalty detail or minutes).

### Data flow
1. Read `breaks.json` and find the active break.
2. From FPL: league standings and every manager's picks for `snapshotGW`. From ESPN: the 20 PL squads.
3. Map each squad player to an ESPN athlete (see below) and collect their nations.
4. Fetch ESPN scoreboards for each date in the break and keep started matches involving one of those nations.
5. Fetch summaries for those matches and score them for the tracked athletes. Only athlete IDs count, so a women's or club match with a matching team name scores nothing.
6. Assign rounds by kick-off date in Swedish time and build groups, bracket and Golden Boot.

A full request makes around 100 external calls and takes about 5 seconds.

### Player mapping (automatic)
- Each FPL player is matched by name against the ESPN squad of the **same club**, so there are only ~30 candidates and matching is reliable (137 of 139 squad players matched on the first run).
- Unmatched players are returned in the response's `diagnostics.unmatchedPlayers`. Typically they are players who left the PL or academy players ESPN doesn't list; fix any that matter with `playerOverrides`.
- The response also lists `diagnostics.nationsWithoutMatches` (nations with no scored match yet) and `diagnostics.matchesWithoutData`.

---

## 6. Open questions / to verify

- [x] **Football data API:** ESPN's public API covers all international matches with events and line-ups, no key needed.
- [x] **This break's schedule:** confirmed 4 Nations League matchdays (24–26 Sep, 27–29 Sep, 1–3 Oct, 4–6 Oct). Round dates set in `breaks.json`.
- [x] **Request budget:** no daily limit with ESPN; CDN caching keeps the load low anyway.
- [x] **Tiebreaker data:** goals and cards come from the same key events used for scoring.
- [ ] **Late-night matches in the Americas** kick off after midnight Swedish time, so they count towards the next day's round. Fine for now; revisit if it causes a borderline case.
- [ ] **ESPN reliability:** unofficial API. If it breaks, the tournament section fails quietly and the rest of the page is unaffected.
