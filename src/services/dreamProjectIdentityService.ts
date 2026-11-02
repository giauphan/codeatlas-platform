import { authStorage } from "../utils/context.js";
import { DreamProjectIdentityRepository } from "./dreamProjectIdentityRepository.js";
import { DreamProjectIdentityUseCase } from "./dreamProjectIdentityUseCase.js";
import type { DreamProjectIdentityInput, DreamProjectIdentityResult } from "./dreamProjectIdentityUseCase.js";

export type { DreamProjectIdentityInput, DreamProjectIdentityResult } from "./dreamProjectIdentityUseCase.js";

/** Existing static entry point and composition root for project identity. */
export class DreamProjectIdentityService {
  static async register(input: DreamProjectIdentityInput): Promise<DreamProjectIdentityResult> {
    const tenantId = authStorage.getStore()?.uid;
    if (!tenantId) throw new Error("Auth context required to register project identity");
    return new DreamProjectIdentityUseCase(() => new DreamProjectIdentityRepository()).register(tenantId, input);
  }

  static async getAliases(projectId: string): Promise<string[]> {
    const tenantId = authStorage.getStore()?.uid;
    if (!tenantId) throw new Error("Auth context required to read project aliases");
    return new DreamProjectIdentityUseCase(() => new DreamProjectIdentityRepository()).getAliases(tenantId, projectId);
  }
}
