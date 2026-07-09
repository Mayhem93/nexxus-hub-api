/**
 * A single registered Nexxus node, as held in Hub's in-memory registry.
 *
 * Populated verbatim from a `POST /node` payload, plus a Hub-set
 * `registeredAt` timestamp. `stats` is a snapshot captured at registration
 * time — it is NOT refreshed, so dynamic fields (uptime, loadedApps) drift as
 * the node keeps running. Consumers needing live values pull from the node's
 * own management server.
 */
export interface NodeRecord {
  id: string;
  role: string;
  privateIpAddress: string;
  managementPort?: number;
  dependencies: Record<string, string>;
  stats: Record<string, unknown>;
  registeredAt: number;
}

/**
 * Hub's v1 node registry: a plain in-memory `Map<nodeId, NodeRecord>`.
 *
 * No persistence, no heartbeats, no liveness tracking — a Hub restart wipes
 * it, and entries only leave via an explicit de-register (`DELETE /node/:id`).
 * All operations are idempotent, matching the design's HTTP contract.
 */
export class NodeRegistry {
  private readonly nodes: Map<string, NodeRecord> = new Map();

  /**
   * Register (or re-register) a node. Keyed by `nodeId` — a second call with
   * the same id overwrites the previous record. `registeredAt` is preserved
   * across re-registration of an existing id so it reflects first-seen time.
   */
  public upsert(node: Omit<NodeRecord, 'registeredAt'>, now: number): NodeRecord {
    const existing = this.nodes.get(node.id);
    const record: NodeRecord = {
      ...node,
      registeredAt: existing?.registeredAt ?? now,
    };

    this.nodes.set(node.id, record);

    return record;
  }

  /**
   * De-register a node. Returns whether an entry actually existed — the caller
   * responds 204 either way (the HTTP contract is idempotent).
   */
  public remove(nodeId: string): boolean {
    return this.nodes.delete(nodeId);
  }

  /**
   * Replace a node's `stats` snapshot in place, leaving every other field
   * (including `registeredAt`) untouched. Used by the periodic refresh that
   * re-pulls each node's `getStats()`. No-op returning `false` if the node
   * isn't registered (it may have de-registered between poll scheduling and
   * this call).
   */
  public updateStats(nodeId: string, stats: Record<string, unknown>): boolean {
    const record = this.nodes.get(nodeId);

    if (!record) {
      return false;
    }

    record.stats = stats;

    return true;
  }

  /**
   * List registered nodes, optionally filtered by role. No "dead" filtering
   * because there is no "dead" status in v1.
   */
  public list(role?: string): NodeRecord[] {
    const all = Array.from(this.nodes.values());

    return role === undefined ? all : all.filter((node) => node.role === role);
  }

  /** Current number of registered nodes. */
  public get size(): number {
    return this.nodes.size;
  }
}
