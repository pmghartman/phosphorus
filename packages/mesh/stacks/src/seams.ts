// the mesh as the runtime sees it, set at Start and swapped in tests
import type { AppDef, StackStatus } from "@phosphorus/wire";

// this host's services.export: [name] set to fields, or dropped with null
export type Publish = (name: string, fields: Record<string, string> | null) => Promise<[number, any]>;

export const seams: {
  // a host's tailnet IPv4, "" when unknown
  ipOf: (host: string) => string | Promise<string>;
  publish: Publish;
  // the phosphorus hosts an app may go on
  hosts: () => string[];
  // an app from its source (@phosphorus/catalog), undefined when it has none by that ref
  defOf?: (source: string, ref: string) => Promise<AppDef | undefined>;
  // tests only: an install's body may carry the whole def, until the catalogue is in
  defInBody: boolean;
  // told when a want was written here, so this host follows at once
  kick: () => void;
  // failover's part of a stack's status here (./ha haStatus): role, gen, lastSync
  haStatus?: (id: string) => Partial<StackStatus> | undefined;
} = {
  ipOf: () => "",
  publish: async () => [503, { error: "the mesh isn't up yet" }],
  hosts: () => [],
  defInBody: false,
  kick: () => {},
};
