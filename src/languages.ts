import {App} from "obsidian";
import {GithubContentItem, LanguageConfig} from "./types";
import {getFileName, removeFileExtension} from "./utils";

export interface LanguageStorage {
    app: App;

    getPluginPath(filePath?: string): string;
}

export type PairValidationResult =
    | {
    ok: true;
    id: string
}
    | {
    ok: false;
    error: string
};

const LANGUAGE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface HunspellRemotePair {
    basename: string;
    affFile: GithubContentItem;
    dicFile: GithubContentItem;
}

function isAuxiliaryDictionary(name: string): boolean {
    const lowerName = name.toLowerCase();
    return lowerName.startsWith("hyph_") || lowerName.startsWith("th_") || lowerName.startsWith("README");
}

export function selectHunspellRemotePairs(files: GithubContentItem[], directoryId: string): HunspellRemotePair[] {
    const affByBase = new Map<string, GithubContentItem>();
    const dicByBase = new Map<string, GithubContentItem>();
    for (const file of files) {
        if (file.type !== "file" || !file.download_url || isAuxiliaryDictionary(file.name)) continue;
        const extension = file.name.toLowerCase().endsWith(".aff") ? "aff" : file.name.toLowerCase().endsWith(".dic") ? "dic" : null;
        if (!extension) continue;
        const basename = removeFileExtension(file.name);
        if (!LANGUAGE_ID_PATTERN.test(basename)) continue;
        (extension === "aff" ? affByBase : dicByBase).set(basename, file);
    }

    const candidates = [...affByBase.keys()].filter((basename) => dicByBase.has(basename)).sort((a, b) => a.localeCompare(b));
    const preferred = candidates.find((basename) => basename.toLowerCase() === directoryId.toLowerCase());
    const ordered = preferred ? [preferred, ...candidates.filter((basename) => basename !== preferred)] : candidates;
    return ordered.map((basename) => ({basename, affFile: affByBase.get(basename)!, dicFile: dicByBase.get(basename)!}));
}

export function selectHunspellRemotePair(files: GithubContentItem[], directoryId: string): HunspellRemotePair | null {
    return selectHunspellRemotePairs(files, directoryId)[0] ?? null;
}

export function getRemoteLanguageDisplayName(id: string, basename: string): string {
    const name = getLanguageDisplayName(basename);
    return name === basename ? `${id} (${basename})` : `${name} (${basename})`;
}

export function validateLanguagePair(fileNames: string[]): PairValidationResult {
    const pairError = "Select exactly one .aff file and one .dic file.";
    if (fileNames.length !== 2) {
        return {ok: false, error: pairError};
    }

    const affNames = fileNames.filter((name) => name.endsWith(".aff"));
    const dicNames = fileNames.filter((name) => name.endsWith(".dic"));
    if (affNames.length !== 1 || dicNames.length !== 1) {
        return {ok: false, error: pairError};
    }

    const affName = affNames[0];
    const dicName = dicNames[0];
    const id = removeFileExtension(affName);
    if (id !== removeFileExtension(dicName)) {
        return {ok: false, error: `The files must have the same name: ${affName} and ${dicName}.`};
    }

    if (!LANGUAGE_ID_PATTERN.test(id)) {
        return {ok: false, error: `Invalid language name "${id}". Use only letters, numbers, "_" and "-".`};
    }

    return {ok: true, id};
}

export function getLanguageDisplayName(id: string): string {
    try {
        const displayNames = new Intl.DisplayNames(['en'], {type: 'language'});
        return displayNames.of(id.replace('_', '-')) ?? id;
    } catch (err) {
        console.error(err);
        return id;
    }
}

export class LanguageRegistry {
    host: LanguageStorage;

    constructor(host: LanguageStorage) {
        this.host = host;
    }

    async scan(): Promise<LanguageConfig[]> {
        try {
            const languagesPath = this.host.getPluginPath("languages");
            if (!(await this.host.app.vault.adapter.exists(languagesPath))) {
                await this.host.app.vault.adapter.mkdir(languagesPath);
            }

            const listedFiles = await this.host.app.vault.adapter.list(languagesPath);
            const entries = listedFiles.files.map((file) => getFileName(file));
            const dicIds = new Set(entries.filter((entry) => entry.endsWith(".dic")).map((entry) => removeFileExtension(entry)));

            return entries
                .filter((entry) => entry.endsWith(".aff"))
                .map((entry) => removeFileExtension(entry))
                .filter((id) => dicIds.has(id))
                .sort((left, right) => left.localeCompare(right))
                .map((id) => ({
                    id, name: getLanguageDisplayName(id), affPath: `languages/${id}.aff`, dicPath: `languages/${id}.dic`
                }));
        } catch (err) {
            console.error(err);
            return [];
        }
    }

    async exists(id: string): Promise<boolean> {
        const adapter = this.host.app.vault.adapter;
        return (await adapter.exists(this.getFilePath(id, "aff"))) || (await adapter.exists(this.getFilePath(id, "dic")));
    }

    async importPair(files: File[], options: {
        overwrite?: boolean
    } = {}): Promise<LanguageConfig> {
        const validation = validateLanguagePair(files.map((file) => file.name));
        if (!validation.ok) {
            throw new Error(validation.error);
        }

        const id = validation.id;
        if (!options.overwrite && await this.exists(id)) {
            throw new Error(`Language "${id}" is already installed.`);
        }

        const affFile = files.find((file) => file.name.endsWith(".aff"));
        const dicFile = files.find((file) => file.name.endsWith(".dic"));
        if (!affFile || !dicFile) {
            throw new Error("Select exactly one .aff file and one .dic file.");
        }

        const affData = await affFile.arrayBuffer();
        const dicData = await dicFile.arrayBuffer();

        const adapter = this.host.app.vault.adapter;
        const languagesPath = this.host.getPluginPath("languages");
        if (!(await adapter.exists(languagesPath))) {
            await adapter.mkdir(languagesPath);
        }

        const affFullPath = this.getFilePath(id, "aff");
        await adapter.writeBinary(affFullPath, affData);
        try {
            await adapter.writeBinary(this.getFilePath(id, "dic"), dicData);
        } catch (error) {
            await this.removeIfExists(affFullPath);
            throw error;
        }

        return {
            id, name: getLanguageDisplayName(id), affPath: `languages/${id}.aff`, dicPath: `languages/${id}.dic`
        };
    }

    async remove(language: LanguageConfig): Promise<void> {
        await this.removeIfExists(this.host.getPluginPath(language.affPath));
        await this.removeIfExists(this.host.getPluginPath(language.dicPath));
    }

    private getFilePath(id: string, extension: string): string {
        return this.host.getPluginPath(`languages/${id}.${extension}`);
    }

    private async removeIfExists(fullPath: string): Promise<void> {
        if (await this.host.app.vault.adapter.exists(fullPath)) {
            await this.host.app.vault.adapter.remove(fullPath);
        }
    }
}
