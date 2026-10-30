import {App, Notice, PluginSettingTab, requestUrl, Setting} from "obsidian";
import HunspellSpellcheckerPlugin from "./main";
import {ConfirmationModal, TextEditorModal} from "./ui";
import {GithubContentItem, GithubTreeItem, LanguageCache, RemoteLanguage} from "./types";
import {getRemoteLanguageDisplayName, selectHunspellRemotePairs, validateLanguagePair} from "./languages";
import {treeDirectories, treeFiles} from "./github-tree";

const CUSTOM_DICTIONARY_FILENAME = "custom_dictionary.txt";
const IGNORED_WORDS_FILENAME = "ignored_words.txt";
const LIBREOFFICE_DICTIONARIES_URL = "https://github.com/LibreOffice/dictionaries";

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

    display(): void {
        this.containerEl.empty();
        new Setting(this.containerEl).setHeading().setName("Hunspell Spellchecker");

        new Setting(this.containerEl)
            .setName("Active language")
            .setDesc("Select the language for spell checking")
            .addDropdown((dropdown) => {
                if (this.plugin.settings.languages.length === 0) {
                    dropdown.addOption("", "No languages installed");
                    dropdown.setValue("");
                    dropdown.setDisabled(true);
                    return dropdown;
                }

                for (const language of this.plugin.settings.languages) {
                    dropdown.addOption(language.id, language.name);
                }

                return dropdown
                    .setValue(this.plugin.settings.activeLanguage)
                    .onChange((value) => {
                        void (async () => {
                            this.plugin.settings.activeLanguage = value;
                            await this.plugin.saveSettings();
                            await this.plugin.reloadDictionary();
                            this.display();
                        })();
                    });
            });

        new Setting(this.containerEl)
            .setName("Check codeblocks")
            .setDesc("Check spelling inside fenced Markdown codeblocks")
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.checkCodeblocks)
                .onChange((value) => {
                    void (async () => {
                        this.plugin.settings.checkCodeblocks = value;
                        await this.plugin.saveSettings();
                    })();
                }));

        new Setting(this.containerEl).setHeading().setName("Installed Languages");

        const langContainer = this.containerEl.createEl("div", {cls: "hunspell-language-list"});

        if (this.plugin.settings.languages.length === 0) {
            langContainer.createEl("p", {text: "No languages installed. Download one from the list below.", cls: "setting-item-description"});
        } else {
            for (const language of this.plugin.settings.languages) {
                const item = langContainer.createEl("div", {cls: "hunspell-language-item"});
                const info = item.createEl("div", {cls: "hunspell-language-info"});
                info.createEl("span", {text: language.name, cls: "hunspell-language-name"});
                info.createEl("span", {text: language.id, cls: "hunspell-language-id"});

                const actions = item.createEl("div", {cls: "hunspell-language-actions"});

                const deleteBtn = actions.createEl("button", {text: "✕", cls: "mod-warning"});
                deleteBtn.title = "Delete language";
                deleteBtn.addEventListener("click", () => {
                    new ConfirmationModal(this.app, "Delete language", `Are you sure you want to delete the files for "${language.name}"? This action cannot be undone.`, () => {
                        void (async () => {
                            try {
                                await this.plugin.languages.remove(language);

                                await this.plugin.refreshAvailableLanguages();
                                await this.plugin.saveSettings();
                                await this.plugin.reloadDictionary();
                                this.display();
                            } catch (e) {
                                new Notice(`Error deleting language: ${String(e)}`);
                                console.error(e);
                            }
                        })();
                    }).open();
                });
            }
        }

        this.containerEl.createEl("hr");

        new Setting(this.containerEl).setHeading().setName("Local Languages");
        new Setting(this.containerEl).setDesc(createFragment((fragment) => {
            fragment.createSpan({text: "Add a dictionary stored on your computer. Select the .aff and .dic files together; both must have the same name, for example en_US.aff and en_US.dic. Need a dictionary? Browse the "});
            fragment.createEl("a", {text: "LibreOffice dictionaries", href: LIBREOFFICE_DICTIONARIES_URL});
            fragment.createSpan({text: "."});
        }));

        const addLocalBtn = this.containerEl.createEl("button", {
            text: "Add local language", cls: "mod-cta hunspell-add-language-btn"
        });

        const localFileInput = this.containerEl.createEl("input");
        localFileInput.type = "file";
        localFileInput.multiple = true;
        localFileInput.accept = ".aff,.dic";
        localFileInput.hide();

        const importLocalLanguage = async (files: File[], overwrite: boolean): Promise<void> => {
            try {
                const language = await this.plugin.languages.importPair(files, {overwrite});
                await this.plugin.refreshAvailableLanguages();
                this.plugin.settings.activeLanguage = language.id;
                await this.plugin.saveSettings();
                await this.plugin.reloadDictionary();

                new Notice(`Installed ${language.name}`);
                this.display();
            } catch (e) {
                new Notice(`Error adding language: ${String(e)}`);
                console.error(e);
            }
        };

        addLocalBtn.addEventListener("click", () => {
            localFileInput.click();
        });

        localFileInput.addEventListener("change", () => {
            void (async () => {
                const files = Array.from(localFileInput.files ?? []);
                localFileInput.value = "";

                const validation = validateLanguagePair(files.map((file) => file.name));
                if (!validation.ok) {
                    new Notice(validation.error);
                    return;
                }

                if (await this.plugin.languages.exists(validation.id)) {
                    new ConfirmationModal(this.app, "Replace language", `"${validation.id}" is already installed. Do you want to replace its files?`, () => {
                        void importLocalLanguage(files, true);
                    }).open();
                    return;
                }

                await importLocalLanguage(files, false);
            })();
        });

        this.containerEl.createEl("hr");

        new Setting(this.containerEl).setHeading().setName("Download Languages");
        this.containerEl.createEl("p", {
            text: "Download dictionaries directly from the official LibreOffice repository on GitHub.", cls: "setting-item-description"
        });

        const fetchBtn = this.containerEl.createEl("button", {
            text: "Fetch available languages", cls: "mod-cta hunspell-add-language-btn"
        });

        fetchBtn.addEventListener("click", () => {
            void (async () => {
                fetchBtn.textContent = "Fetching...";
                fetchBtn.disabled = true;
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
                                const baseId = pair.basename.toLowerCase() === directory.name.toLowerCase() ? directory.name : pair.basename;
                                let id = baseId;
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

                    this.display();
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
                    this.display();
                    console.error("Unable to fetch languages", err);
                } finally {
                    fetchBtn.textContent = "Fetch available languages";
                    fetchBtn.disabled = false;
                }
            })();
        });

        if (this.availableRemoteLanguages.length > 0) {
            fetchBtn.classList.add("is-hidden");
            if (this.remoteLanguagesStale) {
                this.containerEl.createEl("p", {text: "Showing cached languages. Fetch again later to refresh this list.", cls: "setting-item-description"});
            }

            const searchInput = this.containerEl.createEl("input", {type: "search", placeholder: "Search languages", cls: "hunspell-language-search"});

            const remoteListEl = this.containerEl.createEl("div", {
                cls: "hunspell-language-list hunspell-remote-list"
            });

            const renderRemoteLanguages = (query: string): void => {
                remoteListEl.empty();
                const normalizedQuery = query.trim().toLocaleLowerCase();
                const languages = this.availableRemoteLanguages
                    .filter((lang) => !this.plugin.settings.languages.some(l => l.id === lang.id))
                    .filter((lang) => [lang.name, lang.id, lang.affFileName, lang.dicFileName].join(" ").toLocaleLowerCase().includes(normalizedQuery))
                    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
                if (languages.length === 0) {
                    remoteListEl.createEl("p", {text: "No languages match your search.", cls: "hunspell-remote-empty"});
                    return;
                }

                for (const lang of languages) {

                    const item = remoteListEl.createEl("div", {cls: "hunspell-language-item hunspell-remote-item"});
                    const info = item.createEl("div", {cls: "hunspell-language-info"});
                    info.createEl("span", {text: lang.name, cls: "hunspell-language-name"});
                    info.createEl("span", {text: lang.id, cls: "hunspell-language-id"});

                    const installBtn = item.createEl("button", {text: "Install", cls: "mod-cta"});
                    installBtn.addEventListener("click", () => {
                        void (async () => {
                            installBtn.textContent = "Installing...";
                            installBtn.disabled = true;
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
                                this.display();
                            } catch (e) {
                                this.plugin.logger.error("languages.install.failed", {id: lang.id}, errorMessage(e), e);
                                new Notice(`Unable to install ${lang.name}: ${errorMessage(e)}`);
                                console.error("Unable to install language", e);
                                installBtn.textContent = "Install";
                                installBtn.disabled = false;
                            }
                        })();
                    });
                }
            };
            searchInput.addEventListener("input", () => renderRemoteLanguages(searchInput.value));
            renderRemoteLanguages("");
        }

        this.containerEl.createEl("hr");

        new Setting(this.containerEl).setHeading().setName("Personal Dictionary");
        this.containerEl.createEl("p", {
            text: "Words you have added to your dictionary via right-click to be accepted during verification.", cls: "setting-item-description"
        });

        const customDictButtons = this.containerEl.createEl("div", {cls: "hunspell-dict-buttons"});

        const editCustomBtn = customDictButtons.createEl("button", {text: "Edit File"});
        editCustomBtn.addEventListener("click", () => {
            void (async () => {
                const content = await this.plugin.readPluginFileSafe(CUSTOM_DICTIONARY_FILENAME);
                new TextEditorModal(this.app, "Edit Personal Dictionary", content, async (newContent) => {
                    await this.plugin.writePluginFile(CUSTOM_DICTIONARY_FILENAME, newContent);
                    await this.plugin.loadWordList(CUSTOM_DICTIONARY_FILENAME, this.plugin.customDictionaryWords);
                    this.plugin.refreshEditors();
                    new Notice("Personal dictionary updated.");
                }).open();
            })();
        });

        const clearCustomBtn = customDictButtons.createEl("button", {text: "Clear All", cls: "mod-warning"});
        clearCustomBtn.addEventListener("click", () => {
            new ConfirmationModal(this.app, "Clear Personal Dictionary", "Are you sure you want to delete all words from your personal dictionary? This action cannot be undone.", () => {
                void (async () => {
                    this.plugin.customDictionaryWords.clear();
                    await this.plugin.saveWordList(CUSTOM_DICTIONARY_FILENAME, this.plugin.customDictionaryWords);
                    this.plugin.refreshEditors();
                    new Notice("Personal dictionary cleared.");
                })();
            }).open();
        });

        this.containerEl.createEl("hr");

        new Setting(this.containerEl).setHeading().setName("Ignored Words");
        this.containerEl.createEl("p", {
            text: "Words you have asked the spellchecker to ignore locally.", cls: "setting-item-description"
        });

        const ignoredWordsButtons = this.containerEl.createEl("div", {cls: "hunspell-dict-buttons"});

        const editIgnoredBtn = ignoredWordsButtons.createEl("button", {text: "Edit File"});
        editIgnoredBtn.addEventListener("click", () => {
            void (async () => {
                const content = await this.plugin.readPluginFileSafe(IGNORED_WORDS_FILENAME);
                new TextEditorModal(this.app, "Edit Ignored Words", content, async (newContent) => {
                    await this.plugin.writePluginFile(IGNORED_WORDS_FILENAME, newContent);
                    await this.plugin.loadWordList(IGNORED_WORDS_FILENAME, this.plugin.ignoredWords);
                    this.plugin.refreshEditors();
                    new Notice("Ignored words updated.");
                }).open();
            })();
        });

        const clearIgnoredBtn = ignoredWordsButtons.createEl("button", {text: "Clear All", cls: "mod-warning"});
        clearIgnoredBtn.addEventListener("click", () => {
            new ConfirmationModal(this.app, "Clear Ignored Words", "Are you sure you want to clear the list of all ignored words? The spellchecker will flag them again.", () => {
                void (async () => {
                    this.plugin.ignoredWords.clear();
                    await this.plugin.saveWordList(IGNORED_WORDS_FILENAME, this.plugin.ignoredWords);
                    this.plugin.refreshEditors();
                    new Notice("Ignored words list cleared.");
                })();
            }).open();
        });
    }

    private isValidLanguageCache(cache: LanguageCache): boolean {
        return Object.values(cache).every((language) => Boolean(language && language.id && language.name && language.affFileName && language.dicFileName && language.affDownloadUrl && language.dicDownloadUrl));
    }
}
