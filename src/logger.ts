export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    action: string;
    context?: Record<string, string | number | boolean | undefined>;
    message?: string;
    error?: {
        name?: string;
        message: string;
        stack?: string
    };
}

export interface LogAdapter {
    exists(path: string): Promise<boolean>;

    mkdir(path: string): Promise<void>;

    read(path: string): Promise<string>;

    write(path: string, data: string): Promise<void>;
}

const MAX_LOG_BYTES = 512 * 1024;

export function serializeLogError(error: unknown): LogEntry["error"] {
    if (error instanceof Error) return {name: error.name, message: error.message, stack: error.stack};
    return {message: String(error)};
}

export class PluginLogger {
    private writePromise: Promise<void> = Promise.resolve();

    constructor(private readonly adapter: LogAdapter, private readonly logPath: string, private readonly maxBytes = MAX_LOG_BYTES) {
    }

    info(action: string, context?: LogEntry["context"], message?: string): void {
        this.enqueue({timestamp: new Date().toISOString(), level: "info", action, context, message});
    }

    warn(action: string, context?: LogEntry["context"], message?: string, error?: unknown): void {
        this.enqueue({timestamp: new Date().toISOString(), level: "warn", action, context, message, error: error === undefined ? undefined : serializeLogError(error)});
    }

    error(action: string, context?: LogEntry["context"], message?: string, error?: unknown): void {
        this.enqueue({timestamp: new Date().toISOString(), level: "error", action, context, message, error: error === undefined ? undefined : serializeLogError(error)});
    }

    private enqueue(entry: LogEntry): void {
        this.writePromise = this.writePromise.then(() => this.persist(entry)).catch((error) => {
            console.warn("Hunspell logger unavailable", error);
        });
    }

    private async persist(entry: LogEntry): Promise<void> {
        const directory = this.logPath.substring(0, this.logPath.lastIndexOf("/"));
        if (!(await this.adapter.exists(directory))) await this.adapter.mkdir(directory);

        const line = `${JSON.stringify(entry)}\n`;
        let content = "";
        if (await this.adapter.exists(this.logPath)) content = await this.adapter.read(this.logPath);
        if (new TextEncoder().encode(content).byteLength + new TextEncoder().encode(line).byteLength > this.maxBytes) content = "";
        await this.adapter.write(this.logPath, content + line);
    }
}
