/**
 * Epoch-aware promotion tracker shared by the bootstrap and baseline-gate
 * plugins of the anchored presets.
 *
 * A compaction rewrites the model-visible surface: the pre-compaction
 * conversation collapses into one synthetic summary message, and the
 * workspace-instruction baseline is re-injected from scratch. The first
 * post-compaction request is therefore a "second first request" — the same
 * first-token conditions the anchored presets exist to control. Promotion is
 * epoch-aware: only a durable promotion signal (`tool/call` and/or
 * `assistant/message`, per the caller's `promoteEvents`) recorded AFTER the
 * last `compaction/end` boundary counts as promoted. Before any compaction
 * the boundary is -1, which preserves the original one-shot semantics.
 *
 * By default subagents (`delegationDepth > 0`) are treated as already
 * promoted so their first request can use tools. Set `includeSubagents: true`
 * to make subagents follow the same bootstrap/anchor phase as top-level
 * sessions.
 *
 * ── Why this reads a Session projection ────────────────────────────────────
 * This module used to read `session.events`, a synchronous getter that DSH
 * removed in 0.1.7 (the last release carrying `get events()` is 0.1.1-rc.2).
 * DSH also deprecated the replacement synchronous readers — `eventAt()`,
 * `snapshotEvents()`, `ownEvents()` — and the Agent Note
 * `2026-09-09-deprecate-synchronous-session-event-reads.md` prohibits new
 * production calls to them AND prohibits new aliases/wrappers exposing the
 * same synchronous historical access. The sanctioned migration is to fold the
 * state a consumer needs into a Session projection and read that projection:
 * the registry drives registered units eagerly over committed events, so
 * `stateOf(session, key)` is O(1) and needs no log scan.
 *
 * The durable event sequence this unit folds is tiny and bounded by the number
 * of compactions, so the eager fold is cheap.
 */

/**
 * Projection key prefix carrying the promotion phase. Host-only: no `wire`
 * block, so nothing is published to clients.
 *
 * The same unit also records whether this session already received the
 * instruction hint. Folding it here keeps the "has the hint fired" question
 * answerable from projected state instead of a synchronous history scan, which
 * the deprecation note prohibits.
 */
export const EPOCH_PROJECTION_KEY_PREFIX = 'liangshen-epoch'

/**
 * Derive the projection key for one promote-event set.
 *
 * Keys must be stable across processes (the projection cache persists rows
 * keyed by them) and distinct per fold semantics. The suffix is the sorted
 * promote-event list, so `['tool/call']` and `['tool/call','assistant/message']`
 * get different cells.
 *
 * @param promoteEvents - the promote-event list for this unit.
 * @returns the projection key.
 */
export function epochProjectionKey(promoteEvents) {
  const suffix = [...new Set(promoteEvents)].sort().map((type) => type.replace('/', '-')).join('+')
  return `${EPOCH_PROJECTION_KEY_PREFIX}:${suffix}`
}

/**
 * Create the projection unit definition for one promote-event set.
 *
 * The key is derived from the promote-event set, NOT a single shared constant.
 * Two plugins in the same preset (`tool-bootstrap` and `instruction-hint`) each
 * build a tracker, and their `promoteOn` configs are independent — one may be
 * `tool-call` while the other is `either`. The registry stores one cell per
 * key, so a shared key would let the last `register()` silently dictate the
 * fold semantics of both, giving the other plugin a `promoted` answer it never
 * asked for. Deriving the key per semantics keeps the units independent and
 * makes a genuine disagreement impossible instead of merely unlikely.
 *
 * @param promoteEvents - durable event types that count as a promotion signal.
 * @returns a `ProjectionDefinition`-shaped object for the registry.
 */
export function createEpochProjection(promoteEvents) {
  const promote = new Set(promoteEvents)
  const key = epochProjectionKey(promoteEvents)
  return {
    key,
    // Plain JSON state: `{ boundary, promoted, hinted }`.
    stateSchema: {
      parse(value) {
        const boundary = value?.boundary
        const promoted = value?.promoted
        if (!Number.isSafeInteger(boundary) || boundary < -1 || typeof promoted !== 'boolean') {
          throw new TypeError(`${key}: invalid persisted state ${JSON.stringify(value)}`)
        }
        return { boundary, promoted, hinted: value.hinted === true }
      },
    },
    stateVersion: 1,
    /** An empty log has no boundary, is not promoted, and has no hint yet. */
    init: () => ({ boundary: -1, promoted: false, hinted: false }),
    /** Fold one committed event into the phase state. */
    apply(state, event) {
      const seq = event.seq ?? 0
      // The hint injection is itself a durable event, so resume reconstructs it.
      if (event.type === 'user/message' && event.data?.source?.kind === 'instruction-hint') {
        return state.hinted ? state : { ...state, hinted: true }
      }
      if (event.type === 'compaction/end') {
        // A compaction opens a new epoch: everything before it stops counting.
        // `hinted` is deliberately NOT reset — the hint fires once per session.
        return { boundary: seq, promoted: false, hinted: state.hinted }
      }
      if (promote.has(event.type) && seq > state.boundary && !state.promoted) {
        return { ...state, promoted: true }
      }
      // Unrelated event: same reference => zero downstream work.
      return state
    },
  }
}

/**
 * Build one epoch-aware promotion tracker backed by the Session projection
 * registry.
 *
 * @param ctx - the plugin context; `sessionProjections` must be reachable
 *   through `ctx.get('sessionProjections')`.
 * @param promoteEvents - durable event types that count as a promotion signal.
 * @param options - `{ includeSubagents }`.
 * @returns `{ status(agent), dispose() }`.
 */
export function createEpochPromotion(ctx, promoteEvents, options = {}) {
  const includeSubagents = options.includeSubagents === true
  const projection = createEpochProjection(promoteEvents)
  const key = projection.key

  /** The registry, once `ctx.inject` has attached it. */
  let registry
  let settle
  const ready = new Promise((resolve) => { settle = resolve })

  ctx.inject(['sessionProjections'], (scope) => {
    const service = scope.get('sessionProjections')
    if (service === undefined) {
      throw new TypeError(
        `${key}: the sessionProjections registry is required (it is mounted by dsh-base); `
        + 'refusing to fall back to scanning Session history synchronously',
      )
    }
    registry = service
    // The registration is an effect on `scope`'s fiber, so it is disposed with
    // it; no manual disposer is needed here.
    service.register(projection)
    settle()
  })

  /** Folded state for one agent's session, or undefined before attach. */
  const stateOf = (agent) => {
    const session = agent?.session
    if (session === undefined || registry === undefined) return undefined
    return registry.stateOf(session, key)
  }

  return {
    /**
     * Current phase of the agent's session.
     * @param agent - the assembly/pre-step agent, or undefined outside an agent.
     * @returns { boundary, promoted, hinted } — `boundary` is the last
     *   compaction/end seq (-1 before any compaction); `promoted` is true when a
     *   durable promotion signal exists after that boundary.
     */
    status(agent) {
      if (agent === undefined || agent.session === undefined) {
        return { boundary: -1, promoted: true, hinted: false }
      }
      // By default subagents keep the full catalog from their very first
      // request; includeSubagents makes them follow the normal bootstrap phase.
      if (!includeSubagents && (agent.session.header?.delegationDepth ?? 0) > 0) {
        return { boundary: -1, promoted: true, hinted: false }
      }
      return stateOf(agent) ?? { boundary: -1, promoted: false, hinted: false }
    },
    /**
     * Whether this session's log already records an instruction hint.
     *
     * Read from projected state, so resume is handled without a history scan.
     * @param agent - the pre-step agent.
     * @returns true when the durable hint event exists.
     */
    hinted(agent) {
      return stateOf(agent)?.hinted === true
    },
    /** Resolves once the projection unit is registered. */
    ready: () => ready,
  }
}
