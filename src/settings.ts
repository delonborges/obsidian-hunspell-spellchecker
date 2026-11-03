import {App, ButtonComponent, Notice, PluginSettingTab, requestUrl, SettingDefinitionItem} from "obsidian";
import HunspellSpellcheckerPlugin from "./main";
import {ConfirmationModal, TextEditorModal} from "./ui";
import {GithubContentItem, GithubTreeItem, LanguageCache, RemoteLanguage, SpellcheckerSettings} from "./types";
import {getRemoteLanguageDisplayName, selectHunspellRemotePairs, validateLanguagePair} from "./languages";
import {treeDirectories, treeFiles} from "./github-tree";

const CUSTOM_DICTIONARY_FILENAME = "custom_dictionary.txt";
const IGNORED_WORDS_FILENAME = "ignored_words.txt";
const LIBREOFFICE_DICTIONARIES_URL = "https://github.com/LibreOffice/dictionaries";
const DONATE_URL = "https://buymeacoffee.com/delonborges";
const DONATE_IMAGE_URL = `https://img.buymeacoffee.com/button-api/?text=${encodeURIComponent("Buy me a coffee")}&emoji=&slug=delonborges&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff`;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function httpStatus(error: unknown): string {
    const status = (error as {
        status?: number
    })?.status;
    return status ? ` (HTTP ${status})` : "";
}

function withRemoteMetadata(message: string, error: unknown): Error & {
    status?: number;
    headers?: Record<string, string>
} {
    const wrapped = new Error(message) as Error & {
        status?: number;
        headers?: Record<string, string>
    };
    const details = error as {
        status?: number;
        headers?: Record<string, string>
    };
    wrapped.status = details?.status;
    wrapped.headers = details?.headers;
    return wrapped;
}

function classifyRemoteError(error: unknown): {
    category: string;
    status?: number;
    retryAfter?: string;
    message: string
} {
    const details = error as {
        status?: number;
        headers?: Record<string, string>
    };
    const status = details?.status;
    const headers = details?.headers ?? {};
    const retryAfter = headers["retry-after"] ?? headers["Retry-After"];
    const reset = headers["x-ratelimit-reset"] ?? headers["X-RateLimit-Reset"];
    if (status === 403) {
        return {category: "rate-limit-or-block", status, retryAfter: retryAfter ?? reset, message: "GitHub temporarily refused the request. Wait a while and try again."};
    }
    if (status && status >= 500) return {category: "github-server", status, message: "GitHub is temporarily unavailable. Try again later."};
    if (status) return {category: "http", status, message: "GitHub could not provide the language list. Try again later."};
    return {category: "network", message: "GitHub could not be reached. Check your connection and try again."};
}

const GITHUB_API_ROOT = "https://api.github.com/repos/LibreOffice/dictionaries";
const LANGUAGE_CACHE_VERSION = 1;

export class SpellcheckerSettingTab extends PluginSettingTab {
    plugin: HunspellSpellcheckerPlugin;
    availableRemoteLanguages: RemoteLanguage[] = [];
    private remoteLanguagesStale = false;

    constructor(app: App, plugin: HunspellSpellcheckerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        const installedIds = new Set(this.plugin.settings.languages.map((language) => language.id));
        const remoteLanguages = this.availableRemoteLanguages
            .filter((lang) => !installedIds.has(lang.id))
            .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

        const languageOptions: Record<string, string> = {};
        if (this.plugin.settings.languages.length === 0) {
            languageOptions[""] = "No languages installed";
        } else {
            for (const language of this.plugin.settings.languages) {
                languageOptions[language.id] = language.name;
            }
        }

        return [
            {
                type: "group",
                items: [
                    {
                        name: "Buy me a coffee",
                        desc: "Support this project and its future development.",
                        render: (setting) => {
                            const link = setting.controlEl.createEl("a", {href: DONATE_URL, cls: "hunspell-donate-button"});
                            link.createEl("img", {attr: {src: DONATE_IMAGE_URL, height: "40px"}});
                        }
                    }
                ]
            },
            {
                type: "group",
                heading: "Hunspell Spellchecker",
                items: [
                    {
                        name: "Active language",
                        desc: "Select the language for spell checking",
                        control: {
                            type: "dropdown",
                            key: "activeLanguage",
                            options: languageOptions,
                            disabled: () => this.plugin.settings.languages.length === 0
                        }
                    },
                    {
                        name: "Check codeblocks",
                        desc: "Check spelling inside fenced Markdown codeblocks",
                        control: {type: "toggle", key: "checkCodeblocks"}
                    }
                ]
            },
            {
                type: "group",
                heading: "Installed Languages",
                items: this.plugin.settings.languages.length === 0
                    ? [{
                        name: "No languages installed",
                        desc: "No languages installed. Download one from the list below."
                    }]
                    : this.plugin.settings.languages.map((language) => ({
                        name: language.name,
                        desc: language.id,
                        render: (setting) => {
                            setting.addExtraButton((button) => button
                                .setIcon("trash")
                                .setTooltip("Delete language")
                                .onClick(() => this.deleteInstalledLanguage(language)));
                        }
                    }))
            },
            {
                type: "group",
                heading: "Local Languages",
                items: [
                    {
                        name: "Add a local dictionary",
                        desc: createFragment((fragment) => {
                            fragment.createSpan({text: "Add a dictionary stored on your computer. Select the .aff and .dic files together; both must have the same name, for example en_US.aff and en_US.dic. Need a dictionary? Browse the "});
                            fragment.createEl("a", {text: "LibreOffice dictionaries", href: LIBREOFFICE_DICTIONARIES_URL});
                            fragment.createSpan({text: "."});
                        }),
                        render: (setting) => {
                            const localFileInput = setting.settingEl.createEl("input");
                            localFileInput.type = "file";
                            localFileInput.multiple = true;
                            localFileInput.accept = ".aff,.dic";
                            localFileInput.hide();

                            localFileInput.addEventListener("change", () => {
                                void this.handleLocalFileSelection(localFileInput);
                            });

                            setting.addButton((button) => button
                                .setButtonText("Add local language")
                                .setCta()
                                .onClick(() => localFileInput.click()));
                        }
                    }
                ]
            },
            {
                type: "group",
                heading: "Download Languages",
                items: [
                    {
                        name: "Download dictionaries",
                        desc: "Download dictionaries directly from the official LibreOffice repository on GitHub."
                    },
                    {
                        name: "Fetch available languages",
                        visible: () => this.availableRemoteLanguages.length === 0,
                        render: (setting) => {
                            setting.addButton((button) => button
                                .setButtonText("Fetch available languages")
                                .setCta()
                                .onClick(() => void this.fetchRemoteLanguages(button)));
                        }
                    },
                    {
                        name: "Showing cached languages",
                        desc: "Showing cached languages. Fetch again later to refresh this list.",
                        visible: () => this.availableRemoteLanguages.length > 0 && this.remoteLanguagesStale
                    }
                ]
            },
            {
                type: "group",
                cls: "hunspell-remote-list",
                visible: () => this.availableRemoteLanguages.length > 0,
                search: {
                    placeholder: "Search languages",
                    match: (def, query) => [def.name, ...(def.aliases ?? [])].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
                },
                items: remoteLanguages.map((lang) => ({
                    name: lang.name,
                    desc: lang.id,
                    aliases: [lang.id, lang.affFileName, lang.dicFileName],
                    render: (setting) => {
                        setting.addButton((button) => button
                            .setButtonText("Install")
                            .setCta()
                            .onClick(() => void this.installRemoteLanguage(lang, button)));
                    }
                }))
            },
            {
                type: "group",
                heading: "Personal Dictionary",
                items: [
                    {
                        name: "Personal dictionary",
                        desc: "Words you have added to your dictionary via right-click to be accepted during verification.",
                        render: (setting) => {
                            setting.addExtraButton((button) => button
                                .setIcon("pencil")
                                .setTooltip("Edit file")
                                .onClick(() => void this.editPersonalDictionary()));
                            setting.addExtraButton((button) => button
                                .setIcon("trash")
                                .setTooltip("Clear all")
                                .onClick(() => this.clearPersonalDictionary()));
                        }
                    }
                ]
            },
            {
                type: "group",
                heading: "Ignored Words",
                items: [
                    {
                        name: "Ignored words",
                        desc: "Words you have asked the spellchecker to ignore locally.",
                        render: (setting) => {
                            setting.addExtraButton((button) => button
                                .setIcon("pencil")
                                .setTooltip("Edit file")
                                .onClick(() => void this.editIgnoredWords()));
                            setting.addExtraButton((button) => button
                                .setIcon("trash")
                                .setTooltip("Clear all")
                                .onClick(() => this.clearIgnoredWords()));
                        }
                    }
                ]
            }
        ];
    }

    getControlValue(key: string): unknown {
        return this.plugin.settings[key as keyof SpellcheckerSettings];
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        if (key === "activeLanguage") {
            this.plugin.settings.activeLanguage = value as string;
            await this.plugin.saveSettings();
            await this.plugin.reloadDictionary();
            this.update();
            return;
        }
        if (key === "checkCodeblocks") {
            this.plugin.settings.checkCodeblocks = value as boolean;
            await this.plugin.saveSettings();
        }
    }

    private deleteInstalledLanguage(language: SpellcheckerSettings["languages"][number]): void {
        new ConfirmationModal(this.app, "Delete language", `Are you sure you want to delete the files for "${language.name}"? This action cannot be undone.`, () => {
            void (async () => {
                try {
                    await this.plugin.languages.remove(language);

                    await this.plugin.refreshAvailableLanguages();
                    await this.plugin.saveSettings();
                    await this.plugin.reloadDictionary();
                    this.update();
                } catch (e) {
                    new Notice(`Error deleting language: ${String(e)}`);
                    console.error(e);
                }
            })();
        }).open();
    }

    private async handleLocalFileSelection(localFileInput: HTMLInputElement): Promise<void> {
        const files = Array.from(localFileInput.files ?? []);
        localFileInput.value = "";

        const validation = validateLanguagePair(files.map((file) => file.name));
        if (!validation.ok) {
            new Notice(validation.error);
            return;
        }

        if (await this.plugin.languages.exists(validation.id)) {
            new ConfirmationModal(this.app, "Replace language", `"${validation.id}" is already installed. Do you want to replace its files?`, () => {
                void this.importLocalLanguage(files, true);
            }).open();
            return;
        }

        await this.importLocalLanguage(files, false);
    }

    private async importLocalLanguage(files: File[], overwrite: boolean): Promise<void> {
        try {
            const language = await this.plugin.languages.importPair(files, {overwrite});
            await this.plugin.refreshAvailableLanguages();
            this.plugin.settings.activeLanguage = language.id;
            await this.plugin.saveSettings();
            await this.plugin.reloadDictionary();

            new Notice(`Installed ${language.name}`);
            this.update();
        } catch (e) {
            new Notice(`Error adding language: ${String(e)}`);
            console.error(e);
        }
    }

    private async fetchRemoteLanguages(fetchBtn: ButtonComponent): Promise<void> {
        fetchBtn.setButtonText("Fetching...").setDisabled(true);
        try {
            const now = Date.now();
            const oneDay = 24 * 60 * 60 * 1000;
            const cacheIsCurrent = this.plugin.settings.languageCacheVersion === LANGUAGE_CACHE_VERSION;
            if (cacheIsCurrent && this.plugin.settings.lastFetch && now - this.plugin.settings.lastFetch < oneDay && Object.keys(this.plugin.settings.languageCache).length > 0 && this.isValidLanguageCache(this.plugin.settings.languageCache)) {
                this.plugin.logger.info("languages.cache.used", {count: Object.keys(this.plugin.settings.languageCache).length});
                this.availableRemoteLanguages = Object.values(this.plugin.settings.languageCache);
            } else {
                if (Object.keys(this.plugin.settings.languageCache).length > 0) {
                    this.plugin.logger.warn("languages.cache.invalidated", {count: Object.keys(this.plugin.settings.languageCache).length}, "Cached remote language metadata is incomplete or expired");
                }
                this.plugin.settings.languageCache = {};
                this.plugin.logger.info("languages.fetch.started", {source: "github"});
                this.remoteLanguagesStale = false;
                const languageCache: LanguageCache = {};
                let data: GithubContentItem[];
                let treeItems: GithubTreeItem[] | null = null;
                const treeUrl = `${GITHUB_API_ROOT}/git/trees/master?recursive=1`;
                try {
                    const treeResponse = await requestUrl({url: treeUrl});
                    const tree = treeResponse.json as {
                        truncated?: boolean;
                        tree?: GithubTreeItem[]
                    };
                    if (tree.truncated || !Array.isArray(tree.tree)) {
                        throw new Error("GitHub dictionary tree is truncated or unavailable");
                    }
                    treeItems = tree.tree;
                    data = treeDirectories(treeItems);
                    this.plugin.logger.info("languages.fetch.tree.completed", {count: treeItems.length});
                } catch (error) {
                    this.plugin.logger.warn("languages.fetch.tree.failed", {url: treeUrl}, errorMessage(error), error);
                    const rootUrl = `${GITHUB_API_ROOT}/contents`;
                    try {
                        data = (await requestUrl({url: rootUrl})).json as GithubContentItem[];
                        this.plugin.logger.info("languages.fetch.contents.fallback", {count: data.length});
                    } catch (fallbackError) {
                        this.plugin.logger.error("languages.fetch.root.failed", {url: rootUrl}, errorMessage(fallbackError), fallbackError);
                        throw withRemoteMetadata(`GitHub repository listing failed${httpStatus(fallbackError)}: ${errorMessage(fallbackError)}`, fallbackError);
                    }
                }

                const discoveredLanguages: RemoteLanguage[] = [];
                const usedLanguageIds = new Set<string>();
                for (const directory of data.filter(item => item.type === "dir" && !item.name.startsWith(".") && item.name !== "util")) {
                    let contents: GithubContentItem[];
                    if (treeItems) {
                        contents = treeFiles(treeItems, directory.name);
                    } else {
                        const directoryUrl = `${GITHUB_API_ROOT}/contents/${directory.name}`;
                        try {
                            contents = (await requestUrl({url: directoryUrl})).json as GithubContentItem[];
                        } catch (error) {
                            this.plugin.logger.warn("languages.fetch.directory.failed", {directory: directory.name, url: directoryUrl}, errorMessage(error), error);
                            throw withRemoteMetadata(`Reading language directory "${directory.name}" failed${httpStatus(error)}: ${errorMessage(error)}`, error);
                        }
                    }
                    const pairs = selectHunspellRemotePairs(contents, directory.name);
                    if (pairs.length === 0) {
                        this.plugin.logger.warn("languages.fetch.pair.invalid", {directory: directory.name}, "No compatible .aff/.dic pair found");
                        continue;
                    }
                    for (const pair of pairs) {
                        let id = pair.basename.toLowerCase() === directory.name.toLowerCase() ? directory.name : pair.basename;
                        let suffix = 2;
                        while (usedLanguageIds.has(id.toLowerCase())) {
                            const directoryId = directory.name.split("/").join("_");
                            id = `${directoryId}_${pair.basename}`;
                            if (usedLanguageIds.has(id.toLowerCase())) id = `${directoryId}_${pair.basename}_${suffix++}`;
                        }
                        usedLanguageIds.add(id.toLowerCase());
                        const language: RemoteLanguage = {
                            id,
                            name: getRemoteLanguageDisplayName(directory.name, pair.basename),
                            affFileName: pair.affFile.name,
                            dicFileName: pair.dicFile.name,
                            affDownloadUrl: pair.affFile.download_url!,
                            dicDownloadUrl: pair.dicFile.download_url!
                        };
                        languageCache[language.id] = language;
                        discoveredLanguages.push(language);
                    }
                }
                this.availableRemoteLanguages = discoveredLanguages.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
                this.plugin.settings.languageCache = languageCache;
                this.plugin.settings.languageCacheVersion = LANGUAGE_CACHE_VERSION;
                this.plugin.settings.lastFetch = now;
                await this.plugin.saveSettings();
                this.plugin.logger.info("languages.fetch.completed", {count: this.availableRemoteLanguages.length});
            }

            this.update();
        } catch (err) {
            this.plugin.logger.error("languages.fetch.failed", undefined, errorMessage(err), err);
            if (this.availableRemoteLanguages.length === 0 && this.plugin.settings.languageCacheVersion === LANGUAGE_CACHE_VERSION && Object.keys(this.plugin.settings.languageCache).length > 0 && this.isValidLanguageCache(this.plugin.settings.languageCache)) {
                this.availableRemoteLanguages = Object.values(this.plugin.settings.languageCache);
                this.plugin.logger.info("languages.cache.fallback", {count: this.availableRemoteLanguages.length});
            }
            const classification = classifyRemoteError(err);
            this.remoteLanguagesStale = this.availableRemoteLanguages.length > 0;
            this.plugin.logger.warn("languages.fetch.classified", {category: classification.category, status: classification.status, retryAfter: classification.retryAfter});
            new Notice(this.remoteLanguagesStale ? "Could not refresh languages. Showing the last available list; try again later." : classification.message);
            this.update();
            console.error("Unable to fetch languages", err);
        } finally {
            fetchBtn.setButtonText("Fetch available languages").setDisabled(false);
        }
    }

    private async installRemoteLanguage(lang: RemoteLanguage, installBtn: ButtonComponent): Promise<void> {
        installBtn.setButtonText("Installing...").setDisabled(true);
        this.plugin.logger.info("languages.install.started", {id: lang.id, basename: lang.affFileName.replace(/\.aff$/i, "")});
        try {
            let affResponse;
            let dicResponse;
            try {
                affResponse = await requestUrl({url: lang.affDownloadUrl});
                dicResponse = await requestUrl({url: lang.dicDownloadUrl});
            } catch (error) {
                this.plugin.logger.error("languages.install.download.failed", {id: lang.id}, errorMessage(error), error);
                const classification = classifyRemoteError(error);
                this.plugin.logger.warn("languages.install.download.classified", {id: lang.id, category: classification.category, status: classification.status, retryAfter: classification.retryAfter});
                throw new Error(classification.message);
            }

            const langsPath = this.plugin.getPluginPath("languages");
            if (!(await this.plugin.app.vault.adapter.exists(langsPath))) {
                await this.plugin.app.vault.adapter.mkdir(langsPath);
            }

            const localId = lang.affFileName.replace(/\.aff$/i, "");
            const affPath = this.plugin.getPluginPath(`languages/${localId}.aff`);
            const dicPath = this.plugin.getPluginPath(`languages/${localId}.dic`);
            await this.plugin.app.vault.adapter.writeBinary(affPath, affResponse.arrayBuffer);
            try {
                await this.plugin.app.vault.adapter.writeBinary(dicPath, dicResponse.arrayBuffer);
            } catch (error) {
                if (await this.plugin.app.vault.adapter.exists(affPath)) await this.plugin.app.vault.adapter.remove(affPath);
                this.plugin.logger.error("languages.install.write.failed", {id: lang.id}, errorMessage(error), error);
                throw error;
            }

            await this.plugin.refreshAvailableLanguages();
            await this.plugin.saveSettings();
            await this.plugin.reloadDictionary();

            new Notice(`Installed ${lang.name}`);
            this.plugin.logger.info("languages.install.completed", {id: lang.id, localId});
            this.update();
        } catch (e) {
            this.plugin.logger.error("languages.install.failed", {id: lang.id}, errorMessage(e), e);
            new Notice(`Unable to install ${lang.name}: ${errorMessage(e)}`);
            console.error("Unable to install language", e);
            installBtn.setButtonText("Install").setDisabled(false);
        }
    }

    private async editPersonalDictionary(): Promise<void> {
        const content = await this.plugin.readPluginFileSafe(CUSTOM_DICTIONARY_FILENAME);
        new TextEditorModal(this.app, "Edit Personal Dictionary", content, async (newContent) => {
            await this.plugin.writePluginFile(CUSTOM_DICTIONARY_FILENAME, newContent);
            await this.plugin.loadWordList(CUSTOM_DICTIONARY_FILENAME, this.plugin.customDictionaryWords);
            this.plugin.refreshEditors();
            new Notice("Personal dictionary updated.");
        }).open();
    }

    private clearPersonalDictionary(): void {
        new ConfirmationModal(this.app, "Clear Personal Dictionary", "Are you sure you want to delete all words from your personal dictionary? This action cannot be undone.", () => {
            void (async () => {
                this.plugin.customDictionaryWords.clear();
                await this.plugin.saveWordList(CUSTOM_DICTIONARY_FILENAME, this.plugin.customDictionaryWords);
                this.plugin.refreshEditors();
                new Notice("Personal dictionary cleared.");
            })();
        }).open();
    }

    private async editIgnoredWords(): Promise<void> {
        const content = await this.plugin.readPluginFileSafe(IGNORED_WORDS_FILENAME);
        new TextEditorModal(this.app, "Edit Ignored Words", content, async (newContent) => {
            await this.plugin.writePluginFile(IGNORED_WORDS_FILENAME, newContent);
            await this.plugin.loadWordList(IGNORED_WORDS_FILENAME, this.plugin.ignoredWords);
            this.plugin.refreshEditors();
            new Notice("Ignored words updated.");
        }).open();
    }

    private clearIgnoredWords(): void {
        new ConfirmationModal(this.app, "Clear Ignored Words", "Are you sure you want to clear the list of all ignored words? The spellchecker will flag them again.", () => {
            void (async () => {
                this.plugin.ignoredWords.clear();
                await this.plugin.saveWordList(IGNORED_WORDS_FILENAME, this.plugin.ignoredWords);
                this.plugin.refreshEditors();
                new Notice("Ignored words list cleared.");
            })();
        }).open();
    }

    private isValidLanguageCache(cache: LanguageCache): boolean {
        return Object.values(cache).every((language) => Boolean(language && language.id && language.name && language.affFileName && language.dicFileName && language.affDownloadUrl && language.dicDownloadUrl));
    }
}
