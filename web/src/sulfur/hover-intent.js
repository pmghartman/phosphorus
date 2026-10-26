// Only the actual source symbol and popup retain a hover. A bounded grace period
// allows crossing the gap; further motion outside them never extends that deadline.
export function mountHoverIntent({ target, tooltip, isAnchor, onMove, hide, delay = 250 }) {
  let timer = 0, pending = '', latest = null;
  const cancel = () => { clearTimeout(timer); timer = 0; pending = ''; };
  const defer = (kind, fn) => {
    if (timer && pending === kind) return;
    cancel(); pending = kind;
    timer = setTimeout(() => { timer = 0; pending = ''; fn(); }, delay);
  };
  const move = (event) => {
    latest = event;
    if (tooltip.hidden) { cancel(); onMove(event); }
    else if (isAnchor(event)) cancel();
    else defer('move', () => onMove(latest));
  };
  const leave = () => defer('leave', hide);
  const listeners = [
    [target, 'mousemove', move], [target, 'mouseleave', leave], [target, 'mouseenter', move],
    [tooltip, 'mouseenter', cancel], [tooltip, 'mouseleave', leave],
  ];
  for (const [node, event, handler] of listeners) node.addEventListener(event, handler);
  return { cancel, dispose() { cancel(); for (const [node, event, handler] of listeners) node.removeEventListener(event, handler); } };
}
