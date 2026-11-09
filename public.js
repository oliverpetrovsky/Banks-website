async function requestJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not load the leaderboard.");
  return body;
}

function renderResults(results) {
  const board = document.querySelector("#public-leaderboard");
  if (results.length === 0) {
    board.innerHTML = '<p class="empty-state">No company auctions have been completed yet. Final standings will appear here after each auction closes.</p>';
    return;
  }
  board.replaceChildren(...results.map((result) => {
    const row = document.createElement("article");
    row.className = "result-row";
    const information = document.createElement("div");
    const era = document.createElement("span");
    era.className = "result-era";
    era.textContent = `${result.eraName} · ${result.companyId}`;
    const company = document.createElement("h3");
    company.className = "result-company";
    company.textContent = result.companyName;
    const winner = document.createElement("span");
    winner.className = "result-winner";
    winner.textContent = `Winning team: ${result.winner}`;
    information.append(era, company, winner);
    const score = document.createElement("strong");
    score.className = "result-score";
    score.textContent = `BVI ${result.bvi.toFixed(4)}`;
    row.append(information, score);
    return row;
  }));
}

async function refreshPublicBoard() {
  try {
    const data = await requestJson("/api/public/leaderboard");
    renderResults(data.results);
    const status = document.querySelector("#public-auction-status");
    const container = status.parentElement;
    if (data.activeCompany) {
      status.textContent = `LIVE AUCTION · ${data.activeCompany.name}`;
      container.classList.add("is-open");
      container.classList.remove("is-closed");
    } else {
      status.textContent = "NO LIVE AUCTION";
      container.classList.remove("is-open", "is-closed");
    }
  } catch (error) {
    const notice = document.createElement("p");
    notice.className = "empty-state";
    notice.textContent = error.message;
    document.querySelector("#public-leaderboard").replaceChildren(notice);
  }
}

refreshPublicBoard();
setInterval(() => {
  if (document.visibilityState === "visible") refreshPublicBoard();
}, 3000);
