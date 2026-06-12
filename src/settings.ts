import {App, Notice, PluginSettingTab, requestUrl, Setting} from "obsidian";
import HunspellSpellcheckerPlugin from "./main";
import {ConfirmationModal, TextEditorModal} from "./ui";
import {GithubContentItem, LanguageCache} from "./types";

const CUSTOM_DICTIONARY_FILENAME = "custom_dictionary.txt";
const IGNORED_WORDS_FILENAME = "ignored_words.txt";

export class SpellcheckerSettingTab extends PluginSettingTab {
    plugin: HunspellSpellcheckerPlugin;
    availableRemoteLanguages: {
        id: string,
        name: string
    }[] = [];

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
                    .onChange(async (value) => {
                        this.plugin.settings.activeLanguage = value;
                        await this.plugin.saveSettings();
                        await this.plugin.reloadDictionary();
                        this.display();
                    });
            });

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
                                await this.plugin.deletePluginFile(language.affPath);
                                await this.plugin.deletePluginFile(language.dicPath);

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
                    if (this.plugin.settings.lastFetch && now - this.plugin.settings.lastFetch < oneDay && Object.keys(this.plugin.settings.languageCache).length > 0) {
                        this.availableRemoteLanguages = Object.entries(this.plugin.settings.languageCache).map(([id, name]) => ({id, name}));
                    } else {
                        const response = await requestUrl({url: "https://api.github.com/repos/LibreOffice/dictionaries/contents"});
                        const data = response.json as GithubContentItem[];

                        const languageCache: LanguageCache = {};
                        this.availableRemoteLanguages = data
                            .filter(item => item.type === "dir" && !item.name.startsWith(".") && item.name !== "util")
                            .map(item => {
                                let name = item.name;
                                try {
                                    const displayNames = new Intl.DisplayNames(['en'], {type: 'language'});
                                    name = displayNames.of(item.name.replace('_', '-')) ?? item.name;
                                } catch (err) {
                                    console.error(err);
                                }
                                languageCache[item.name] = name;
                                return {id: item.name, name: name};
                            })
                            .sort((a, b) => a.name.localeCompare(b.name));

                        this.plugin.settings.languageCache = languageCache;
                        this.plugin.settings.lastFetch = now;
                        await this.plugin.saveSettings();
                    }

                    this.display();
                } catch (err) {
                    new Notice("Failed to fetch languages from GitHub.");
                    console.error(err);
                    fetchBtn.textContent = "Fetch available languages";
                    fetchBtn.disabled = false;
                }
            })();
        });

        if (this.availableRemoteLanguages.length > 0) {
            fetchBtn.classList.add("is-hidden");

            const remoteListEl = this.containerEl.createEl("div", {
                cls: "hunspell-language-list", attr: {style: "max-height: 400px; overflow-y: auto; border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s); padding: 8px;"}
            });

            for (const lang of this.availableRemoteLanguages) {
                if (this.plugin.settings.languages.some(l => l.id === lang.id)) continue;

                const item = remoteListEl.createEl("div", {cls: "hunspell-language-item", attr: {style: "margin-bottom: 4px;"}});
                const info = item.createEl("div", {cls: "hunspell-language-info"});
                info.createEl("span", {text: lang.name, cls: "hunspell-language-name"});
                info.createEl("span", {text: lang.id, cls: "hunspell-language-id"});

                const installBtn = item.createEl("button", {text: "Install", cls: "mod-cta"});
                installBtn.addEventListener("click", () => {
                    void (async () => {
                        installBtn.textContent = "Installing...";
                        installBtn.disabled = true;
                        try {
                            const response = await requestUrl({url: `https://api.github.com/repos/LibreOffice/dictionaries/contents/${lang.id}`});
                            const files = response.json as GithubContentItem[];

                            let affFile = files.find(f => f.name === `${lang.id}.aff`);
                            let dicFile = files.find(f => f.name === `${lang.id}.dic`);

                            if (!affFile) {
                                affFile = files.find(f => f.name.endsWith(".aff") && !f.name.startsWith("hyph_") && !f.name.startsWith("th_"));
                            }

                            if (!dicFile) {
                                dicFile = files.find(f => f.name.endsWith(".dic") && !f.name.startsWith("hyph_") && !f.name.startsWith("th_"));
                            }

                            if (!affFile || !dicFile || !affFile.download_url || !dicFile.download_url) {
                                throw new Error("Missing appropriate .aff or .dic file in repository.");
                            }

                            const affResponse = await requestUrl({url: affFile.download_url});
                            const dicResponse = await requestUrl({url: dicFile.download_url});

                            const langsPath = this.plugin.getPluginPath("languages");
                            if (!(await this.plugin.app.vault.adapter.exists(langsPath))) {
                                await this.plugin.app.vault.adapter.mkdir(langsPath);
                            }

                            await this.plugin.app.vault.adapter.writeBinary(this.plugin.getPluginPath(`languages/${affFile.name}`), affResponse.arrayBuffer);
                            await this.plugin.app.vault.adapter.writeBinary(this.plugin.getPluginPath(`languages/${dicFile.name}`), dicResponse.arrayBuffer);

                            await this.plugin.refreshAvailableLanguages();
                            await this.plugin.saveSettings();
                            await this.plugin.reloadDictionary();

                            new Notice(`Installed ${lang.name}`);
                            this.display();
                        } catch (e) {
                            new Notice(`Error installing language: ${String(e)}`);
                            console.error(e);
                            installBtn.textContent = "Install";
                            installBtn.disabled = false;
                        }
                    })();
                });
            }
        }

        this.containerEl.createEl("hr");

        new Setting(this.containerEl).setHeading().setName("Personal Dictionary");
        this.containerEl.createEl("p", {
            text: "Words you have added to your dictionary via right-click to be accepted during verification.", cls: "setting-item-description"
        });

        const customDictButtons = this.containerEl.createEl("div", {
            attr: {style: "display: flex; gap: 8px; margin-top: 8px;"}
        });

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

        const ignoredWordsButtons = this.containerEl.createEl("div", {
            attr: {style: "display: flex; gap: 8px; margin-top: 8px;"}
        });

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
}
