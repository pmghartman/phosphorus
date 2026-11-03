// the chat's page: the desktop's theme worn, every part wired, the socket joined
import { followTheme } from "@phosphorus/app-sdk/web";
import "./state.ts";
import "./lines.ts";
import "./convs.ts";
import "./menus.ts";
import "./files.ts";
import "./compose.ts";
import "./find.ts";
import "./commands.ts";
import "./notify.ts";
import { stepConv } from "./convs.ts";
import { setConv } from "./files.ts";
import { toggleFind } from "./find.ts";
import { connectChat } from "./socket.ts";
import { refitMath } from "./state.ts";

followTheme(() => requestAnimationFrame(refitMath));

// ctrl+↑↓ through the conversations, ctrl+f a search of this one
document.addEventListener(
  "keydown",
  (e) => {
    if (e.altKey || e.shiftKey || e.metaKey || !e.ctrlKey) return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") stepConv(e.key === "ArrowDown" ? 1 : -1);
    else if (e.key === "f") toggleFind(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);

setConv("mesh");
connectChat();
