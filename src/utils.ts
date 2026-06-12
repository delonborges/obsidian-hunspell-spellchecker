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

export function parseCustomDictionary(content: string): string[] {
    return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
}

export function getFileName(path: string): string {
    return path.split("/").pop() ?? "";
}

export function removeFileExtension(fileName: string): string {
    const index = fileName.lastIndexOf(".");
    return index === -1 ? fileName : fileName.slice(0, index);
}
