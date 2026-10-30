# Hunspell Spellchecker for Obsidian

A high-performance, offline spellchecker for Obsidian using standard Hunspell dictionaries (`.aff` and `.dic` files).

## Features

- **Offline by Design:** All spellchecking happens locally on your device. No data is ever sent to external servers.
- **Multiple Languages:** Download and manage multiple language dictionaries directly within the plugin settings.
- **Local Dictionaries:** Add your own Hunspell `.aff` and `.dic` dictionary from your computer. See [Local dictionaries](#local-dictionaries).
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

To download a dictionary, follow these steps. To add one from your computer instead, see [Local dictionaries](#local-dictionaries).

1. Open the plugin settings.
2. Scroll to **Download Languages** and click "Fetch available languages".
3. Find your desired language in the list and click **Install**.
4. Once installed, select it from the **Active language** dropdown at the top.
5. Misspelled words will now have a red squiggly line underneath them.
6. Right-click a misspelled word to see suggestions, add it to your dictionary, or ignore it.

## Local dictionaries

If a language is not available in the GitHub list, you can add your own Hunspell dictionary from your computer:

1. Open the plugin settings.
2. Scroll to **Local Languages** and click **Add local language**.
3. Select the `.aff` and `.dic` files of the dictionary together.
4. The language is installed, becomes the active language, and is listed under **Installed Languages**.

For example, to add English (US), select `en_US.aff` and `en_US.dic`. The language identifier is taken from the file name, so both files must follow these
rules:

- Exactly one `.aff` file and one `.dic` file must be selected.
- Both files must have the same base name, and it is case-sensitive: `en_US.aff` with `en_US.dic` is accepted, while `en_US.aff` with `en_us.dic` is rejected.
- The base name may only contain letters, numbers, `_` and `-`. Spaces and dots are not allowed.

If a language with the same name is already installed, you will be asked to confirm before its files are replaced. To remove a local language, use the ✕ button
next to it in **Installed Languages**.

## Contributing

Contributions, issues, and feature requests are welcome!

## License

MIT License

### Diagnostic log

Remote fetches, cache use, downloads, and installations are recorded as JSON Lines in `logs/hunspell-spellchecker.log` inside the plugin folder. Each entry
includes an ISO timestamp, level, action, context, and serialized error details when applicable. The file is rotated at approximately 512 KB; it can be removed
manually or when the plugin is disabled.

Remote language discovery uses GitHub's recursive Git Trees API to reduce requests. If that response is unavailable or truncated, the plugin falls back to the
Contents API. GitHub's anonymous API has rate limits; when a refresh cannot be completed, the last valid cached list remains available, and the settings page
recommends trying again later. A `403` may indicate a rate limit or temporary block, rather than a missing dictionary.
