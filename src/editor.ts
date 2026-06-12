import {Extension, RangeSetBuilder} from "@codemirror/state";
import {Decoration, DecorationSet, EditorView, hoverTooltip, Tooltip, ViewPlugin, ViewUpdate} from "@codemirror/view";
import {Platform} from "obsidian";
import HunspellSpellcheckerPlugin, {forceUpdateEffect} from "./main";
import {tokenize} from "./tokenize";

export function createSpellcheckExtension(plugin: HunspellSpellcheckerPlugin): Extension[] {
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
        if (plugin.errorCount !== 0) {
            plugin.errorCount = 0;
            plugin.currentErrors = [];
            plugin.updateStatusBarText(plugin.getActiveLanguage()?.id || "waiting");
        }
        return new RangeSetBuilder<Decoration>().finish();
    }

    const builder = new RangeSetBuilder<Decoration>();
    const doc = view.state.doc;

    let newErrors: {
        word: string,
        from: number,
        to: number
    }[] = [];

    for (const {from, to} of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
            const line = doc.lineAt(pos);
            const text = line.text;

            for (const token of tokenize(text)) {
                if (plugin.shouldFlagWord(token.text)) {
                    const tokenFrom = line.from + token.from;
                    const tokenTo = line.from + token.to;
                    builder.add(tokenFrom, tokenTo, Decoration.mark({class: "hunspell-spellchecker-error"}));
                    newErrors.push({word: token.text, from: tokenFrom, to: tokenTo});
                }
            }

            pos = line.to + 1;
        }
    }

    plugin.currentErrors = newErrors;
    if (plugin.errorCount !== newErrors.length) {
        plugin.errorCount = newErrors.length;
        plugin.updateStatusBarText(plugin.getActiveLanguage()?.id || "waiting");
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
