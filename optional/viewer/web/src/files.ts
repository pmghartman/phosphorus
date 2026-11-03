// the file the page shows, read and saved through the core's file api as whoever
// is logged in to the desktop

// a file: the host whose share holds it ("home" the synced one), its path there
export type At = { host: string; share: string; path: string };

export const nameOf = (path: string) => path.split("/").pop() || path;

export const fileApi = (at: At, op: string, params: Record<string, string> = {}) =>
  `/api/files/${encodeURIComponent(at.host)}/${op}?${new URLSearchParams({ share: at.share || "0", ...params })}`;

// its bytes as the browser shows them, or as a download
export const fileSrc = (at: At, inline: boolean) =>
  fileApi(at, "download", inline ? { path: at.path, inline: "1" } : { path: at.path });

export type Read = { text?: string; binary?: boolean; tooBig?: boolean; size?: number };

async function call(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("log in to phosphorus first");
  if (!res.ok) throw new Error(body.error || `status ${res.status}`);
  return body;
}

// as text: binary or over 16MB marked, not sent
export const readText = (at: At): Promise<Read> => call(fileApi(at, "read", { path: at.path }));

export const saveText = (at: At, text: string): Promise<unknown> =>
  call(fileApi(at, "save"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: at.path, text }),
  });

const KINDS: Record<string, string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"],
  video: ["mp4", "m4v", "webm", "mkv", "mov", "ogv"],
  audio: ["mp3", "wav", "flac", "ogg", "oga", "m4a", "opus", "aac"],
  pdf: ["pdf"],
};

// how it's shown: by its extension, anything else as text
export function kindOf(path: string): string {
  const n = nameOf(path);
  const x = n.includes(".") ? n.split(".").pop()!.toLowerCase() : "";
  for (const k in KINDS) if (KINDS[k]!.includes(x)) return k;
  return "text";
}
