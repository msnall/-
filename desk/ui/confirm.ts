// A confirm box drawn by the page itself. window.confirm is silently answered "cancel" in some embedded browsers (the desktop app's
// Browser pane), which made buttons look dead; this one always shows.
export function confirmBox(message: string, options: { yes?: string; no?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "home-modal-backdrop";
    backdrop.style.zIndex = "10000";
    const box = document.createElement("div");
    box.className = "home-modal";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const text = document.createElement("p");
    text.style.whiteSpace = "pre-wrap";
    text.textContent = message;
    const row = document.createElement("div");
    row.className = "home-confirm-actions";
    const done = (value: boolean) => { backdrop.remove(); document.removeEventListener("keydown", onKey); resolve(value); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") done(false); };
    const no = document.createElement("button");
    no.textContent = options.no ?? "取消";
    no.onclick = () => done(false);
    const yes = document.createElement("button");
    yes.textContent = options.yes ?? "继续";
    yes.className = options.danger === false ? "primary" : "home-danger";
    yes.onclick = () => done(true);
    row.append(no, yes);
    box.append(text, row);
    backdrop.append(box);
    backdrop.onclick = (e) => { if (e.target === backdrop) done(false); };
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
    yes.focus();
  });
}
