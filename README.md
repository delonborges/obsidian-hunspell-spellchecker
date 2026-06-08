# Hunspell Spellchecker for Obsidian

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A high-performance, completely offline spellchecker for Obsidian using standard Hunspell `.aff` and `.dic` dictionary pairs. This plugin provides advanced
control over multiple languages, cross-platform stability (including Mobile support), and real-time word
suggestions—without ever sending your private notes to third-party servers.

## ✨ Features

- **High Performance on Mobile:** Specifically architected to avoid memory bloat. The spellchecking engine uses "on-the-fly" reverse affix evaluation,
  making it light enough to run smoothly on iOS and Android devices.
- **True Multi-Language Support:** Install as many dictionaries as you need. Includes seamless integration with the `Intl.DisplayNames` API to show native
  language names.
- **1-Click Quick Swap:** Change your active spellchecking language instantly from the Obsidian Status Bar at the bottom right.
- **Smart Context Menu:** Right-click on a misspelled word (desktop only) to see real-time suggestions natively integrated into your editor.
- **Personal Dictionary & Ignored Words:**
    - Full control over your local dictionaries.
    - Edit your "Ignored Words" or "Custom Dictionary" directly inside Obsidian using a full-screen text editor modal.

## 📦 Included by Default

For immediate usage, **Portuguese (Brazil) (`pt-BR`)** is included by default. If you only need this language, it’s enough to install and enable the plugin!

## 🌐 Adding More Languages

The Hunspell engine relies on two separate files to work:

1. **`.dic` (Dictionary):** A list containing the root words.
2. **`.aff` (Affixes):** A rulebook containing prefixes, suffixes, plurals, and verb conjugations.

You must always have both files for a language, and they must share the exact same name (e.g., `es-ES.dic` and `es-ES.aff` or `en_US.dic` and `en_US.aff`).

### Where to download dictionaries?

You can download Hunspell dictionaries directly from the official LibreOffice repository:
👉 [LibreOffice Dictionaries Repository (GitHub)](https://github.com/LibreOffice/dictionaries/tree/master)

### How to install a downloaded language:

1. Go to your Obsidian Settings > **Hunspell Spellchecker**.
2. Scroll down to the **Installed Languages** section.
3. Click on the **Add Language** button.
4. Select both the `.aff` and `.dic` files you downloaded at the same time.
5. The plugin will securely copy them to its local storage, and the new language will be immediately available in your dropdown menu!

## ⚖️ License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.