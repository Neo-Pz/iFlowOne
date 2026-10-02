import { describe, expect, it } from 'vitest'
import { ARD_CONTEXT, ARD_NAMESPACE, parseArdSearchRequest, validateArdEntry, isPublicArdUrl, rankArdEntries, isArdSearchResponse } from '../src/ard.js'

const entry = { '@context': ARD_CONTEXT, identifier: 'urn:air:example.com:agents:reviewer', displayName: 'TypeScript reviewer', type: 'application/a2a-agent-card+json', data: {}, capabilities: ['iflow.cap:review'], tags: ['code'], representativeQueries: ['Review TypeScript code', 'Explain a TypeScript error'] }
describe('ARD v0.91 profile', () => {
  it('requires exactly one artifact representation and keeps discovery examples as a warning', () => {
    expect(validateArdEntry(entry).valid).toBe(true)
    expect(validateArdEntry({ ...entry, url: 'https://example.com/card' }).valid).toBe(false)
    const { data, ...withoutArtifact } = entry
    expect(validateArdEntry(withoutArtifact).valid).toBe(false)
    expect(validateArdEntry({ ...entry, representativeQueries: [] })).toMatchObject({ valid: true, warnings: [expect.any(String)] })
  })
  it('rejects malformed queries, unknown request fields and unbounded pagination', () => {
    for (const body of [{ query: 'review' }, { query: { text: '' } }, { query: { text: 'review' }, pageSize: 101 }, { query: { text: 'review' }, pageSize: 0 }, { query: { text: 'review' }, endpoint: 'https://elsewhere' }]) expect(() => parseArdSearchRequest(body)).toThrow()
    expect(() => parseArdSearchRequest({ query: { text: 'review', filter: { unknown: 'x' } } })).toThrow(/unsupported filter/)
    expect(() => parseArdSearchRequest({ query: { text: 'review', '@context': 'https://untrusted.example/context' } })).toThrow(/context/)
  })
  it('resolves inline namespace aliases by IRI with OR within a key and AND across keys', () => {
    const query = parseArdSearchRequest({ query: { text: 'TypeScript', '@context': { other: ARD_NAMESPACE }, filter: { 'other:mediaType': ['other/type', entry.type], capabilities: ['missing', 'iflow.cap:review'], tags: 'code', publisher: 'example.com' } } })
    expect(rankArdEntries([entry], query)).toHaveLength(1)
    expect(rankArdEntries([entry], { ...query, query: { ...query.query, filter: { ...query.query.filter, tags: ['wrong'] } } })).toHaveLength(0)
    expect(rankArdEntries([{ ...entry, '@context': { alias: ARD_NAMESPACE }, 'alias:capabilities': ['custom'], capabilities: [] }], parseArdSearchRequest({ query: { text: 'TypeScript', filter: { capabilities: 'custom' } } }))).toHaveLength(1)
  })
  it('rejects credential-bearing and private publication routes', () => {
    for (const url of ['http://public.example/a2a', 'https://user:pass@public.example/a2a', 'https://localhost/a2a', 'https://127.0.0.1/a2a', 'https://192.168.1.6/a2a', 'https://172.16.0.1/a2a', 'https://public.example/a2a?token=x']) expect(isPublicArdUrl(url)).toBe(false)
    expect(isPublicArdUrl('https://agent.example/a2a')).toBe(true)
  })
  it('accepts partial search results without turning relevance into authority', () => {
    expect(isArdSearchResponse({ results: [{ identifier: entry.identifier }] })).toBe(true)
    expect(isArdSearchResponse({ results: [{ identifier: entry.identifier, score: 2 }] })).toBe(false)
    expect(isArdSearchResponse({ results: [{ identifier: entry.identifier, capabilities: [{}] }] })).toBe(false)
    const results = rankArdEntries([entry], parseArdSearchRequest({ query: { text: 'TypeScript' } }))
    expect(results[0]?.score).toBe(1)
    expect(results[0]).not.toHaveProperty('grant')
  })
})
