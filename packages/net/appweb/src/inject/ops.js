// frame ops between the app's main process and the page, both ways through the server

const phosOps = {
  // page to app
  hello: 1,
  send: 2,
  invoke: 3,
  sync: 4,
  post: 5,
  wev: 8,
  fetch: 9,
  // either way: a port's message and its close, an answer to an id
  port: 6,
  portClose: 7,
  reply: 10,
  // app to server: a resource's head, its bytes, its end
  resHead: 11,
  resBody: 12,
  resEnd: 13,
  // app to page
  ready: 20,
  win: 21,
  load: 22,
  call: 23,
  msg: 24,
  gone: 25,
  ask: 26,
  tell: 27,
};
