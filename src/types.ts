import {App} from "obsidian";

export interface LanguageConfig {
    id: string;
    name: string;
    affPath: string;
    dicPath: string;
}

export interface RemoteLanguage {
    id: string;
    name: string;
    affFileName: string;
    dicFileName: string;
    affDownloadUrl: string;
    dicDownloadUrl: string;
}

export type LanguageCache = Record<string, RemoteLanguage>;

export interface SpellcheckerSettings {
    activeLanguage: string;
    languages: LanguageConfig[];
    enabled: boolean;
    checkCodeblocks: boolean;
    languageCache: LanguageCache;
    languageCacheVersion: number;
    lastFetch: number;
}

export interface GithubContentItem {
    type: string;
    name: string;
    download_url?: string;
}

export interface GithubTreeItem {
    path: string;
    type: string;
    url?: string;
    mode?: string;
}

export interface AppWithSettings extends App {
    setting: {
        open(): void;
        openTabById(id: string): void;
    };
}
