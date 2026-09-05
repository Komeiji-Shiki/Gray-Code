import { describe, test, expect } from 'vitest'
import { StringLruCache } from '../../utils/stringLruCache'

describe('StringLruCache', () => {
  test('counts keys as well as values against its byte budget', () => {
    const cache = new StringLruCache(10, 12)
    cache.set('long', 'a')
    cache.set('next', 'b')
    expect(cache.get('long')).toBeUndefined()
    expect(cache.get('next')).toBe('b')
  })
  test('skips oversized entries and leaves other entries usable', () => {
    const cache = new StringLruCache(10, 12)
    cache.set('a', 'b')
    cache.set('oversized', 'value')
    expect(cache.size).toBe(1)
    expect(cache.get('a')).toBe('b')
  })
  test('evicts the least recently read entry', () => {
    const cache = new StringLruCache(2, 100)
    cache.set('a', '1')
    cache.set('b', '2')
    cache.get('a')
    cache.set('c', '3')
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe('1')
  })
  test('replacement, delete and clear keep byte accounting accurate', () => {
    const cache = new StringLruCache(3, 12)
    cache.set('a', '1234')
    cache.set('a', '')
    cache.set('b', '1234')
    expect(cache.size).toBe(2)
    expect(cache.delete('a')).toBe(true)
    expect(cache.delete('a')).toBe(false)
    cache.clear()
    cache.set('c', '12345')
    expect(cache.get('c')).toBe('12345')
  })
})
