# SYNERGY bidding site

A no-dependency Node.js web app prototype. Participants submit sealed offers for the companies in each era; signed-in admins can view the best bids per company and open or close bidding.

The app loads the synthetic companies in `data/test.json` by default. Event-specific company data is intentionally excluded from the public repository. Add an approved event dataset locally and explicitly select it with `COMPANIES_FILE` only when it is ready to be used.

## Run locally

Requires Node.js 18 or newer.

```sh
cd website
ADMIN_PASSWORD='choose-a-long-private-password' node server.js
```

Open `http://localhost:3000`. To make the site reachable by participants on the same network, run it on a trusted host and share that host's LAN address. Configure a firewall and use HTTPS for any deployment beyond a trusted event network. Set `COOKIE_SECURE=1` when HTTPS is enabled. `PORT` and `BIDS_FILE` can be set to change the listening port and bid-data location.

Bid submissions are saved to `.data/bids.json` by default and survive a server restart. Back up this file between sessions if you need to preserve the results. Era open/closed state and admin sessions are held in memory and reset when the server restarts. To load an approved local event dataset later, set `COMPANIES_FILE` to its path when starting the server.

## Round 1 behavior

- Each era has a separate ₹6,00,000 vault; a team's bids in that era cannot exceed it.
- The single-company cap is ₹2,50,000.
- Principal is accepted in ₹10,000 increments, at or above the company's minimum funding floor.
- Interest is accepted in 0.5% increments, no higher than the company's maximum.
- A team's next bid on a company replaces its earlier bid for that company and era. Its latest submission timestamp is used for tie-breaking.
- The admin leaderboard ranks bids by the rulebook's Borrower Value Index (BVI), then by lower interest, then by earliest current submission. It shows the top five bids per company.
- The round rules require valid bids on at least three distinct companies per era; this first version displays that requirement but does not prevent teams from stopping below it.
- The site does not calculate company outcomes or team net-profit rankings; those require the event engine after the bids are awarded and resolved.

## Important before using with participants

This is a working first version, not a fully managed production service. Team identity currently uses a team name only; it is not linked to registration or protected by a team-specific access code. Admin access is password-protected, but participants should be given a trusted event-network URL and the admin password must not be shared. For a public internet deployment, add team authentication/registration, persistent era controls, HTTPS hosting, and operational backups before collecting official bids.
