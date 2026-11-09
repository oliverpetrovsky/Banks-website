# Banks & Bloodlines

Banks & Bloodlines is a finance strategy event conducted by E-Cell at SYNERGY, the college fest. The website has three panels: a public landing page and completed-auction leaderboard at `/`, event controls at `/admin`, and participant bidding at `/team`.

The app loads fictional companies from `data/test.json` by default. Event-specific company data is intentionally excluded from the public repository. When the approved event dataset is ready, keep it in a private local file and select it with `COMPANIES_FILE`.

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

- Each team has a separate ₹6,00,000 vault for each era.
- The maximum offer for a single company is ₹2,50,000.
- Principal is submitted in ₹10,000 increments, at or above the company's minimum funding floor.
- Interest is submitted in 0.5% increments, no higher than the company's maximum rate.
- The site calculates `BVI = (principal offered / principal requested) × ((maximum rate − offered rate) / maximum rate)`.
- Leaderboard ties are resolved by lower interest, then the earliest current bid. Updating a bid gives it a new submission time.
- Admins can open one company at a time, close the current auction, and monitor all bids for the active company.
- The website does not calculate company outcomes or team net-profit rankings; those require the event engine after the auction.

Bid records and salted team access-code hashes are saved in `.data/bids.json` by default and survive a restart. Admin sessions and team login sessions expire on restart. The current auction selection and status are saved with the bid data.

## Before the event

This is a first version for a controlled event deployment. Team access codes should be shared privately. Set a strong admin password, use HTTPS outside a trusted local network, and back up the `.data` directory. The access codes are hashed, but there is no self-service account recovery. The site currently uses synthetic companies until the organizers approve and install the real event data.
