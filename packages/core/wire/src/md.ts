// --- /api/md: a document's top-level blocks

export interface MdBlock {
  from: number;
  raw: string;
  html: string | null;
}
