import { tierForAgentName } from "../../domain/model/tier-policy.js";
import type { ModelPolicy, ResolvedModelRouting, DispatchTarget } from "../../application/port/index.js";
import type { ProfileConfig } from "../config/model-config.js";

/**
 * ModelPolicy backed by a resolved profile from .deeplooper/models.json.
 *
 * Resolution rules:
 *   1. generic-coding targets are always assigned to the "coding" tier.
 *   2. Leaf agents are mapped via AGENT_TIERS (unknown names fall back to "utility").
 *   3. The tier binding from the active profile supplies modelName + thinkingLevel.
 *   4. If the binding is absent or missing a field, that field is undefined,
 *      which causes PiSessionDispatcher to fall back to the pi default model /
 *      the target's own thinkingLevel respectively.
 */
export class ConfiguredModelPolicy implements ModelPolicy {
  constructor(private readonly profile: ProfileConfig) {}

  resolve(target: DispatchTarget): ResolvedModelRouting {
    const tier = target.kind === "generic" ? "coding" : tierForAgentName(target.name);
    const binding = this.profile[tier];
    const routing: ResolvedModelRouting = {};
    if (binding?.model) {
      routing.modelName = binding.model;
    }
    if (binding?.thinking) {
      routing.thinkingLevel = binding.thinking;
    }
    return routing;
  }
}
