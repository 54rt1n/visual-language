import { createHash, webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUuid, sha256Hex } from '../../src/lib/crypto'
import { nid } from '../../src/lib/id'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('browser crypto compatibility', () => {
  it('uses the native UUID with its receiver and keeps the full prefixed ID', () => {
    const uuid = '00112233-4455-4677-8899-aabbccddeeff'
    const browserCrypto = { randomUUID: vi.fn(function (this: unknown) { expect(this).toBe(browserCrypto); return uuid }) }
    vi.stubGlobal('crypto', browserCrypto)
    expect(nid('card')).toBe(`card-${uuid}`)
    expect(browserCrypto.randomUUID).toHaveBeenCalledOnce()
  })
  it('sets v4/variant bits without shortening or substituting weak randomness', () => {
    const browserCrypto = { getRandomValues: vi.fn(function (this: unknown, bytes: Uint8Array) {
      expect(this).toBe(browserCrypto)
      bytes.set(Array.from({ length: 16 }, (_, i) => i * 17)); return bytes
    }) }
    vi.stubGlobal('crypto', browserCrypto)
    const weakRandom = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Weak random fallback is forbidden.') })
    expect(nid()).toBe('n-00112233-4455-4677-8899-aabbccddeeff')
    expect(browserCrypto.getRandomValues).toHaveBeenCalledOnce()
    expect(weakRandom).not.toHaveBeenCalled()
  })
  it('generates distinct full-format IDs using the random-byte fallback', () => {
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) })
    const ids = Array.from({ length: 1000 }, () => randomUuid())
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every(id => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))).toBe(true)
  })
  it.each([undefined, {}])('fails clearly instead of inventing IDs when random bytes are unavailable', crypto => {
    vi.stubGlobal('crypto', crypto)
    expect(() => nid()).toThrow('Secure random numbers are unavailable')
  })
  it.each(['', 'abc', JSON.stringify(['save-draft', { text: '谢谢 🫖', revision: 1 }]), 'a'.repeat(1000)])('keeps native and fallback SHA-256 identical for %s', async text => {
    const expected = createHash('sha256').update(text).digest('hex')
    vi.stubGlobal('crypto', webcrypto)
    expect(await sha256Hex(text)).toBe(expected)
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) })
    expect(await sha256Hex(text)).toBe(expected)
  })
  it('does not conceal failures from an available native digest implementation', async () => {
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn().mockRejectedValue(new Error('Native crypto failure')) } })
    await expect(sha256Hex('state')).rejects.toThrow('Native crypto failure')
  })
})
