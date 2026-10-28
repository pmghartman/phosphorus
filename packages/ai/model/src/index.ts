// the mesh's models: every host's claim, the agents each is assigned to, chat
// and Anthropic-shaped calls answered here or passed to the host running one

export { anthUsage, chatShaped, foldSystem, gate, keyOf, ServeMessages, ServeModels, Target } from "./messages.ts";
export {
  type Agent,
  AgentByID,
  AgentName,
  Agents,
  Assign,
  EraseSlots,
  // read by tests
  excuse,
  Mesh,
  Purge,
  pick,
  ServeChat,
  State,
  Summary,
  seams,
  textOf,
} from "./model.ts";
