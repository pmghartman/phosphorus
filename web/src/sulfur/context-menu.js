// Let the most specific panel/row handle the event, preserving native text-field
// menus. The keyboard path also works on browsers without a contextmenu event.
export function bindContextMenu(node, items, show, { nativeInputs = true } = {}) {
  const open = (event, keyboard = false) => {
    if (event.defaultPrevented || (nativeInputs && event.target.closest('input, textarea, select, [contenteditable="true"]'))) return;
    const list = items(event);
    if (!list?.length) return;
    event.preventDefault();
    event.stopPropagation();
    const target = keyboard ? event.target.getBoundingClientRect() : null;
    show(keyboard ? { x: target.left, y: target.bottom } : { x: event.clientX, y: event.clientY }, list, { focusFirst: keyboard });
  };
  node.addEventListener('contextmenu', open);
  node.addEventListener('keydown', (event) => {
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) open(event, true);
  });
}
