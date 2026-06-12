import {Editor, EditorRange, MarkdownView, Menu, normalizePath, Notice, Platform, Plugin, WorkspaceLeaf} from "obsidian";
import {StateEffect} from "@codemirror/state";
import {EditorView} from "@codemirror/view";
import {boundedLevenshteinDistance, HunspellDictionary} from "./hunspell";
import {getFileName, LRUCache, parseCustomDictionary, removeFileExtension} from "./utils";
import {AppWithSettings, LanguageConfig, SpellcheckerSettings} from "./types";
import {SpellcheckerSettingTab} from "./settings";
import {createSpellcheckExtension} from "./editor";

export const forceUpdateEffect = StateEffect.define<null>();

const MIN_WORD_LENGTH = 2;
const CUSTOM_DICTIONARY_FILENAME = "custom_dictionary.txt";
const IGNORED_WORDS_FILENAME = "ignored_words.txt";

const DEFAULT_SETTINGS: SpellcheckerSettings = {
    activeLanguage: "", languages: [], enabled: true, languageCache: {}, lastFetch: 0
};

export default class HunspellSpellcheckerPlugin extends Plugin {
    settings: SpellcheckerSettings = DEFAULT_SETTINGS;
    dictionary: HunspellDictionary | null = null;
    ignoredWords = new Set<string>();
    customDictionaryWords = new Set<string>();

    statusBar: HTMLElement | null = null;
    langEl: HTMLElement | null = null;
    errorEl: HTMLElement | null = null;

    errorCount: number = 0;
    currentErrors: {
        word: string,
        from: number,
        to: number
    }[] = [];

    private shouldFlagWordCache = new LRUCache<string, boolean>(10000);
    private suggestionsCache = new LRUCache<string, string[]>(2000);
    private dictionaryLoadPromise: Promise<void> | null = null;
    private unloaded = false;

    override onload(): void {
        this.unloaded = false;

        void (async () => {
            await this.loadSettings();

            this.statusBar = this.addStatusBarItem();
            this.statusBar.classList.add("hunspell-status-bar-item");

            this.langEl = this.statusBar.createEl("span", {cls: "hunspell-status-lang", attr: {style: "cursor: pointer;"}});
            this.langEl.title = "Settings / Change language";

            this.errorEl = this.statusBar.createEl("span", {cls: "hunspell-status-error", attr: {style: "margin-left: 4px; cursor: pointer;"}});

            this.registerDomEvent(this.langEl, "click", (event) => {
                if (!this.settings.enabled) return;

                const menu = new Menu();

                if (this.settings.languages.length > 0) {
                    for (const language of this.settings.languages) {
                        menu.addItem((item) => {
                            item.setTitle(language.name)
                                .setChecked(language.id === this.settings.activeLanguage)
                                .onClick(async () => {
                                    this.settings.activeLanguage = language.id;
                                    await this.saveSettings();
                                    await this.reloadDictionary();
                                });
                        });
                    }
                    menu.addSeparator();
                }

                menu.addItem((item) => {
                    item.setTitle("Manage languages...")
                        .setIcon("settings")
                        .onClick(() => {
                            const appWithSettings = this.app as unknown as AppWithSettings;
                            appWithSettings.setting.open();
                            appWithSettings.setting.openTabById(this.manifest.id);
                        });
                });

                menu.showAtMouseEvent(event);
            });

            this.registerDomEvent(this.errorEl, "click", (event) => {
                if (!this.settings.enabled || this.currentErrors.length === 0) return;

                const menu = new Menu();
                const errorsToShow = this.currentErrors.slice(0, 50);

                for (const error of errorsToShow) {
                    menu.addItem((item) => {
                        item.setTitle(error.word)
                            .setIcon("edit")
                            .onClick(() => {
                                const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                                if (activeView && activeView.editor) {
                                    const editor = activeView.editor;
                                    try {
                                        const fromPos = editor.offsetToPos(error.from);
                                        const toPos = editor.offsetToPos(error.to);
                                        editor.setSelection(fromPos, toPos);
                                        editor.scrollIntoView({from: fromPos, to: toPos});
                                        this.app.workspace.setActiveLeaf(activeView.leaf, {focus: true});
                                    } catch (e) {
                                        console.warn("Could not navigate to word", e);
                                    }
                                }
                            });
                    });
                }

                if (this.currentErrors.length > 50) {
                    menu.addItem((item) => {
                        item.setTitle(`...and ${this.currentErrors.length - 50} more`)
                            .setDisabled(true);
                    });
                }

                menu.showAtMouseEvent(event);
            });

            this.updateStatusBarText("disabled");

            if (!this.settings.enabled) {
                return;
            }

            this.updateStatusBarText("waiting");
            this.registerEditorExtension(createSpellcheckExtension(this));
            this.addSettingTab(new SpellcheckerSettingTab(this.app, this));

            this.addCommand({
                id: "reload-dictionary", name: "Reload dictionary", callback: () => {
                    void this.reloadDictionary();
                }
            });

            this.addCommand({
                id: "ignore-selected-word", name: "Ignore selected word", editorCallback: async (editor) => {
                    const selected = editor.getSelection().trim();
                    if (!selected) {
                        new Notice("Select a word to ignore.");
                        return;
                    }
                    await this.ignoreWord(selected);
                }
            });

            this.addCommand({
                id: "add-word-to-dictionary", name: "Add word to dictionary", editorCallback: async (editor) => {
                    const selected = editor.getSelection().trim();
                    if (!selected) {
                        new Notice("Select a word to add.");
                        return;
                    }
                    await this.addWordToDictionary(selected);
                }
            });

            this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
                this.addContextMenuItems(menu, editor);
            }));

            await this.loadWordList(CUSTOM_DICTIONARY_FILENAME, this.customDictionaryWords);
            await this.loadWordList(IGNORED_WORDS_FILENAME, this.ignoredWords);
            void this.ensureDictionaryLoaded();
        })();
    }

    override onunload(): void {
        this.unloaded = true;
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<SpellcheckerSettings>);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
        this.refreshEditors();
    }

    async reloadDictionary(options: {
        silent?: boolean
    } = {}): Promise<void> {
        if (this.dictionaryLoadPromise) {
            return this.dictionaryLoadPromise;
        }

        this.dictionaryLoadPromise = this.performDictionaryReload(options).finally(() => {
            this.dictionaryLoadPromise = null;
        });

        return this.dictionaryLoadPromise;
    }

    shouldFlagWord(word: string): boolean {
        if (!this.dictionary || !this.settings.enabled) {
            return false;
        }

        const cached = this.shouldFlagWordCache.get(word);
        if (cached !== undefined) {
            return cached;
        }

        const normalized = word.toLocaleLowerCase();
        const shouldFlag = word.length >= MIN_WORD_LENGTH && !this.ignoredWords.has(word) && !this.ignoredWords.has(normalized) && !this.customDictionaryWords.has(word) && !this.customDictionaryWords.has(normalized) && !/^[A-ZÁÀÂÃÉÊÍÓÔÕÚÜÇ]{2,}$/u.test(word) && !this.dictionary.has(word);

        this.shouldFlagWordCache.set(word, shouldFlag);
        return shouldFlag;
    }

    suggest(word: string, limit = 8): string[] {
        if (!this.dictionary) {
            return [];
        }

        const cached = this.suggestionsCache.get(word);
        if (cached !== undefined) {
            return cached;
        }

        const suggestions = new Set<string>(this.dictionary.suggest(word, limit) ?? []);
        for (const suggestion of this.suggestCustomDictionaryWords(word, limit)) {
            suggestions.add(suggestion);
        }

        const result = Array.from(suggestions).slice(0, limit);
        this.suggestionsCache.set(word, result);
        return result;
    }

    async ignoreWord(word: string): Promise<void> {
        const trimmed = word.trim();
        if (!trimmed) return;

        if (!this.ignoredWords.has(trimmed)) {
            this.ignoredWords.add(trimmed);
            await this.saveWordList(IGNORED_WORDS_FILENAME, this.ignoredWords);
            this.shouldFlagWordCache.clear();
            this.refreshEditors();
        }

        new Notice(`"${word}" will be ignored.`);
    }

    async addWordToDictionary(word: string): Promise<void> {
        const trimmed = word.trim();
        if (!trimmed) {
            return;
        }

        if (!this.customDictionaryWords.has(trimmed)) {
            this.customDictionaryWords.add(trimmed);
            await this.saveWordList(CUSTOM_DICTIONARY_FILENAME, this.customDictionaryWords);
            this.shouldFlagWordCache.clear();
            this.suggestionsCache.clear();
            this.refreshEditors();
        }

        new Notice(`"${word}" added to personal dictionary.`);
    }

    async refreshAvailableLanguages(): Promise<void> {
        const discoveredLanguages = await this.discoverDictionaryLanguages();
        this.settings.languages = discoveredLanguages;

        if (discoveredLanguages.length === 0) {
            this.settings.activeLanguage = "";
            return;
        }

        if (!this.settings.activeLanguage || !this.settings.languages.some((language) => language.id === this.settings.activeLanguage)) {
            this.settings.activeLanguage = this.settings.languages[0].id;
        }
    }

    async loadWordList(filename: string, set: Set<string>): Promise<void> {
        set.clear();
        try {
            const content = await this.readPluginFileSafe(filename);
            for (const word of parseCustomDictionary(content)) {
                set.add(word);
            }
        } catch (error) {
            console.warn(`Error loading list ${filename}: ${String(error)}`);
        }
        this.shouldFlagWordCache.clear();
    }

    async saveWordList(filename: string, set: Set<string>): Promise<void> {
        const words = Array.from(set).sort((left, right) => left.localeCompare(right));
        await this.ensurePluginDirectory();
        await this.writePluginFile(filename, words.length ? `${words.join("\n")}\n` : "");
    }

    async readPluginFileSafe(filePath: string): Promise<string> {
        const fullPath = this.getPluginPath(filePath);
        if (await this.app.vault.adapter.exists(fullPath)) {
            return this.app.vault.adapter.read(fullPath);
        }
        return "";
    }

    async writePluginFile(filePath: string, content: string): Promise<void> {
        return this.app.vault.adapter.write(this.getPluginPath(filePath), content);
    }

    async deletePluginFile(filePath: string): Promise<void> {
        const fullPath = this.getPluginPath(filePath);
        if (await this.app.vault.adapter.exists(fullPath)) {
            return this.app.vault.adapter.remove(fullPath);
        }
    }

    getPluginPath(filePath = ""): string {
        return normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/${filePath}`);
    }

    refreshEditors(): void {
        const workspace = this.app.workspace;

        interface WorkspaceWithUpdateOptions {
            updateOptions?(): void;
        }

        const workspaceWithOptions = workspace as unknown as WorkspaceWithUpdateOptions;
        if (typeof workspaceWithOptions.updateOptions === "function") {
            workspaceWithOptions.updateOptions();
        }

        this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
            const view = leaf.view;
            if (view instanceof MarkdownView) {
                const editor = view.editor as unknown as {
                    cm?: EditorView
                };
                if (editor.cm) {
                    editor.cm.dispatch({
                        effects: forceUpdateEffect.of(null)
                    });
                }
            }
        });
    }

    updateStatusBarText(state: string) {
        if (!this.langEl || !this.errorEl || this.unloaded) return;

        const language = this.getActiveLanguage();

        if (state === "disabled" || state === "waiting" || state === "no language" || state === "error" || state.startsWith("loading")) {
            this.langEl.textContent = `Hunspell: ${state}`;
            this.errorEl.textContent = "";
            this.errorEl.style.display = "none";
        } else if (language) {
            const langId = language.id.replace('_', '-');
            this.langEl.textContent = `${langId}: `;

            this.errorEl.style.display = "inline";
            if (this.errorCount > 0) {
                this.errorEl.textContent = `🔴 (${this.errorCount})`;
                this.errorEl.title = "Show misspelled words";
            } else {
                this.errorEl.textContent = `🟢`;
                this.errorEl.title = "No misspelled words found";
            }
        }
    }

    getActiveLanguage(): LanguageConfig | undefined {
        return this.settings.languages.find((language) => language.id === this.settings.activeLanguage);
    }

    private async performDictionaryReload(options: {
        silent?: boolean
    } = {}): Promise<void> {
        await this.refreshAvailableLanguages();

        const language = this.getActiveLanguage();
        if (!language) {
            this.dictionary = null;
            this.shouldFlagWordCache.clear();
            this.suggestionsCache.clear();
            this.updateStatusBarText("no language");
            if (!options.silent) {
                new Notice("No active language configured.");
            }
            this.refreshEditors();
            return;
        }

        try {
            this.updateStatusBarText(`loading ${language.id}...`);

            const [aff, dic] = await Promise.all([this.readPluginFileSafe(language.affPath), this.readPluginFileSafe(language.dicPath)]);
            if (!aff || !dic) {
                throw new Error("Missing .aff or .dic files");
            }

            this.dictionary = await HunspellDictionary.fromFiles({aff, dic}, (msg) => {
                if (!this.unloaded) {
                    this.updateStatusBarText(msg);
                }
            });

            this.shouldFlagWordCache.clear();
            this.suggestionsCache.clear();
            this.updateStatusBarText(language.id);
            if (!options.silent) {
                new Notice(`Dictionary ${language.name} loaded.`);
            }
        } catch (error) {
            console.error("Error loading dictionary:", error);
            this.dictionary = null;
            this.shouldFlagWordCache.clear();
            this.suggestionsCache.clear();
            this.updateStatusBarText("error");
            if (!options.silent) {
                new Notice(`Error loading dictionary: ${String(error)}`);
            }
        }

        this.refreshEditors();
    }

    private async ensureDictionaryLoaded(): Promise<void> {
        if (this.dictionary !== null || this.dictionaryLoadPromise) {
            return;
        }
        await this.reloadDictionary({silent: true});
    }

    private suggestCustomDictionaryWords(word: string, limit: number): string[] {
        const normalized = word.trim().toLocaleLowerCase();
        if (!normalized || !this.customDictionaryWords.size) {
            return [];
        }

        return Array.from(this.customDictionaryWords)
            .map((candidate) => ({
                candidate, distance: boundedLevenshteinDistance(normalized, candidate.toLocaleLowerCase(), 2)
            }))
            .filter(({distance}) => distance <= 2)
            .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))
            .slice(0, limit)
            .map(({candidate}) => candidate);
    }

    private addContextMenuItems(menu: Menu, editor: Editor): void {
        const range = this.getContextWordRange(editor);
        if (!range) {
            return;
        }

        const word = editor.getRange(range.from, range.to);
        if (!this.shouldFlagWord(word)) {
            return;
        }

        menu.addSeparator();

        if (Platform.isDesktop) {
            const suggestions = this.suggest(word, 6);
            if (suggestions.length > 0) {
                for (const suggestion of suggestions) {
                    menu.addItem((item) => {
                        item
                            .setTitle(suggestion)
                            .setSection("hunspell-spellchecker")
                            .onClick(() => {
                                editor.replaceRange(suggestion, range.from, range.to);
                            });
                    });
                }
                menu.addSeparator();
            }
        }

        menu.addItem((item) => {
            item
                .setTitle(`Ignore "${word}"`)
                .setIcon("eye-off")
                .setSection("hunspell-spellchecker")
                .onClick(() => {
                    void this.ignoreWord(word);
                });
        });

        menu.addItem((item) => {
            item
                .setTitle(`Add "${word}" to dictionary`)
                .setIcon("book-plus")
                .setSection("hunspell-spellchecker")
                .onClick(() => {
                    void this.addWordToDictionary(word);
                });
        });
    }

    private getContextWordRange(editor: Editor): EditorRange | null {
        if (editor.somethingSelected()) {
            return {
                from: editor.getCursor("from"), to: editor.getCursor("to")
            };
        }

        return editor.wordAt(editor.getCursor());
    }

    private async discoverDictionaryLanguages(): Promise<LanguageConfig[]> {
        try {
            const languagesPath = this.getPluginPath("languages");
            if (!(await this.app.vault.adapter.exists(languagesPath))) {
                await this.app.vault.adapter.mkdir(languagesPath);
            }

            const listedFiles = await this.app.vault.adapter.list(languagesPath);
            const entries = listedFiles.files.map((file) => getFileName(file));
            const dicIds = new Set(entries.filter((entry) => entry.endsWith(".dic")).map((entry) => removeFileExtension(entry)));

            let displayNames: Intl.DisplayNames | null = null;
            try {
                displayNames = new Intl.DisplayNames(['en'], {type: 'language'});
            } catch {
                console.error("Failed to initialize Intl.DisplayNames");
            }

            return entries
                .filter((entry) => entry.endsWith(".aff"))
                .map((entry) => removeFileExtension(entry))
                .filter((id) => dicIds.has(id))
                .sort((left, right) => left.localeCompare(right))
                .map((id) => {
                    let name = id;
                    if (displayNames) {
                        try {
                            const normalizedId = id.replace('_', '-');
                            name = displayNames.of(normalizedId) ?? id;
                        } catch (err) {
                            console.error(err);
                        }
                    }

                    return {
                        id, name: name, affPath: `languages/${id}.aff`, dicPath: `languages/${id}.dic`
                    };
                });
        } catch (err) {
            console.error(err);
            return [];
        }
    }

    private async ensurePluginDirectory(): Promise<void> {
        const directoryPath = this.getPluginPath();
        if (!(await this.app.vault.adapter.exists(directoryPath))) {
            await this.app.vault.adapter.mkdir(directoryPath);
        }
    }
}