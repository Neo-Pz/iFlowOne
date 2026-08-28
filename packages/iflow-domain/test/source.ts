/**
 * Reading the source as part of a test.
 *
 * Some constraints are about what the code *declares*, not what it computes.
 * "No authority-shaped field on a Publication" cannot be checked by calling a
 * projector — the reducer whitelists payload fields, so an offending key
 * smuggled into an event never reaches a view, and a test watching the output
 * passes while the interface it is guarding grows the field. The change that
 * matters happens in the declaration, so that is what these read.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

export const src = (file: string) => readFileSync(join(ROOT, 'src', file), 'utf8')

/** A file at the package root, e.g. a document the tests hold themselves to. */
export const repoDoc = (relative: string) =>
  readFileSync(join(ROOT, '..', '..', relative), 'utf8')

/**
 * Source with comment leaders and line breaks flattened to single spaces, so a
 * sentence can be matched without knowing where the author's editor wrapped it.
 */
export const prose = (file: string) =>
  src(file)
    .replace(/^\s*\*\s?/gm, ' ')
    .replace(/\s+/g, ' ')

/** The field names an interface declares, read from the source it is declared in. */
export function fieldsOf(file: string, name: string): string[] {
  const text = src(file)
  const start = text.indexOf(`export interface ${name} {`)
  if (start < 0) throw new Error(`${name} is not declared in ${file}`)
  const body = text.slice(start, text.indexOf('\n}', start))
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!)
}

/** Every key appearing anywhere in a value, however deeply nested. */
export function keysDeep(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysDeep(item, found)
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.add(key)
      keysDeep(child, found)
    }
  }
  return found
}

/**
 * Field names that would turn a fact into a permission, or into a way to act
 * on one. Shared between the discovery guards and the collaboration guards
 * because the erosion is the same in both places: the object is already in
 * front of the caller, and one more field makes the next step one click
 * shorter.
 */
export const AUTHORITY_SHAPED = [
  'grant',
  'grants',
  'grantRef',
  'permission',
  'permissions',
  'permitted',
  'allowed',
  'authorized',
  'authorization',
  'scope',
  'scopes',
  'token',
  'apiKey',
  'secret',
  'credential',
  'endpoint',
  'url',
  'callbackUrl',
  'budget',
  'price',
]
