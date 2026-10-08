// This illustration is entirely local. It never uses storage, a signer or a network.
const demoNodes = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-demo-node]"));
const demoResult = document.getElementById("demo-result");
for (const node of demoNodes) {
  node.addEventListener("click", () => {
    const online = node.getAttribute("aria-pressed") !== "true";
    node.setAttribute("aria-pressed", String(online));
    const state = node.querySelector(".node-state");
    if (state) state.textContent = online ? "Online" : "Offline";
    const available = demoNodes.filter((part) => part.getAttribute("aria-pressed") === "true").length;
    if (!demoResult) return;
    demoResult.dataset.recoverable = String(available >= 2);
    const heading = demoResult.querySelector("strong");
    const description = demoResult.querySelector("span");
    if (heading) heading.textContent = available >= 2 ? "Your file can come home." : "Not enough parts to recover.";
    if (description) description.textContent = `${available} ${available === 1 ? "part" : "parts"} available. ${available >= 2 ? "Enough to recover." : `Bring ${2 - available} ${available === 1 ? "node" : "nodes"} back online.`}`;
  });
}
