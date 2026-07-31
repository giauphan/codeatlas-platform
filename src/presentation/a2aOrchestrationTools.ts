import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkAuth, logActivity } from "../services/authService.js";
import { logger } from "../utils/logger.js";
import { registerTool } from "./a2a/agentCard.js";
import { a2aOrchestrationService } from "../services/a2aOrchestrationService.js";
import { a2aExecutor } from "./a2a/a2aExecutor.js";
import type { Artifact, OrchestrationState } from "../types/a2a.js";

/** Auto-register tool metadata for A2A Agent Card AND register handler on executor */
function registerA2AOrch(name: string, description: string, params: string[], handler: (params: Record<string, unknown>) => Promise<unknown>) {
  registerTool({ name, description, params });
  a2aExecutor.registerToolHandler(name, handler);
}

// Module-level handlers (registered on a2aExecutor at load time)
const createHandler = async ({ description, developer_agent_id, tool_name, tool_params }: any) => {
  const auth = await checkAuth();
  await logActivity(auth, "a2a_create_orchestration_task", { description, developer_agent_id });
  const task = await a2aOrchestrationService.createTask(auth.uid, description, developer_agent_id, tool_name, tool_params);
  return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
};

const assignHandler = async ({ orchestration_task_id, developer_agent_id }: any) => {
  const auth = await checkAuth();
  await logActivity(auth, "a2a_assign_orchestration_task", { orchestration_task_id, developer_agent_id });
  const task = await a2aOrchestrationService.assignTask(orchestration_task_id, developer_agent_id);
  return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
};

const implementHandler = async ({ orchestration_task_id, implementation_artifacts }: any) => {
  const auth = await checkAuth();
  await logActivity(auth, "a2a_implement_orchestration_task", { orchestration_task_id });
  const task = await a2aOrchestrationService.getTask(orchestration_task_id);
  if (!task || (task.developerAgentId !== auth.uid && auth.uid !== 'admin')) throw new Error("Unauthorized to implement this task or task not found.");
  const updatedTask = await a2aOrchestrationService.updateTaskState(orchestration_task_id, 'implemented', { artifacts: implementation_artifacts as Artifact[] });
  return { content: [{ type: "text" as const, text: JSON.stringify(updatedTask, null, 2) }] };
};

const reviewHandler = async ({ orchestration_task_id, approved, feedback }: any) => {
  const auth = await checkAuth();
  await logActivity(auth, "a2a_review_orchestration_task", { orchestration_task_id, approved });
  const task = await a2aOrchestrationService.getTask(orchestration_task_id);
  if (!task || task.leaderAgentId !== auth.uid) throw new Error("Unauthorized to review this task or task not found.");
  const newState: OrchestrationState = approved ? 'approved' : 'fixes_needed';
  const updatedTask = await a2aOrchestrationService.updateTaskState(orchestration_task_id, newState, { feedback });
  return { content: [{ type: "text" as const, text: JSON.stringify(updatedTask, null, 2) }] };
};

const submitFixesHandler = async ({ orchestration_task_id, new_artifacts }: any) => {
  const auth = await checkAuth();
  await logActivity(auth, "a2a_submit_fixes_orchestration_task", { orchestration_task_id });
  const task = await a2aOrchestrationService.getTask(orchestration_task_id);
  if (!task || (task.developerAgentId !== auth.uid && auth.uid !== 'admin')) throw new Error("Unauthorized to submit fixes for this task or task not found.");
  if (task.state !== 'fixes_needed') throw new Error(`Task ${orchestration_task_id} is not in 'fixes_needed' state.`);
  const updatedTask = await a2aOrchestrationService.updateTaskState(orchestration_task_id, 'implemented', { artifacts: new_artifacts as Artifact[], feedback: null });
  return { content: [{ type: "text" as const, text: JSON.stringify(updatedTask, null, 2) }] };
};

const getTaskHandler = async ({ orchestration_task_id }: any) => {
  const auth = await checkAuth();
  await logActivity(auth, "a2a_get_orchestration_task", { orchestration_task_id });
  const task = await a2aOrchestrationService.getTask(orchestration_task_id);
  if (!task) throw new Error("Task not found or unauthorized to access.");
  return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
};

export function registerA2AOrchestrationTools(server: McpServer): void {
  // Register MCP server tools (per-session specific)
  server.tool("a2a_create_orchestration_task", "Creates a new A2A orchestration task. The task starts in 'created' state or 'assigned' if a developer is provided.", {
    description: z.string().describe("A brief description of the task."),
    developer_agent_id: z.string().optional().describe("Optional ID of the developer agent to assign the task to immediately."),
    tool_name: z.string().optional().describe("Optional name of the tool the developer agent should execute."),
    tool_params: z.record(z.any()).optional().describe("Optional parameters for the tool."),
  }, createHandler);
  server.tool("a2a_assign_orchestration_task", "Assigns an A2A orchestration task to a developer agent, moving it from 'created' to 'assigned'.", {
    orchestration_task_id: z.string().describe("The ID of the orchestration task."),
    developer_agent_id: z.string().describe("The ID of the developer agent to assign the task to."),
  }, assignHandler);
  server.tool("a2a_implement_orchestration_task", "Developer agent reports completion of a task, moving its state to 'implemented'.", {
    orchestration_task_id: z.string().describe("The ID of the orchestration task."),
    implementation_artifacts: z.array(z.any()).optional().describe("Optional artifacts (e.g., tool outputs, file paths) from the implementation."),
  }, implementHandler);
  server.tool("a2a_review_orchestration_task", "Leader agent reviews an 'implemented' task. Can approve it or request fixes with feedback.", {
    orchestration_task_id: z.string().describe("The ID of the orchestration task."),
    approved: z.boolean().describe("True to approve the task, false to request fixes."),
    feedback: z.string().optional().describe("Optional feedback for the developer if fixes are needed."),
  }, reviewHandler);
  server.tool("a2a_submit_fixes_orchestration_task", "Developer agent submits fixes for a 'fixes_needed' task, moving its state back to 'implemented'.", {
    orchestration_task_id: z.string().describe("The ID of the orchestration task."),
    new_artifacts: z.array(z.any()).optional().describe("Optional new artifacts after applying fixes."),
  }, submitFixesHandler);
  server.tool("a2a_get_orchestration_task", "Retrieves the current status and details of an A2A orchestration task.", {
    orchestration_task_id: z.string().describe("The ID of the orchestration task."),
  }, getTaskHandler);

  logger.info("[A2A Orchestration Tools] Registered 6 new A2A orchestration tools on MCP server.");
}

// Global A2A Orchestration Tool registration (runs at module load time for A2A JSON-RPC endpoint)
registerA2AOrch("a2a_create_orchestration_task", "Creates a new A2A orchestration task.", ["description", "developer_agent_id", "tool_name", "tool_params"], createHandler);
registerA2AOrch("a2a_assign_orchestration_task", "Assigns an A2A orchestration task to a developer agent.", ["orchestration_task_id", "developer_agent_id"], assignHandler);
registerA2AOrch("a2a_implement_orchestration_task", "Developer agent reports completion of a task.", ["orchestration_task_id", "implementation_artifacts"], implementHandler);
registerA2AOrch("a2a_review_orchestration_task", "Leader agent reviews an 'implemented' task.", ["orchestration_task_id", "approved", "feedback"], reviewHandler);
registerA2AOrch("a2a_submit_fixes_orchestration_task", "Developer agent submits fixes for a 'fixes_needed' task.", ["orchestration_task_id", "new_artifacts"], submitFixesHandler);
registerA2AOrch("a2a_get_orchestration_task", "Retrieves the current status and details of an A2A orchestration task.", ["orchestration_task_id"], getTaskHandler);

logger.info("[A2A Orchestration Tools] Registered 6 new A2A orchestration tools on A2A Executor for REST API.");
