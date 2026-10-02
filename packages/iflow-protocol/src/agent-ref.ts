/** A node-scoped local name made unambiguous for network indexes.
 * This is an addressing reference, not proof of identity or authority. Existing
 * signed event IDs remain unchanged; consumers derive this at projection time.
 */
export type AgentRef = `iflow:agent:${string}:${string}`
export interface AgentAddress { nodeId: string; agentId: string }

export function agentRef(nodeId: string, agentId: string): AgentRef {
  if (!nodeId || !agentId) throw new Error('Agent reference requires nodeId and local agentId')
  return `iflow:agent:${encodeURIComponent(nodeId)}:${encodeURIComponent(agentId)}`
}

export function parseAgentRef(value: string): AgentAddress | undefined {
  const match = /^iflow:agent:([^:]+):([^:]+)$/.exec(value)
  if (!match) return undefined
  try {
    const nodeId = decodeURIComponent(match[1]!)
    const agentId = decodeURIComponent(match[2]!)
    if (!nodeId || !agentId || agentRef(nodeId, agentId) !== value) return undefined
    return { nodeId, agentId }
  } catch { return undefined }
}
