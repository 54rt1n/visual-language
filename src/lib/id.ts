import { randomUuid } from './crypto'

export function nid(prefix = 'n'): string {
  return `${prefix}-${randomUuid()}`
}
