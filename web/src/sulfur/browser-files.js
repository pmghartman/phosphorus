// Browser files have no host path. Keep their contents local and save only in
// response to Save, using a file picker where supported or a downloaded copy.
export async function readBrowserFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const bom = bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191;
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (source.includes('\0')) throw new Error('This file is binary. Open a UTF-8 text or code file.');
  return { name: file.name, text: source.replace(/\r\n?/g, '\n'), bom, eol: source.includes('\r\n') ? '\r\n' : '\n', handle: null };
}

export function browserFileText(file, text) {
  return (file.bom ? '\ufeff' : '') + text.replace(/\r\n?/g, '\n').replace(/\n/g, file.eol);
}

export async function saveBrowserFile(file, text, browser = window) {
  if (!file.handle && browser.showSaveFilePicker) file.handle = await browser.showSaveFilePicker({ suggestedName: file.name });
  const source = browserFileText(file, text);
  if (file.handle) {
    const writer = await file.handle.createWritable();
    try { await writer.write(source); await writer.close(); }
    catch (error) { await writer.abort?.().catch(() => {}); throw error; }
    return;
  }
  const url = URL.createObjectURL(new Blob([source], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = file.name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
