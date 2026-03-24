/**
 * A Map with LRU (Least Recently Used) eviction.
 *
 * Entries are evicted oldest-first when the map exceeds maxSize.
 * Both get() and set() refresh an entry's recency.
 * An optional onEvict callback fires when entries are automatically evicted.
 *
 * Note: delete() does NOT fire onEvict — only automatic eviction from set() does.
 */
export class LRUMap<K, V> implements Iterable<[K, V]> {
  private readonly map = new Map<K, V>();

  constructor(
    private readonly maxSize: number,
    private readonly onEvict?: (key: K, value: V) => void,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      this.evictOldest();
    }

    this.map.set(key, value);
    return this;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  entries(): MapIterator<[K, V]> {
    return this.map.entries();
  }

  keys(): MapIterator<K> {
    return this.map.keys();
  }

  values(): MapIterator<V> {
    return this.map.values();
  }

  forEach(callbackfn: (value: V, key: K, map: LRUMap<K, V>) => void): void {
    this.map.forEach((value, key) => {
      callbackfn(value, key, this);
    });
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.map[Symbol.iterator]();
  }

  private evictOldest(): void {
    const oldestKey = this.map.keys().next().value as K | undefined;
    if (oldestKey === undefined) return;

    const oldestValue = this.map.get(oldestKey);
    if (oldestValue === undefined) return;

    this.map.delete(oldestKey);
    this.onEvict?.(oldestKey, oldestValue);
  }
}
