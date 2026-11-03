// the Claude account at the side's foot

import { API, el } from "./dom.ts";
import { acctBox, acctBtn } from "./frame.ts";
import { loadOpts } from "./list.ts";
import { saveToken, tokenInput } from "./newsession.ts";
import { paintHead, sessionVars } from "./session.ts";
import { call, cd } from "./state.ts";

export function paintAcct() {
  const on = !!cd.opts?.anthropic;
  acctBtn.replaceChildren(
    el("span", `cd-acct-dot${on ? " on" : ""}`),
    el("span", "cd-acct-t", "Claude account"),
    el("span", "cd-acct-st", on ? "signed in" : "sign in"),
  );
}

export function acctOpen(on: boolean) {
  acctBox.hidden = !on;
  acctBtn.setAttribute("aria-expanded", String(on));
  if (on) codeToken(acctBox);
}

export function codeToken(box: HTMLElement) {
  box.classList.add("cd-token");
  const title = el("div", "cd-k-sec-t", "Claude subscription");
  const state = el("span", "cd-k-state", "…");
  title.append(" ", state);
  const inp = tokenInput("cd-k-url cd-token-in");
  const save = Object.assign(el("button", "cd-k-key", "save token"), { type: "button" });
  const clear = Object.assign(el("button", "cd-k-key quiet", "clear"), { type: "button" });
  const hint = el("div", "cd-token-hint");
  hint.innerHTML =
    "Run <code>claude setup-token</code> in a terminal and paste the token it prints, for Opus, Sonnet and Haiku.";
  const bar = el("div", "cd-k-bar cd-token-bar");
  bar.append(inp, save, clear);
  box.replaceChildren(title, hint, bar);
  const paint = (on: boolean) => {
    state.textContent = on ? "connected" : "not connected";
    state.dataset.state = on ? "online" : "off";
    clear.hidden = !on;
    inp.placeholder = on ? "paste a new token to replace it" : "sk-ant-oat…";
  };
  const put = async (token: string) => {
    save.disabled = clear.disabled = true;
    try {
      const on = await saveToken(token);
      inp.value = "";
      paint(on);
      // saved: folded back into the account row, its dot saying so
      if (on && box === acctBox) acctOpen(false);
      loadOpts(true).then(() => {
        sessionVars.headSig = "";
        paintHead();
        paintAcct();
      });
    } catch (e) {
      state.textContent = (e as Error).message;
      state.dataset.state = "off";
    }
    save.disabled = clear.disabled = false;
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && inp.value.trim()) put(inp.value.trim());
  });
  save.addEventListener("click", () => {
    if (inp.value.trim()) put(inp.value.trim());
    else inp.focus();
  });
  clear.addEventListener("click", () => put(""));
  call(`${API}/options`).then(
    (o) => {
      cd.opts = o;
      paint(!!o.anthropic);
      paintAcct();
    },
    () => paint(false),
  );
  inp.focus({ preventScroll: true });
}
