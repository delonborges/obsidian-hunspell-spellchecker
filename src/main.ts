import {Extension, RangeSetBuilder, StateEffect} from "@codemirror/state";
import {Decoration, DecorationSet, EditorView, hoverTooltip, Tooltip, ViewPlugin, ViewUpdate} from "@codemirror/view";
import {App, Editor, EditorRange, MarkdownView, Menu, normalizePath, Notice, Platform, Plugin, PluginSettingTab, requestUrl, Setting, WorkspaceLeaf} from "obsidian";
import {boundedLevenshteinDistance, HunspellDictionary} from "./hunspell";
import {tokenize} from "./tokenize";
import {LRUCache} from "./utils";
import {ConfirmationModal, TextEditorModal} from "./ui";

interface LanguageConfig {
    id: string;
    name: string;
    affPath: string;
    dicPath: string;
}

interface LanguageCache {
    [id: string]: string;
}

interface SpellcheckerSettings {
    activeLanguage: string;
    languages: LanguageConfig[];
    enabled: boolean;
    languageCache: LanguageCache;
    lastFetch: number;
}

interface GithubContentItem {
    type: string;
    name: string;
    download_url?: string;
}

interface AppWithSettings extends App {
    setting: {
        open(): void;
        openTabById(id: string): void;
    };
}

const MIN_WORD_LENGTH = 2;
const CUSTOM_DICTIONARY_FILENAME = "custom_dictionary.txt";
const IGNORED_WORDS_FILENAME = "ignored_words.txt";

const DEFAULT_SETTINGS: SpellcheckerSettings = {
    activeLanguage: "", languages: [], enabled: true, languageCache: {}, lastFetch: 0
};

export const forceUpdateEffect = StateEffect.define<null>();

export default class HunspellSpellcheckerPlugin extends Plugin {
    settings: SpellcheckerSettings = DEFAULT_SETTINGS;
    dictionary: HunspellDictionary | null = null;
    ignoredWords = new Set<string>();
    customDictionaryWords = new Set<string>();
    statusBar: HTMLElement | null = null;

    private shouldFlagWordCache = new LRUCache<string, boolean>(10000);
    private suggestionsCache = new LRUCache<string, string[]>(2000);
    private dictionaryLoadPromise: Promise<void> | null = null;
    private unloaded = false;

    override onload(): void {
        this.unloaded = false;

        void (async () => {
            await this.loadSettings();

            this.statusBar = this.addStatusBarItem();
            this.statusBar.setText("Hunspell: disabled");
            this.statusBar.classList.add("hunspell-status-bar-item");

            this.registerDomEvent(this.statusBar, "click", (event) => {
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

            if (!this.settings.enabled) {
                return;
            }

            this.statusBar.setText("Hunspell: waiting");
            this.registerEditorExtension(this.createSpellcheckExtension());
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
        const shouldFlag = word.length >= MIN_WORD_LENGTH && !this.ignoredWords.has(normalized) && !this.customDictionaryWords.has(normalized) && !/^[A-ZÁÀÂÃÉÊÍÓÔÕÚÜÇ]{2,}$/u.test(word) && !this.dictionary.has(word);

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
        const normalized = normalizeCustomDictionaryWord(word);
        if (!normalized) return;

        if (!this.ignoredWords.has(normalized)) {
            this.ignoredWords.add(normalized);
            await this.saveWordList(IGNORED_WORDS_FILENAME, this.ignoredWords);
            this.shouldFlagWordCache.clear();
            this.refreshEditors();
        }

        new Notice(`"${word}" will be ignored.`);
    }

    async addWordToDictionary(word: string): Promise<void> {
        const normalized = normalizeCustomDictionaryWord(word);
        if (!normalized) {
            return;
        }

        if (!this.customDictionaryWords.has(normalized)) {
            this.customDictionaryWords.add(normalized);
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
                if (editor.cm instanceof EditorView) {
                    editor.cm.dispatch({
                        effects: forceUpdateEffect.of(null)
                    });
                }
            }
        });
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
            this.statusBar?.setText("Hunspell: no language");
            if (!options.silent) {
                new Notice("No active language configured.");
            }
            this.refreshEditors();
            return;
        }

        try {
            this.statusBar?.setText(`Hunspell: loading ${language.id}...`);

            const [aff, dic] = await Promise.all([this.readPluginFileSafe(language.affPath), this.readPluginFileSafe(language.dicPath)]);
            if (!aff || !dic) {
                throw new Error("Missing .aff or .dic files");
            }

            this.dictionary = await HunspellDictionary.fromFiles({aff, dic}, (msg) => {
                if (!this.unloaded) {
                    this.statusBar?.setText(`Hunspell: ${msg}`);
                }
            });

            this.shouldFlagWordCache.clear();
            this.suggestionsCache.clear();
            this.statusBar?.setText(`Hunspell: ${language.id}`);
            if (!options.silent) {
                new Notice(`Dictionary ${language.name} loaded.`);
            }
        } catch (error) {
            console.error("Error loading dictionary:", error);
            this.dictionary = null;
            this.shouldFlagWordCache.clear();
            this.suggestionsCache.clear();
            this.statusBar?.setText("Hunspell: error");
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
        const normalized = normalizeCustomDictionaryWord(word);
        if (!normalized || !this.customDictionaryWords.size) {
            return [];
        }

        return Array.from(this.customDictionaryWords)
            .map((candidate) => ({
                candidate, distance: boundedLevenshteinDistance(normalized, candidate, 2)
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

    private getActiveLanguage(): LanguageConfig | undefined {
        return this.settings.languages.find((language) => language.id === this.settings.activeLanguage);
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

    private createSpellcheckExtension(): Extension[] {
        return createSpellcheckExtension(this);
    }
}

function createSpellcheckExtension(plugin: HunspellSpellcheckerPlugin): Extension[] {
    const decorations = ViewPlugin.define((view) => {
        let decorations = buildDecorations(view, plugin);

        return {
            get decorations(): DecorationSet {
                return decorations;
            }, update(update: ViewUpdate): void {
                const hasForceUpdate = update.transactions.some(tr => tr.effects.some(e => e.is(forceUpdateEffect)));

                if (update.docChanged || update.viewportChanged || hasForceUpdate) {
                    decorations = buildDecorations(update.view, plugin);
                }
            }
        };
    }, {
        decorations: (value) => value.decorations
    });

    const extensions: Extension[] = [decorations];

    if (Platform.isDesktop) {
        const suggestions = hoverTooltip((view, pos) => buildSuggestionTooltip(view, pos, plugin), {
            hoverTime: 300, hideOnChange: true
        });
        extensions.push(suggestions);
    }

    return extensions;
}

function buildDecorations(view: EditorView, plugin: HunspellSpellcheckerPlugin): DecorationSet {
    if (!plugin.settings.enabled || !plugin.dictionary) {
        return new RangeSetBuilder<Decoration>().finish();
    }

    const builder = new RangeSetBuilder<Decoration>();
    const doc = view.state.doc;

    for (const {from, to} of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
            const line = doc.lineAt(pos);
            const text = line.text;

            for (const token of tokenize(text)) {
                if (plugin.shouldFlagWord(token.text)) {
                    builder.add(line.from + token.from, line.from + token.to, Decoration.mark({class: "hunspell-spellchecker-error"}));
                }
            }

            pos = line.to + 1;
        }
    }

    return builder.finish();
}

function buildSuggestionTooltip(view: EditorView, pos: number, spellchecker: HunspellSpellcheckerPlugin): Tooltip | null {
    const token = findMisspelledTokenAt(view, pos, spellchecker);
    if (!token) {
        return null;
    }

    const suggestions = spellchecker.suggest(token.text, 6);
    if (!suggestions.length) {
        return null;
    }

    return {
        pos: token.from, end: token.to, above: false, arrow: false, create: () => {
            const dom = activeDocument.createElement("div");
            dom.className = "hunspell-suggestion-container";

            for (const suggestion of suggestions) {
                const button = dom.createEl("button", {text: suggestion, cls: "hunspell-suggestion-button"});
                button.addEventListener("mousedown", (event) => {
                    event.preventDefault();
                });
                button.addEventListener("click", () => {
                    view.dispatch({
                        changes: {from: token.from, to: token.to, insert: suggestion}
                    });
                    view.focus();
                });
            }

            return {
                dom, mount: () => {
                    if (dom.parentElement) {
                        dom.parentElement.classList.add("hunspell-tooltip-container");
                    }
                }
            };
        }
    };
}

function findMisspelledTokenAt(view: EditorView, pos: number, spellchecker: HunspellSpellcheckerPlugin): {
    text: string;
    from: number;
    to: number
} | null {
    const line = view.state.doc.lineAt(pos);
    for (const token of tokenize(line.text)) {
        const from = line.from + token.from;
        const to = line.from + token.to;
        if (from <= pos && pos <= to && spellchecker.shouldFlagWord(token.text)) {
            return {text: token.text, from, to};
        }
    }

    return null;
}

function normalizeCustomDictionaryWord(word: string): string {
    return word
        .trim()
        .toLocaleLowerCase()
        .normalize("NFD");
}

function parseCustomDictionary(content: string): string[] {
    return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map(normalizeCustomDictionaryWord);
}

function getFileName(path: string): string {
    return path.split("/").pop() ?? "";
}

function removeFileExtension(fileName: string): string {
    const index = fileName.lastIndexOf(".");
    return index === -1 ? fileName : fileName.slice(0, index);
}

class SpellcheckerSettingTab extends PluginSettingTab {
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
                        this.availableRemoteLanguages = Object.entries(this.plugin.settings.languageCache).map(([id, name]) => ({ id, name }));
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
                            if (!(await this.app.vault.adapter.exists(langsPath))) {
                                await this.app.vault.adapter.mkdir(langsPath);
                            }

                            await this.app.vault.adapter.writeBinary(this.plugin.getPluginPath(`languages/${affFile.name}`), affResponse.arrayBuffer);
                            await this.app.vault.adapter.writeBinary(this.plugin.getPluginPath(`languages/${dicFile.name}`), dicResponse.arrayBuffer);

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