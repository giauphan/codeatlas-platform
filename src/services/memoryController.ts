/**
 * Memory Controller - Auto/Manual Memory Loading System
 * 
 * Provides centralized control over CodeAtlas memory loading:
 * - Auto-load on startup (default behavior)
 * - Manual load via API calls
 * - Memory sync status monitoring
 * - Graceful fallback handling
 */

import { logger } from "../utils/logger.js";
import { DreamingService } from "./dreamingService.js";
import { MemoryService } from "./memoryService.js";
import { loadAnalysisAsync } from "./projectService.js";
import { authStorage } from "../utils/context.js";
import type { AuthContext } from "../utils/context.js";

// Startup and background jobs run outside request middleware, so tenant-scoped
// writes need an explicit system identity to pass tenantId() checks.
const SYSTEM_AUTH_CONTEXT: AuthContext = {
  tier: "admin",
  uid: "_system",
  keyId: "_system",
  role: "system"
};

function withSystemAuth<T>(fn: () => Promise<T>): Promise<T> {
  return authStorage.getStore()?.uid
    ? fn()
    : authStorage.run(SYSTEM_AUTH_CONTEXT, fn);
}

// Memory system state
export interface MemorySystemStatus {
  dreamMemory: boolean;
  semanticMemory: boolean; 
  episodicMemory: boolean;
  autoLoadEnabled: boolean;
  lastSync: Date | null;
  syncCount: number;
  error: string | null;
}

// Global memory system state
const memoryState: MemorySystemStatus = {
  dreamMemory: false,
  semanticMemory: false,
  episodicMemory: false,
  autoLoadEnabled: true,
  lastSync: null,
  syncCount: 0,
  error: null
};

/**
 * Memory Controller - Central memory system management
 */
export class MemoryController {
  
  /**
   * Initialize memory system - runs on application startup
   * This is the AUTO-LOAD functionality
   */
  static async autoInitialize(): Promise<void> {
    if (!memoryState.autoLoadEnabled) {
      logger.info("[MemoryController] Auto-load disabled. Use manual load methods.");
      return;
    }
    
    logger.info("[MemoryController] Auto-initializing memory systems...");
    
    try {
      // Initialize Dream/Memory tables
      await DreamingService.initialize();
      memoryState.dreamMemory = true;
      memoryState.lastSync = new Date();
      memoryState.syncCount++;
      
      logger.info("[MemoryController] ✅ Dream Memory initialized");
      
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("[MemoryController] ❌ Dream Memory initialization failed:", errorMsg);
      memoryState.error = errorMsg;
      memoryState.dreamMemory = false;
    }
    
    try {
      // Semantic/Entity Memory - just flag as initialized
      // MemoryService doesn't need explicit initialization
      memoryState.semanticMemory = true;
      logger.info("[MemoryController] ✅ Semantic Memory initialized");
      
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("[MemoryController] ❌ Semantic Memory initialization failed:", errorMsg);
      memoryState.error = errorMsg;
      memoryState.semanticMemory = false;
    }
    
    try {
      // Episodic Memory (business rules, change logs)
      await withSystemAuth(() => MemoryService.saveEpisodicMemory("_system", "BUSINESS_RULE", {
        rule: "Memory system auto-loaded on startup",
        timestamp: new Date().toISOString(),
        type: "system_initialization"
      }));
      memoryState.episodicMemory = true;
      logger.info("[MemoryController] ✅ Episodic Memory initialized");

    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn("[MemoryController] ⚠️  Episodic Memory initialization failed:", errorMsg);
      memoryState.error = errorMsg;
      memoryState.episodicMemory = false;
    }

    // Final status check
    const allInitialized = memoryState.dreamMemory &&
                          memoryState.semanticMemory &&
                          memoryState.episodicMemory &&
                          !memoryState.error;

    if (allInitialized) {
      logger.info("[MemoryController] 🎉 All memory systems auto-initialized successfully");
    } else {
      logger.warn("[MemoryController] ⚠️  Some memory systems failed to initialize");
    }
  }
  
  /**
   * Manual memory system initialization/load
   * Use this when you want to explicitly load memory systems
   */
  static async manualInitialize(project?: string): Promise<MemorySystemStatus> {
    logger.info(`[MemoryController] Manual memory initialization requested${project ? ` for project: ${project}` : ''}`);
    
    try {
      if (project) {
        // Project-specific manual load
        const analysis = await loadAnalysisAsync(project);
        if (analysis) {
          logger.info(`[MemoryController] Loaded analysis for project: ${analysis.projectName}`);
        }
      }
      
      // Ensure all memory systems are initialized
      await this.autoInitialize();
      
      memoryState.lastSync = new Date();
      memoryState.syncCount++;
      memoryState.error = null;
      
      return { ...memoryState };
      
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("[MemoryController] Manual initialization failed:", errorMsg);
      memoryState.error = errorMsg;
      return { ...memoryState, error: errorMsg };
    }
  }
  
  /**
   * Sync memory for specific project (manual sync)
   */
  static async syncProjectMemory(project: string, changeDescription?: string, businessRule?: string): Promise<{
    success: boolean;
    message: string;
    project: string;
    timestamp: Date;
  }> {
    logger.info(`[MemoryController] Manual sync requested for project: ${project}`);
    
    try {
        if (businessRule) {
          await withSystemAuth(() => MemoryService.saveEpisodicMemory(project, "BUSINESS_RULE", {
            rule: businessRule,
            timestamp: new Date().toISOString(),
            type: "manual_sync"
          }));
        }

        if (changeDescription) {
          await withSystemAuth(() => MemoryService.saveEpisodicMemory(project, "CHANGE_LOG", {
            description: changeDescription,
            timestamp: new Date().toISOString(),
            type: "manual_sync"
          }));
        }

      // Update state
      memoryState.lastSync = new Date();
      memoryState.syncCount++;
      memoryState.error = null;

      return {
        success: true,
        message: `Memory synchronized for project: ${project}`,
        project,
        timestamp: memoryState.lastSync
      };
      
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      memoryState.error = errorMsg;
      return {
        success: false,
        message: `Memory sync failed for project: ${project}. Error: ${errorMsg}`,
        project,
        timestamp: new Date()
      };
    }
  }
  
  /**
   * Get current memory system status
   */
  static getStatus(): MemorySystemStatus {
    return { ...memoryState };
  }
  
  /**
   * Enable or disable auto memory loading
   */
  static setAutoLoad(enabled: boolean): void {
    memoryState.autoLoadEnabled = enabled;
    logger.info(`[MemoryController] Auto-load ${enabled ? 'enabled' : 'disabled'}`);
  }
  
  /**
   * Reset memory system (clear errors, reset counts)
   */
  static reset(): void {
    memoryState.error = null;
    memoryState.lastSync = null;
    memoryState.syncCount = 0;
    logger.info("[MemoryController] Memory system state reset");
  }
  
  /**
   * Force reload all memory systems
   */
  static async reload(): Promise<MemorySystemStatus> {
    logger.info("[MemoryController] Force reloading all memory systems...");
    memoryState.syncCount = 0;
    memoryState.error = null;
    
    return this.manualInitialize();
  }
  
  /**
   * Check if memory system is healthy
   */
  static isHealthy(): boolean {
    return memoryState.dreamMemory &&
           memoryState.semanticMemory &&
           memoryState.episodicMemory &&
           !memoryState.error;
  }
}

// Auto-initialize on module import (AUTO-LOAD)
// This ensures memory loads when the application starts
if (process.env.MEMORY_AUTO_LOAD !== 'false') {
  Promise.resolve().then(() => {
    // Delay slightly to allow logger to be ready
    setTimeout(() => {
      MemoryController.autoInitialize().catch(error => {
        logger.error("[MemoryController] Auto-initialization failed:", error);
      });
    }, 100);
  });
}

// Manual memory loading functions (for external use)
export function loadMemoryManually(project?: string) {
  return MemoryController.manualInitialize(project);
}

export function getMemoryStatus() {
  return MemoryController.getStatus();
}

export function syncMemory(project: string, changeDescription?: string, businessRule?: string) {
  return MemoryController.syncProjectMemory(project, changeDescription, businessRule);
}

export function disableMemoryAutoLoad() {
  MemoryController.setAutoLoad(false);
}

export function enableMemoryAutoLoad() {
  MemoryController.setAutoLoad(true);
}

export function resetMemory() {
  MemoryController.reset();
}

export function reloadMemory() {
  return MemoryController.reload();
}

export { memoryState as getMemoryState };