// the server's shapes as the page reads them, from the packages that build them:
// buildState() in server, the chat socket, the files api, the account, code,
// stats. The server marshals most of these as Record<string, any>, so each
// field here is one the page relies on, optional where a host may leave it out.

export * from "./state.ts";
export * from "./chat.ts";
export * from "./files.ts";
export * from "./account.ts";
export * from "./code.ts";
export * from "./stats.ts";
export * from "./md.ts";
