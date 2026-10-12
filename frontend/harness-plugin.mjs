// loaded by opencode: each call to phos's mcp tools carrying its session, so
// a button pressed reaches the person who asked, and each mesh model call too,
// so phos's model proxy knows the role asking; a project's shell, file and
// search calls checked by phos first, its shell run in the project's sandbox
import fs from 'node:fs';
import path from 'node:path';

// call id -> the file a write is making, opened in a tab for the asker once made
const making = new Map();
// call id -> a todowrite's list, the project's task list once written
const listing = new Map();
const GUARDED = new Set(['bash', 'read', 'write', 'edit', 'multiedit', 'patch', 'apply_patch', 'list', 'glob', 'grep', 'webfetch']);

async function rpc(method, params) {
  if (!process.env.PHOS_MCP_URL) throw new Error('phos is out of reach');
  const r = await fetch(process.env.PHOS_MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result || {};
}

export default {
  id: 'phos',
  // dir: the instance's own, a project's workspace or the files share
  server: async (ctx) => {
    const dir = (ctx && ctx.directory) || '';
    return {
      'tool.execute.before': async (input, output) => {
        const args = output.args && typeof output.args === 'object' ? output.args : null;
        if (!args) return;
        if (input.tool.startsWith('phos_')) { args._ask = input.sessionID; args._dir = dir; }
        // unreachable or refused: thrown, the tool never run
        if (GUARDED.has(input.tool)) {
          const r = await rpc('phos/tool', { _ask: input.sessionID, _dir: dir, tool: input.tool, args });
          Object.assign(args, r.set || {});
          for (const k of r.unset || []) delete args[k];
        }
        if (input.tool === 'write' && typeof args.filePath === 'string') {
          const file = path.resolve(dir || '.', args.filePath);
          if (!fs.existsSync(file)) making.set(input.callID, file);
        }
        if (input.tool === 'todowrite' && Array.isArray(args.todos)) listing.set(input.callID, args.todos);
      },
      'tool.execute.after': async (input) => {
        const todos = listing.get(input.callID);
        if (todos) {
          listing.delete(input.callID);
          await rpc('phos/todos', { _ask: input.sessionID, _dir: dir, todos }).catch(() => {});
        }
        const file = making.get(input.callID);
        if (!file) return;
        making.delete(input.callID);
        if (!fs.existsSync(file)) return;
        await rpc('phos/created', { path: file, _ask: input.sessionID, _dir: dir }).catch(() => {});
      },
      'chat.headers': async (input, output) => {
        if (input.model && input.model.providerID === 'phos') output.headers['x-phos-ask'] = input.sessionID;
      },
    };
  },
};
