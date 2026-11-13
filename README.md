# Banks & Bloodlines

Banks & Bloodlines is a finance strategy event conducted by E-Cell at SYNERGY, the college fest. The website has three panels: a public landing page and completed-auction leaderboard at `/`, event controls at `/admin`, and participant bidding at `/team`.

Only a signed-in admin can switch the active event between Round 1, **The Banking Syndicate**, and Round 2, **Bloodlines**. The selected round is stored by the server, and public/team pages follow it automatically; those pages show the active round without offering a switch control.

The app loads fictional companies from `data/test.json` by default. Event-specific company data is intentionally excluded from the public repository. When the approved event dataset is ready, keep it in a private local file and select it with `COMPANIES_FILE`.

For local initial team accounts, place a private file at `data/initial-teams.json` and set `INITIAL_TEAMS_FILE=data/initial-teams.json`. It is ignored by Git. The file must contain a JSON array with `name` and `accessCode` for each team. Access codes must be at least 12 characters:

```json
[
  { "name": "Team Alpha", "accessCode": "a-private-code-at-least-12-characters" }
]
```

The server hashes each code and seeds the accounts into `.data/bids.json` once; later file edits do not reset existing accounts. The Render test Blueprint uses `data/test-teams.json`, which contains public dummy credentials for three test teams. Never put real team access codes in a public repository or use the test credentials for an event.

Each team account can have active sessions from only one client IP at a time. Logging in from another IP is rejected until the existing session is signed out or expires. Behind Render or another reverse proxy, the server uses `X-Forwarded-For` to identify the client IP; only deploy behind a proxy that sets this header.

The participant leaderboard shows team names, ranks, and BVI scores, but hides other teams' principal and interest offers. A team sees its own submitted offer, and admins can see all submitted offer details.

## Deploy the final event on Render

Deploy from the repository root. The `final-site/` folder is Git-ignored and is only a local copy; Render will not deploy it from Git. The root `render.yaml` defines a paid Node web service and a 1 GB persistent disk mounted at `/var/data`. Render charges for the paid service and disk. A disk-backed service runs one instance and has brief downtime during deploys.

Before creating the Render service:

1. Push the updated repository to GitHub. Do not add company data, team access codes, market data, or the private access-code CSV to Git.
2. Prepare a private `bloodlines-market.json` using real event assumptions. It must include 80 positive annual values for each equity and fund in `prices.equities` and `prices.funds`, 80 values in `prices.gold`, 80 salary values, 80 expense values, and `household.startingCash`. `data/bloodlines-test-market.json` is synthetic test data and must not be used for the live event.

Create the service and upload its private inputs:

1. In Render, choose **New → Blueprint**, connect this repository and the branch you pushed, then apply `render.yaml`. The service may fail its first start until its secret files are added.
2. In the new service's **Environment → Secret Files**, add these files with the exact filenames shown:
  - `real-company-list.json`, from local `final-site/data/real-company-list.json`.
  - `initial-teams.json`, from local `final-site/data/initial-teams.json`. This contains the 41 team access codes; keep it private.
  - `bloodlines-market.json`, the real event market file prepared above.
3. In **Environment Variables**, set a new strong `ADMIN_PASSWORD` of at least 12 characters. Render generates one for a new service, but explicitly replace it if reusing an existing service. Do not reuse the previously exposed password. Leave `COOKIE_SECURE=1` enabled.
4. Save changes and redeploy. The Blueprint points all three inputs to `/etc/secrets/` and stores Round 1 data at `/var/data/bids.json` and Bloodlines data at `/var/data/bloodlines.json` on the persistent disk.

Verify the deployment before the event:

1. Confirm `/healthz` responds successfully, then sign in at `/admin` with the new admin password. Opening the admin dashboard initializes the 41 team accounts once; later changes to `initial-teams.json` do not overwrite existing accounts.
2. Privately distribute login codes from local `final-site/data/initial-team-access-codes.csv`. Never upload or commit that CSV.
3. Test one team login, verify the company list and Bloodlines salary/expense assumptions, and confirm the admin can set returns before starting Bloodlines. Complete Round 1 and lock qualifiers before switching to Round 2.
4. Back up `/var/data/bids.json` and `/var/data/bloodlines.json` before and after the event. Keep the Render disk attached; without it, event data is ephemeral.

## Run locally

Requires Node.js 18 or newer.

```sh
ADMIN_PASSWORD='choose-a-long-private-password' node server.js
```

Open `http://localhost:3000`. The public leaderboard only shows results after an auction closes; open-auction bids are visible to signed-in teams and admins. Additional winner briefings are returned only to the authenticated team that won the corresponding closed auction. To let participants join on the same network, run the app on a trusted host and share that host's address. Configure a firewall and use HTTPS for any deployment beyond a trusted event network. Set `COOKIE_SECURE=1` when HTTPS is enabled. `PORT`, `BIDS_FILE`, and `COMPANIES_FILE` can be set to change the listening port, saved auction data, and company dataset.

## Event setup

1. Open `/admin` and sign in with `ADMIN_PASSWORD`.
2. The 41 registered accounts are preloaded from the private roster file. Distribute each team's one-time access code privately; create any additional accounts before locking Round 1 qualifiers. Use **KICK** beside a team in Round 1 or the team selector in Bloodlines to revoke access. Kicks remove an open bid and expire pending loan requests; closed results and active loan schedules remain in the record.
3. Round 1 runs through each era's ten decade groups in year-range order. Start and close each company auction in the active decade, then settle the decade before the next one opens. If time is short, **SKIP TO ERA 3 · FINAL DECADE** marks unauctioned companies in the skipped decades as uninvested, applies normal cash growth, existing position settlements, and scheduled loan payments, expires unresolved loan requests, and leaves Era 3's final decade open for normal play.
4. Participants open `/team` and sign in with their team name and access code. Their BVI and estimated rank recalculate as they edit principal and interest. Offers cannot exceed their available cash.
5. Only the active company is sent to participants. Upcoming company details are served only to signed-in admins.
6. Decade settlement calculates each awarded company's NPI and any interest due, and credits 4% annual compound growth on uninvested cash. At decade ten, principal is returned according to the final NPI tier and all company positions for that era are cleared.
7. The public leaderboard shows closed auction winners and BVI. The winning team can read the company's additional briefing in its team panel.
8. After all three eras are complete, the admin reviews the Round 1 qualification preview in `/admin`, selects the teams advancing, and locks the list. The ranking is current settled cash plus remaining scheduled payments on active loans owed to the team, minus remaining scheduled payments the team owes. Defaulted loan balances are excluded. This is a projection only; it does not transfer money or change active loan balances. Requests not finally approved expire when Round 1 closes. Round 2 remains unavailable until at least one team is selected. Team registration closes when the list is locked.
9. Bloodlines uses its configured starting cash for every qualifier; Round 1 balances are not carried into the household simulation. Only selected teams can access Bloodlines.

## Round 1 rules implemented

- Each team starts with a ₹6,00,000 cash balance once; cash carries forward and compounds across eras.
- The maximum offer for a single company is ₹2,50,000.
- Principal is submitted in ₹10,000 increments, at or above the company's minimum funding floor.
- Interest is submitted in 0.5% increments, no higher than the company's maximum rate.
- The site calculates `BVI = (principal offered / principal requested) × ((maximum rate − offered rate) / maximum rate)`.
- Leaderboard ties are resolved by lower interest, then the earliest current bid. Updating a bid gives it a new submission time.
- Every era must contain exactly ten distinct decade groups, each labeled with a ten-year range such as `1811-1820`. Admins can auction only companies in the current group, and must close each auction before settling that decade.
- At each decade settlement, uninvested team cash compounds at 4% per annum for ten years. Each winning bid's NPI is `max(0, strategicCoefficient × (fundingModifier − interestDrag) / 100)`, where `fundingModifier = min(100, winning principal / principal required × 100)` and `interestDrag` is the winning annual interest rate in percentage points. NPI is rounded to two decimals and clamped to 0–100 before applying payout thresholds.
- NPI ≥ 50 earns simple interest for that decade: `principal × annual rate × 10`. Interest is paid once, at the decade settlement.
- At era end, positions with NPI < 50 return 40% of principal; positions with 50 ≤ NPI < 75 return principal; positions with NPI ≥ 75 return `principal × growthMultiplier`. A team's cash carries forward and its company portfolio is cleared before the next era.
- The private company dataset must include `strategicCoefficient` (0–100) and `growthMultiplier` (>0) for every company. It must include exactly ten unique, non-overlapping decade ranges for each era. To encode a firm that should never pass the interest threshold without an explicit scam label, keep its private strategic coefficient at or below 49. Do not expose these private scoring fields in participant responses.
- Teams may request private loans from one another during Round 1. The lender must accept before the admin can approve; comments from the borrower, lender, and admin are visible only to the involved teams and admin. Approval immediately transfers cash. Rates are 7%–20% per annum, terms are 1–19 years, and each team may have at most two active loans as borrower and lender combined. A team cannot borrow from a team that currently borrows from it. Total outstanding lending by a team cannot exceed 15% of its current cash balance.
- Loan requests are limited to one per borrower per rolling minute, and each team can receive at most five requests per rolling minute. Payments are automatically processed at decade settlements. Simple loans use equal annual payments with flat interest on original principal; compound loans use equal annual annuity payments against the outstanding balance. Loans accrue annual installments until the next decade checkpoint. If a borrower cannot cover the due installments, available cash is paid, the remaining principal and due interest are marked defaulted, and cash never becomes negative. A lender receives the amount collected.
- Admin sign-in remains password-protected and is not IP-bound. Participant sessions remain limited to the IP used at sign-in.

Bid records, salted team access-code hashes, cash balances, company positions, and settlement history are saved in `.data/bids.json` by default and survive a restart. Admin sessions and team login sessions expire on restart. Back up this file before changing the company dataset or resetting a test event.

## Round 2: Bloodlines

Bloodlines guides each household through an 80-year simulation split into nine admin-configurable, consecutive sub-rounds. The default schedule covers Years 1–9, 10–18, and so on through Years 73–80. Before starting, the admin may edit the ranges; they must cover Years 1–80 exactly, with no gaps or overlap.

Each sub-round follows the same sequence:

1. Before the first team allocates, the admin sets a displayed low/high return range and a separate actual annual return for every investment option. Teams see the range; actual returns determine market prices. Fixed-deposit actual rates apply to new deposits. Settings lock after the first allocation is submitted.
2. Teams submit an opening allocation. Portfolios, cash, debt, and insurance carry forward. The admin can assume no trades for any team that misses an initial allocation or reallocation.
3. The admin opens the news sequence and releases one news flash per simulation year, including a written effect, affected investments, and an editable percentage-point shift. The shift changes both the displayed range and the actual return for affected investments from that year onward. Each release also processes that year's salary, expenses, dividends, deposit maturities, and debt interest, and reveals market prices and shared news to all teams.
4. The admin starts the Wheel and triggers one team's digital spin at a time. Teams see the active spin live and each result after it lands; an outcome remains hidden until then. Outcomes are independently randomized for each team.
5. Teams submit a reallocation after seeing the Wheel consequence.
6. The admin closes the sub-round. The next sub-round opens with its own annual return setup before teams allocate again. After the ninth sub-round, the admin publishes the final net-worth leaderboard.

The admin controls each step at `/admin` after selecting Round 2. Teams sign in at `/team` to see their private portfolio and current net worth, each sub-round's annual returns, news effects and affected investments, market disclosures, Wheel progress, and their allocation form during the two allocation windows. Each team sees only its own net worth until the admin publishes the public leaderboard.

The fictional `data/bloodlines-test-market.json` is for testing only. It uses deterministic `{ "start": number, "annualGrowth": number }` series, expanded to 80 annual values by the server. An event market file can instead provide exactly 80 positive values for each equity and fund under `prices.equities` and `prices.funds`, 80 values in `prices.gold`, and 80 values each for `household.salary` and `household.expenses`. It must also include `household.startingCash`. Keep actual event data in a private file and set `BLOODLINES_MARKET_FILE` to its path; never commit real market, household, or event data. Bloodlines state is stored separately in `.data/bloodlines.json` by default; set `BLOODLINES_STORE_FILE` to change it. The new simulation flow uses a different save schema from the earlier four-year version: back up the old file and move it aside before starting this version. As with Round 1, Render's free filesystem is ephemeral and is unsuitable for a live event.

## Before the event

This is a first version for a controlled event deployment. The local app defaults to synthetic company and market data; the Render setup uses the private company and market files you upload. Team access codes should be shared privately. Set a strong admin password, use HTTPS outside a trusted local network, and back up the persistent data directory. The access codes are hashed, but there is no self-service account recovery.
