import {Extension, RangeSetBuilder, StateEffect} from "@codemirror/state";
import {Decoration, DecorationSet, EditorView, hoverTooltip, Tooltip, ViewPlugin, ViewUpdate} from "@codemirror/view";
import {App, Editor, EditorRange, Menu, normalizePath, Notice, Platform, Plugin, PluginSettingTab, Setting} from "obsidian";
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

interface SpellcheckerSettings {
    activeLanguage: string;
    languages: LanguageConfig[];
    enabled: boolean;
}

const MIN_WORD_LENGTH = 2;
const CUSTOM_DICTIONARY_FILENAME = "custom_dictionary.txt";
const IGNORED_WORDS_FILENAME = "ignored_words.txt";

const DEFAULT_SETTINGS: SpellcheckerSettings = {
    activeLanguage: "pt-BR", languages: [{
        id: "pt-BR", name: "Portuguese (Brazil)", affPath: "languages/pt-BR.aff", dicPath: "languages/pt-BR.dic"
    }], enabled: true
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

    async onload(): Promise<void> {
        this.unloaded = false;
        await this.loadSettings();

        this.statusBar = this.addStatusBarItem();
        this.statusBar.setText("Hunspell: disabled");
        this.statusBar.classList.add("hunspell-status-bar-item");

        this.registerDomEvent(this.statusBar, "click", (event) => {
            if (!this.settings.enabled || this.settings.languages.length <= 1) return;

            const menu = new Menu();
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
                void this.reloadDictionary()
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

        void this.loadWordList(CUSTOM_DICTIONARY_FILENAME, this.customDictionaryWords);
        void this.loadWordList(IGNORED_WORDS_FILENAME, this.ignoredWords);
        void this.ensureDictionaryLoaded();
    }

    onunload(): void {
        this.unloaded = true;
    }

    async loadSettings(): Promise<void> {
        const loaded = await this.loadData() as SpellcheckerSettings | null;
        this.settings = {
            ...DEFAULT_SETTINGS,
            ...loaded,
            languages: loaded?.languages?.length ? loaded.languages : DEFAULT_SETTINGS.languages,
            enabled: loaded?.enabled !== false
        };
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
        if (!discoveredLanguages.length) {
            return;
        }

        this.settings.languages = discoveredLanguages;
        if (!this.settings.languages.some((language) => language.id === this.settings.activeLanguage)) {
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
        (this.app.workspace as any).updateOptions?.();

        this.app.workspace.iterateAllLeaves((leaf) => {
            const view = leaf.view as any;
            if (view?.editor?.cm instanceof EditorView) {
                view.editor.cm.dispatch({
                    effects: forceUpdateEffect.of(null)
                });
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
                // Ignore if not supported
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
                        } catch {
                            // Ignore if language id is not valid
                        }
                    }

                    return {
                        id, name: name, affPath: `languages/${id}.aff`, dicPath: `languages/${id}.dic`
                    };
                });
        } catch {
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
        pos: token.from,
        end: token.to,
        above: false,
        arrow: false,
        create: () => {
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

            return {dom};
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

        for (const language of this.plugin.settings.languages) {
            const item = langContainer.createEl("div", {cls: "hunspell-language-item"});
            const info = item.createEl("div", {cls: "hunspell-language-info"});
            info.createEl("span", {text: language.name, cls: "hunspell-language-name"});
            info.createEl("span", {text: language.id, cls: "hunspell-language-id"});

            const actions = item.createEl("div", {cls: "hunspell-language-actions"});

            if (this.plugin.settings.languages.length > 1) {
                const deleteBtn = actions.createEl("button", {text: "✕", cls: "mod-warning"});
                deleteBtn.title = "Delete language";
                deleteBtn.addEventListener("click", () => {
                    if (this.plugin.settings.languages.length <= 1) return;

                    new ConfirmationModal(this.app, "Delete language", `Are you sure you want to delete the files for "${language.name}"? This action cannot be undone.`, () => {
                        void (async () => {
                            try {
                                await this.plugin.deletePluginFile(language.affPath);
                                await this.plugin.deletePluginFile(language.dicPath);

                                await this.plugin.refreshAvailableLanguages();
                                if (this.plugin.settings.activeLanguage === language.id && this.plugin.settings.languages.length > 0) {
                                    this.plugin.settings.activeLanguage = this.plugin.settings.languages[0].id;
                                    await this.plugin.reloadDictionary();
                                }
                                await this.plugin.saveSettings();
                                this.display();
                            } catch (e) {
                                new Notice(`Error deleting language: ${String(e)}`);
                            }
                        })();
                    }).open();
                });
            }
        }

        const addLangBtn = this.containerEl.createEl("button", {
            text: "Add Language", cls: "mod-cta hunspell-add-language-btn"
        });

        addLangBtn.addEventListener("click", () => {
            const input = activeDocument.createElement('input');
            input.type = 'file';
            input.multiple = true;

            input.onchange = async (event) => {
                const target = event.target as HTMLInputElement;
                const files = target.files;

                if (!files || files.length === 0) return;

                let affFile: File | undefined;
                let dicFile: File | undefined;

                for (let i = 0; i < files.length; i++) {
                    if (files[i].name.endsWith(".aff")) affFile = files[i];
                    if (files[i].name.endsWith(".dic")) dicFile = files[i];
                }

                if (!affFile || !dicFile) {
                    new Notice("Please select both .aff and .dic corresponding files.");
                    return;
                }

                const affName = removeFileExtension(affFile.name);
                const dicName = removeFileExtension(dicFile.name);

                if (affName !== dicName) {
                    new Notice("The names of the selected .aff and .dic files do not match.");
                    return;
                }

                try {
                    const langsPath = this.plugin.getPluginPath("languages");
                    if (!(await this.app.vault.adapter.exists(langsPath))) {
                        await this.app.vault.adapter.mkdir(langsPath);
                    }

                    const affContent = await affFile.arrayBuffer();
                    const dicContent = await dicFile.arrayBuffer();

                    await this.app.vault.adapter.writeBinary(this.plugin.getPluginPath(`languages/${affFile.name}`), affContent);
                    await this.app.vault.adapter.writeBinary(this.plugin.getPluginPath(`languages/${dicFile.name}`), dicContent);

                    await this.plugin.refreshAvailableLanguages();
                    await this.plugin.saveSettings();
                    new Notice(`Language ${affName} added successfully!`);
                    this.display();
                } catch (err) {
                    new Notice(`Error saving files: ${String(err)}`);
                }
            };

            input.click();
        });

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