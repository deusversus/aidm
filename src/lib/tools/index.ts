import "./all"; // side-effect: register every tool in the flat registry

export { buildMcpServers, LAYER_TO_MCP_ID } from "./mcp-servers";
export {
  authorizeCampaignAccess,
  clearRegistryForTesting,
  getTool,
  invokeTool,
  listTools,
  listToolsByLayer,
  registerTool,
} from "./registry";
export {
  AidmAuthError,
  type AidmSpanHandle,
  type AidmToolContext,
  type AidmToolLayer,
  type AidmToolSpec,
} from "./types";
