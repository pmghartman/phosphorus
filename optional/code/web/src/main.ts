// the code app's page: claude code and opencode sessions on any mesh host, in its
// desktop window, the desktop's theme worn, or in a tab of its own
import { followTheme } from "@phosphorus/app-sdk/web";
import "./state.ts";
import "./frame.ts";
import "./list.ts";
import "./session.ts";
import "./events.ts";
import "./tools.ts";
import "./diffs.ts";
import "./todos.ts";
import "./perms.ts";
import "./composer.ts";
import "./newsession.ts";
import "./account.ts";
import { paintAcct } from "./account.ts";
import { main } from "./frame.ts";
import { loadList, loadOpts } from "./list.ts";
import { connect, paintHead, paintOne } from "./session.ts";
import { cd, LIST_MS } from "./state.ts";

function codeWatch(on: boolean): void {
  cd.on = on;
  clearInterval(cd.tick);
  cd.tick = 0;
  if (!on) {
    for (const t of cd.logs.values()) {
      t.closed = true;
      t.sock?.close();
      t.sock = null;
    }
    return;
  }
  loadOpts(true).then(() => {
    paintHead();
    paintAcct();
  });
  loadList().then(() => {
    if (cd.pick && cd.pick !== "new" && !main.querySelector(".cd-log")) paintOne();
    else if (cd.pick !== "new") {
      const t = cd.logs.get(cd.pick);
      if (t) {
        t.closed = false;
        connect(t);
      }
    }
  });
  cd.tick = setInterval(() => {
    if (!document.hidden) loadList();
  }, LIST_MS);
}

followTheme();
codeWatch(true);
