import { searchBackendIds, type SearchBackendId } from "../search-backends.js";

/** 来源质量基线：通用搜索高于百科/社区兜底；SearXNG 取决于自托管实例。 */
const qualityWeight: Record<SearchBackendId, number> = {
  tavily: 1,
  exa: 0.95,
  you: 0.9,
  searxng: 0.85,
  wikipedia: 0.7,
  hackernews: 0.65,
  duckduckgo: 0.6,
};

export interface BackendHealth {
  successes: number;
  failures: number;
  latencyMs: number;
  cooldownUntil: number;
}

export interface BackendScore {
  id: SearchBackendId;
  score: number;
  successes: number;
  failures: number;
  latencyMs: number;
  cooldownUntil: number;
}

function newHealth(): Record<SearchBackendId, BackendHealth> {
  return Object.fromEntries(searchBackendIds.map((id) => [id, {
    successes: 0, failures: 0, latencyMs: 0, cooldownUntil: 0,
  }])) as Record<SearchBackendId, BackendHealth>;
}

/** 综合评分：质量基线 × 贝叶斯成功率 × 延迟因子；冷却中的后端直接垫底。 */
export function scoreBackend(id: SearchBackendId, health: BackendHealth, now = Date.now()): number {
  if (health.cooldownUntil > now) return -1;
  const total = health.successes + health.failures;
  const reliability = total === 0 ? 0.8 : (health.successes + 1) / (total + 2);
  const latency = health.latencyMs > 0 ? Math.max(0.4, 1 - health.latencyMs / 10_000) : 1;
  return qualityWeight[id] * reliability * latency;
}

/**
 * 进程内共享的搜索健康状态：所有 Pi session 的搜索客户端都更新同一份，
 * 管理页据此展示每个后端的当前综合评分。
 */
export class SearchHealth {
  private readonly states = newHealth();

  get(id: SearchBackendId): BackendHealth {
    return this.states[id];
  }

  success(id: SearchBackendId, latencyMs: number): void {
    const state = this.states[id];
    state.successes++;
    state.latencyMs = latencyMs;
  }

  failure(id: SearchBackendId, rateLimited: boolean, cooldownMs: number): void {
    const state = this.states[id];
    state.failures++;
    if (rateLimited) state.cooldownUntil = Date.now() + cooldownMs;
  }

  /** 评分从高到低，含冷却状态与原始指标，供管理页展示。 */
  snapshot(ids: readonly SearchBackendId[] = searchBackendIds): BackendScore[] {
    const now = Date.now();
    return ids.map((id) => ({
      id,
      score: scoreBackend(id, this.states[id], now),
      ...this.states[id],
    })).sort((left, right) => right.score - left.score);
  }
}
