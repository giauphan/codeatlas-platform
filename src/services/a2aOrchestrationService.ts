import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import { authStorage } from "../utils/context.js";
import type { A2AOrchestrationTask, OrchestrationState, Artifact } from "../types/a2a.js";

/** In-memory store for A2A Orchestration Tasks */
const orchestrationTaskStore = new Map<string, A2AOrchestrationTask>();

export class A2AOrchestrationService {
  /**
   * Retrieves the tenant ID from the current auth context.
   * Defaults to "admin" if no auth context is found.
   */
  private getTenantId(): string {
    const auth = authStorage.getStore();
    return auth ? auth.uid : "admin";
  }

  /**
   * Creates a new A2A orchestration task.
   * @param leaderAgentId The ID of the agent creating the task.
   * @param description A description of the task.
   * @param developerAgentId Optional ID of the developer agent to assign to.
   * @param toolName Optional name of the tool the developer agent should execute.
   * @param toolParams Optional parameters for the tool.
   * @returns The newly created A2AOrchestrationTask.
   */
  async createTask(
    leaderAgentId: string,
    description: string,
    developerAgentId?: string,
    toolName?: string,
    toolParams?: Record<string, unknown>
  ): Promise<A2AOrchestrationTask> {
    const tenantId = this.getTenantId();
    const orchestrationTaskId = randomUUID();
    const now = new Date().toISOString();

    const initialState: OrchestrationState = developerAgentId ? 'assigned' : 'created';

    const newTask: A2AOrchestrationTask = {
      orchestrationTaskId,
      tenantId,
      leaderAgentId,
      developerAgentId,
      state: initialState,
      description,
      toolName,
      toolParams,
      createdAt: now,
      updatedAt: now,
      stateHistory: [{ state: initialState, timestamp: now, note: `Task ${initialState}` }],
    };

    orchestrationTaskStore.set(orchestrationTaskId, newTask);
    logger.info(`[A2A Orchestration] Task created: ${orchestrationTaskId} for tenant: ${tenantId}, state: ${initialState}`);
    return newTask;
  }

  /**
   * Assigns an orchestration task to a developer agent.
   * Task must be in 'created' state.
   * @param orchestrationTaskId The ID of the task.
   * @param developerAgentId The ID of the developer agent.
   * @returns The updated A2AOrchestrationTask.
   */
  async assignTask(orchestrationTaskId: string, developerAgentId: string): Promise<A2AOrchestrationTask> {
    const task = await this.getTask(orchestrationTaskId);
    if (!task) throw new Error(`Task ${orchestrationTaskId} not found.`);
    if (task.tenantId !== this.getTenantId()) throw new Error("Unauthorized access to task.");
    if (task.state !== 'created') throw new Error(`Task ${orchestrationTaskId} is not in 'created' state.`);

    task.developerAgentId = developerAgentId;
    task.state = 'assigned';
    task.updatedAt = new Date().toISOString();
    task.stateHistory.push({ state: 'assigned', timestamp: task.updatedAt, note: `Assigned to ${developerAgentId}` });

    orchestrationTaskStore.set(orchestrationTaskId, task);
    logger.info(`[A2A Orchestration] Task ${orchestrationTaskId} assigned to ${developerAgentId}`);
    return task;
  }

  /**
   * Updates the state of an orchestration task.
   * @param orchestrationTaskId The ID of the task.
   * @param newState The new state for the task.
   * @param updates Optional object containing fields to update (artifacts, feedback, prUrl, reviewBotFindings).
   * @returns The updated A2AOrchestrationTask.
   */
  async updateTaskState(
    orchestrationTaskId: string,
    newState: OrchestrationState,
    updates?: {
      artifacts?: Artifact[];
      feedback?: string | null;
      prUrl?: string | null;
      reviewBotFindings?: string | null;
    }
  ): Promise<A2AOrchestrationTask> {
    const task = await this.getTask(orchestrationTaskId);
    if (!task) throw new Error(`Task ${orchestrationTaskId} not found.`);
    if (task.tenantId !== this.getTenantId()) throw new Error("Unauthorized access to task.");

    // State transition validation
    if (!A2AOrchestrationService.validateTransition(task.state, newState)) {
      throw new Error(`Invalid state transition from ${task.state} to ${newState}`);
    }

    task.state = newState;
    task.updatedAt = new Date().toISOString();
    task.stateHistory.push({ state: newState, timestamp: task.updatedAt });

    if (updates) {
      if (updates.artifacts !== undefined) task.artifacts = updates.artifacts;
      if (updates.feedback !== undefined) {
         task.feedback = updates.feedback === null ? undefined : updates.feedback;
      }
      if (updates.prUrl !== undefined) {
         task.prUrl = updates.prUrl === null ? undefined : updates.prUrl;
      }
      if (updates.reviewBotFindings !== undefined) {
         task.reviewBotFindings = updates.reviewBotFindings === null ? undefined : updates.reviewBotFindings;
      }
    }

    orchestrationTaskStore.set(orchestrationTaskId, task);
    logger.info(`[A2A Orchestration] Task ${orchestrationTaskId} state updated to: ${newState}`);
    return task;
  }

  /**
   * Retrieves an orchestration task by its ID.
   * @param orchestrationTaskId The ID of the task.
   * @returns The A2AOrchestrationTask, or undefined if not found.
   */
  async getTask(orchestrationTaskId: string): Promise<A2AOrchestrationTask | undefined> {
    const task = orchestrationTaskStore.get(orchestrationTaskId);
    if (task && task.tenantId !== this.getTenantId()) {
      logger.warn(`[A2A Orchestration] Attempted unauthorized access to task ${orchestrationTaskId} by tenant ${this.getTenantId()}`);
      return undefined; // Hide task if tenant doesn't match
    }
    return task;
  }

  /**
   * Lists all orchestration tasks for the current tenant.
   * @returns An array of A2AOrchestrationTask.
   */
  async listTasks(): Promise<A2AOrchestrationTask[]> {
    const tenantId = this.getTenantId();
    return Array.from(orchestrationTaskStore.values()).filter(task => task.tenantId === tenantId);
  }

  // Define valid state transitions
  private static validateTransition(currentState: OrchestrationState, nextState: OrchestrationState): boolean {
    switch (currentState) {
      case 'created':
        return nextState === 'assigned';
      case 'assigned':
        return nextState === 'implemented';
      case 'implemented':
        return nextState === 'fixes_needed' || nextState === 'approved';
      case 'fixes_needed':
        return nextState === 'implemented';
      case 'approved':
        return false; // Terminal state
      default:
        return false;
    }
  }
}

export const a2aOrchestrationService = new A2AOrchestrationService();
