export class LRUCache<K, V> {
    private cache = new Map<K, V>();
    private readonly maxSize: number;

    constructor(maxSize: number = 10000) {
        this.maxSize = maxSize;
    }

    get(key: K): V | undefined {
        return this.cache.get(key);
    }

    set(key: K, value: V): void {
        if (this.cache.size >= this.maxSize) {
            this.cache.clear();
        }
        this.cache.set(key, value);
    }

    clear(): void {
        this.cache.clear();
    }
}
