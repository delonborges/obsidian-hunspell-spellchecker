# Hunspell Spellchecker for Obsidian

A high-performance, offline spellchecker for Obsidian using standard Hunspell dictionaries (`.aff` and `.dic` files).

## Features

- **Offline by Design:** All spellchecking happens locally on your device. No data is ever sent to external servers.
- **Multiple Languages:** Download and manage multiple language dictionaries directly within the plugin settings.
- **Performance:** Optimized to run smoothly even on large documents without causing typing lag.
- **Personal Dictionary:** Add custom words via right-click to prevent them from being flagged in the future.
- **Ignored Words:** Temporarily ignore words within your vault.
- **Smart Capitalization:** The plugin now respects the original capitalization of words added to your personal dictionary or ignored words list.
- **Interactive Status Bar:** 
  - Quickly see the active language.
  - View the number of misspelled words currently visible on your screen.
  - Click the active language to open settings.
  - Click the error count (🔴) to see a dropdown list of misspelled words. Click any word in the list to jump directly to it in your text!

## Installation

### From Obsidian Community Plugins

1. Open Obsidian Settings.
2. Go to **Community plugins** and turn off "Safe mode".
3. Click **Browse** and search for "Hunspell Spellchecker".
4. Install and enable the plugin.

### Manual Installation

1. Download the latest release from the [Releases](https://github.com/delonborges/obsidian-hunspell-spellchecker/releases) page.
2. Extract the contents (`main.js`, `manifest.json`, `styles.css`) into your vault's `.obsidian/plugins/obsidian-hunspell-spellchecker` folder.
3. Reload Obsidian and enable the plugin in Settings > Community plugins.

## Usage

1. Open the plugin settings.
2. Scroll to **Download Languages** and click "Fetch available languages".
3. Find your desired language in the list and click **Install**.
4. Once installed, select it from the **Active language** dropdown at the top.
5. Misspelled words will now have a red squiggly line underneath them.
6. Right-click a misspelled word to see suggestions, add it to your dictionary, or ignore it.

## Contributing

Contributions, issues, and feature requests are welcome!

## License

MIT License
