import {App} from "obsidian";

export interface LanguageConfig {
    id: string;
    name: string;
    affPath: string;
    dicPath: string;
}

export interface LanguageCache {
    [id: string]: string;
}

export interface SpellcheckerSettings {
    activeLanguage: string;
    languages: LanguageConfig[];
    enabled: boolean;
    languageCache: LanguageCache;
    lastFetch: number;
}

export interface GithubContentItem {
    type: string;
    name: string;
    download_url?: string;
}

export interface AppWithSettings extends App {
    setting: {
        open(): void;
        openTabById(id: string): void;
    };
}
