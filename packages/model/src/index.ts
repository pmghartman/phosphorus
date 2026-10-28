// the mesh's models: every host's claim, the agents each is assigned to, chat
// and Anthropic-shaped calls answered here or passed to the host running one
export {
  type Agent,
  AgentByID,
  AgentName,
  Agents,
  Assign,
  EraseSlots,
  Mesh,
  Purge,
  ServeChat,
  State,
  Summary,
  // read by tests
  excuse,
  pick,
  seams,
  textOf,
} from "./model.ts";
export { anthUsage, chatShaped, foldSystem, gate, keyOf, ServeMessages, ServeModels, Target } from "./messages.ts";
