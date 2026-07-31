/**
 * A2A Protocol Type Definitions
 * Implements Google Agent-to-Agent (A2A) spec v0.3
 * https://a2a-protocol.org/v0.3.0/specification/
 */

/** Agent Card — served at /.well-known/agent-card.json */
export interface AgentCard {
  name: string;
  description: string;
  protocolVersion: string;
  version: string;
  url: string;
  skills: AgentSkill[];
  capabilities: AgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  additionalInterfaces?: AgentInterface[];
  authentication?: AuthenticationInfo;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentCapabilities {
  pushNotifications: boolean;
  streaming?: boolean;
  stateTransitionHistory?: boolean;
}

export interface AgentInterface {
  url: string;
  transport: 'JSONRPC' | 'HTTP+JSON' | 'GRPC';
}

export interface AuthenticationInfo {
  schemes: string[];
}

/** JSON-RPC 2.0 Message */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id: string | number;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: JsonRpcError;
  id: string | number | null;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** A2A Task Model */
export type TaskState = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled' | 'input-required';

export interface TaskStatus {
  state: TaskState;
  timestamp: string;
  message?: Message;
}

export interface Artifact {
  artifactId: string;
  name: string;
  parts: Part[];
}

export interface Task {
  kind: 'task';
  id: string;
  contextId?: string;
  status: TaskStatus;
  history: Message[];
  artifacts?: Artifact[];
}

/** A2A Message Model */
export interface Message {
  kind: 'message';
  messageId: string;
  role: 'user' | 'agent';
  parts: Part[];
  contextId?: string;
  taskId?: string;
}

export type Part = TextPart | FilePart | DataPart;

export interface TextPart {
  kind: 'text';
  text: string;
}

export interface FilePart {
  kind: 'file';
  file: {
    name: string;
    mimeType: string;
    uri?: string;
    bytes?: string;  // base64
  };
}

export interface DataPart {
  kind: 'data';
  data: Record<string, unknown>;
}

/** A2A Event types for task lifecycle */
export type A2AEvent = 
  | { kind: 'task'; id: string; contextId?: string; status: TaskStatus; history: Message[] }
  | { kind: 'status-update'; taskId: string; contextId?: string; status: TaskStatus; final: boolean }
  | { kind: 'artifact-update'; taskId: string; contextId?: string; artifact: Artifact }
  | { kind: 'message'; messageId: string; role: 'agent'; parts: Part[]; contextId?: string; taskId?: string };

/** Tool metadata — bridges MCP ↔ A2A */
export interface MCPToolMeta {
  name: string;
  description: string;
  /** Zod schema keys (for input mode detection) */
  params: string[];
}

/**
 * A2A Orchestration Task State Machine
 * Flow: created → assigned → implemented → fixes_needed → approved
 *
 * created:      Leader created task, not yet assigned
 * assigned:     Leader assigned task to a Developer Agent
 * implemented:  Developer Agent completed implementation, ready for review
 * fixes_needed: Leader requested fixes with feedback, back to Developer
 * approved:     Leader approved final implementation
 */
export type OrchestrationState =
  | 'created'
  | 'assigned'
  | 'implemented'
  | 'fixes_needed'
  | 'approved';

/** A2A Orchestration Task — managed by Leader/Developer workflow */
export interface A2AOrchestrationTask {
  orchestrationTaskId: string;
  tenantId: string;
  leaderAgentId: string;
  developerAgentId?: string;
  state: OrchestrationState;
  description: string;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  artifacts?: Artifact[];
  feedback?: string;
  prUrl?: string;
  reviewBotFindings?: string;
  createdAt: string;
  updatedAt: string;
  stateHistory: { state: OrchestrationState; timestamp: string; note?: string }[];
}
