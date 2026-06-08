# Hunspell Spellchecker for Obsidian

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A high-performance, offline spellchecker for Obsidian using standard Hunspell `.aff` and `.dic` dictionary pairs. This plugin provides advanced
control over multiple languages, cross-platform stability (including Mobile support), and real-time word
suggestions—without ever sending your private notes to third-party servers.

## ✨ Features

- **High Performance on Mobile:** Specifically architected to avoid memory bloat. The spellchecking engine uses "on-the-fly" reverse affix evaluation, making it light enough to run smoothly on iOS and Android devices.
- **True Multi-Language Support:** Install as many dictionaries as you need. Includes seamless integration with the `Intl.DisplayNames` API to show native language names.
- **1-Click Dictionary Downloads:** Browse and install languages directly from the official LibreOffice repository from within the plugin settings.
- **Quick Swap Menu:** Change your active spellchecking language or quickly access settings directly from the Obsidian Status Bar at the bottom right.
- **Smart Tooltip & Context Menu:** Hover over or right-click on a misspelled word to see real-time suggestions (only on desktop).
- **Personal Dictionary & Ignored Words:**
    - Full control over your local dictionaries.
    - Edit your "Ignored Words" or "Custom Dictionary" directly inside Obsidian using a built-in text editor modal.

## 🌐 Getting Started & Adding Languages

To keep the plugin lightweight, it does not come with any languages pre-installed. 

To add a language:
1. Go to your Obsidian Settings > **Hunspell Spellchecker**.
2. Scroll down to the **Download Languages** section and click **Fetch available languages**.
3. The plugin will securely fetch the official list of languages from the open-source LibreOffice repository on GitHub.
4. Find your desired language in the list (e.g., *Portuguese (Brazil)* or *English (US)*) and click **Install**. 
5. The plugin will automatically download the correct `.aff` and `.dic` files and activate the language. 

You can now use the status bar menu at the bottom right to quickly swap between installed languages!

## ⚖️ License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.