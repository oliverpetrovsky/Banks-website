# Banks & Bloodlines

Banks & Bloodlines is a finance strategy event conducted by E-Cell at SYNERGY, the college fest. The website has three panels: a public landing page and completed-auction leaderboard at `/`, event controls at `/admin`, and participant bidding at `/team`.

Only a signed-in admin can switch the active event between Round 1, **The Banking Syndicate**, and Round 2, **Bloodlines**. The selected round is stored by the server, and public/team pages follow it automatically; those pages show the active round without offering a switch control.

The app loads fictional companies from `data/test.json` by default. Event-specific company data is intentionally excluded from the public repository. When the approved event dataset is ready, keep it in a private local file and select it with `COMPANIES_FILE`.

For initial team accounts, place a private file at `data/initial-teams.json` and set `INITIAL_TEAMS_FILE=data/initial-teams.json`. It is ignored by Git. The file must contain a JSON array with `name` and `accessCode` for each team. Access codes must be at least 12 characters:

```json
[
  { "name": "Team Alpha", "accessCode": "a-private-code-at-least-12-characters" }
]
```

The server hashes each code and seeds the accounts into `.data/bids.json` once; later file edits do not reset existing accounts. The Render test Blueprint uses `data/test-teams.json`, which contains public dummy credentials for three test teams. Never put real team access codes in a public repository or use the test credentials for an event.

Each team account can have active sessions from only one client IP at a time. Logging in from another IP is rejected until the existing session is signed out or expires. Behind Render or another reverse proxy, the server uses `X-Forwarded-For` to identify the client IP; only deploy behind a proxy that sets this header.

The participant leaderboard shows team names, ranks, and BVI scores, but hides other teams' principal and interest offers. A team sees its own submitted offer, and admins can see all submitted offer details.

## Deploy a test instance on Render

1. Push this repository to GitHub. Confirm `data/companies.json` is not tracked; the Render Blueprint uses only the fictional `data/test.json`.
2. In Render, choose **New → Blueprint**, connect `oliverpetrovsky/Banks-website`, and deploy the `render.yaml` Blueprint.
3. Render generates a private `ADMIN_PASSWORD`, enables secure session cookies, and seeds three dummy test teams. Find the admin password in the service's environment settings; test team names and access codes are listed in `data/test-teams.json`.
4. Open the deployed service URL. The public page is `/`, the team panel is `/team`, and administration is `/admin`.

The Blueprint uses Render's free instance for testing. Its local JSON store is ephemeral: team accounts, bids, and auction state can be lost when Render restarts or redeploys the service. Admin and team sessions also expire on restarts. Do not use this deployment for a live event or real company data. Persistent storage requires a paid Render disk or replacing the JSON store with a managed database.

## Run locally

Requires Node.js 18 or newer.

```sh
ADMIN_PASSWORD='choose-a-long-private-password' node server.js
```

Open `http://localhost:3000`. The public leaderboard only shows results after an auction closes; open-auction bids are visible to signed-in teams and admins. Additional winner briefings are returned only to the authenticated team that won the corresponding closed auction. To let participants join on the same network, run the app on a trusted host and share that host's address. Configure a firewall and use HTTPS for any deployment beyond a trusted event network. Set `COOKIE_SECURE=1` when HTTPS is enabled. `PORT`, `BIDS_FILE`, and `COMPANIES_FILE` can be set to change the listening port, saved auction data, and company dataset.

## Event setup

1. Open `/admin` and sign in with `ADMIN_PASSWORD`.
2. Create an account for each registered team. Give each team its name and one-time access code privately; the code is only displayed when the account is created.
3. Before the live round, select an era and company, then start the auction. Only the active company accepts bids.
4. Participants open `/team` and sign in with their team name and access code. Their BVI and estimated rank recalculate as they edit principal and interest.
5. Submitted bids appear on the live leaderboard. Teams can update their bid while that company is open. Close the auction before moving to the next company.
6. Once an auction is closed, the public leaderboard shows its winning team and BVI. The winning team can read the company's additional briefing in its team panel.

## Round 1 rules implemented

- Each team has one ₹6,00,000 vault total, shared across all three eras.
- The maximum offer for a single company is ₹2,50,000.
- Principal is submitted in ₹10,000 increments, at or above the company's minimum funding floor.
- Interest is submitted in 0.5% increments, no higher than the company's maximum rate.
- The site calculates `BVI = (principal offered / principal requested) × ((maximum rate − offered rate) / maximum rate)`.
- Leaderboard ties are resolved by lower interest, then the earliest current bid. Updating a bid gives it a new submission time.
- Admins can open one company at a time, close the current auction, and monitor all bids for the active company.
- The website does not calculate company outcomes or team net-profit rankings; those require the event engine after the auction.

Bid records and salted team access-code hashes are saved in `.data/bids.json` by default and survive a restart. Admin sessions and team login sessions expire on restart. The current auction selection and status are saved with the bid data.

## Round 2: Bloodlines

Bloodlines guides each household through an 80-year simulation split into nine admin-configurable, consecutive sub-rounds. The default schedule covers Years 1–9, 10–18, and so on through Years 73–80. Before starting, the admin may edit the ranges; they must cover Years 1–80 exactly, with no gaps or overlap.

Each sub-round follows the same sequence:

1. Teams submit an opening allocation. Portfolios, cash, debt, and insurance carry forward.
2. The admin opens the news sequence and releases one news flash per simulation year. Each release processes that year's salary, expenses, dividends, deposit maturities, and debt interest, and reveals the year's market prices to all teams.
3. The admin starts the Wheel and triggers one team's digital spin at a time. Teams see the active spin live and each result after it lands; an outcome remains hidden until then. Outcomes are independently randomized for each team.
4. Teams submit a reallocation after seeing the Wheel consequence.
5. The admin closes the sub-round to open the next one. After the ninth sub-round, the admin publishes the final net-worth leaderboard.

The admin controls each step at `/admin` after selecting Round 2. Teams sign in at `/team` to see their private portfolio, the shared news and market disclosures, Wheel progress, and their allocation form during the two allocation windows. The public leaderboard only shows Bloodlines results after the admin publishes them.

The fictional `data/bloodlines-test-market.json` is for testing only. It uses deterministic `{ "start": number, "annualGrowth": number }` series, expanded to 80 annual values by the server. An event market file can instead provide exactly 80 positive values for each equity and fund under `prices.equities` and `prices.funds`, 80 values in `prices.gold`, and 80 values each for `household.salary` and `household.expenses`. It must also include `household.startingCash`. Keep actual event data in a private file and set `BLOODLINES_MARKET_FILE` to its path; never commit real market, household, or event data. Bloodlines state is stored separately in `.data/bloodlines.json` by default; set `BLOODLINES_STORE_FILE` to change it. The new simulation flow uses a different save schema from the earlier four-year version: back up the old file and move it aside before starting this version. As with Round 1, Render's free filesystem is ephemeral and is unsuitable for a live event.

## Before the event

This is a first version for a controlled event deployment. Team access codes should be shared privately. Set a strong admin password, use HTTPS outside a trusted local network, and back up the `.data` directory. The access codes are hashed, but there is no self-service account recovery. The site currently uses synthetic companies until the organizers approve and install the real event data.
