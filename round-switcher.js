const ROUND_STORAGE_KEY = "banks-bloodlines-round";

function selectRound(round, persist = true) {
  const selectedRound = round === "2" ? "2" : "1";
  document.body.dataset.round = selectedRound;
  document.querySelectorAll("[data-round-select]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.roundSelect === selectedRound));
  });
  document.querySelectorAll("[data-round-label]").forEach((label) => {
    label.textContent = selectedRound === "2"
      ? "ROUND 02 / BLOODLINES"
      : "ROUND 01 / THE BANKING SYNDICATE";
  });
  const notice = document.querySelector("#round-two-notice");
  if (notice) notice.hidden = selectedRound !== "2";
  if (persist) localStorage.setItem(ROUND_STORAGE_KEY, selectedRound);
  document.dispatchEvent(new CustomEvent("banks-round-change", {
    detail: { round: selectedRound }
  }));
}

document.querySelectorAll("[data-round-select]").forEach((button) => {
  button.addEventListener("click", () => selectRound(button.dataset.roundSelect));
});

selectRound(localStorage.getItem(ROUND_STORAGE_KEY) || "1", false);

window.addEventListener("storage", (event) => {
  if (event.key === ROUND_STORAGE_KEY) selectRound(event.newValue || "1", false);
});
