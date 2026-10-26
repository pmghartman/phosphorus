// Keep an interactive hover reachable across the text and gap between its symbol
// and popup. Outside that route, wait for the pointer to rest before replacing it.
export function hoverBridgeContains(point, origin, rect) {
  const { x, y } = point;
  const left = rect.left - 6, right = rect.right + 6;
  const top = rect.top - 6, bottom = rect.bottom + 6;
  if (x >= left && x <= right && y >= top && y <= bottom) return true;
  if (Math.abs(x - origin.x) <= 6 && Math.abs(y - origin.y) <= 6) return true;
  const corners = [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
  const cross = (a, b, p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  return corners.some((a, i) => {
    const b = corners[(i + 1) % corners.length];
    if (Math.abs(cross(origin, a, b)) < 0.001) return false;
    const signs = [cross(origin, a, point), cross(a, b, point), cross(b, origin, point)];
    return signs.every((v) => v >= 0) || signs.every((v) => v <= 0);
  });
}

export function mountHoverIntent({ target, tooltip, onMove, hide, delay = 400 }) {
  let timer = 0, origin = null;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  const defer = (fn) => { cancel(); timer = setTimeout(() => { timer = 0; fn(); }, delay); };
  const move = (event) => {
    const point = { x: event.clientX, y: event.clientY };
    if (!tooltip.hidden && origin) {
      if (hoverBridgeContains(point, origin, tooltip.getBoundingClientRect())) { cancel(); return; }
      defer(() => { origin = point; onMove(event); });
    } else { cancel(); origin = point; onMove(event); }
  };
  const leave = () => defer(hide);
  const listeners = [
    [target, 'mousemove', move], [target, 'mouseleave', leave], [target, 'mouseenter', cancel],
    [tooltip, 'mouseenter', cancel], [tooltip, 'mouseleave', leave],
  ];
  for (const [node, event, handler] of listeners) node.addEventListener(event, handler);
  return {
    cancel,
    dispose() { cancel(); for (const [node, event, handler] of listeners) node.removeEventListener(event, handler); },
  };
}
