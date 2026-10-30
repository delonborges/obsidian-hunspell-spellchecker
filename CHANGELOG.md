# Changelog

## [1.3.0]

### Added

- **Local Languages:** Add your own Hunspell dictionary from your computer in the plugin settings. Select the `.aff` and `.dic` files together; both must have
  the same base name (for example `en_US.aff` and `en_US.dic`). The new language is activated automatically, and you are asked before replacing an installed
  language with the same name.

### Changed

- Installed and downloadable languages now show readable names, generated with `Intl.DisplayNames` instead of raw dictionary codes.
- Language scanning, importing, and removal are now handled by a single internal `LanguageRegistry` (`src/languages.ts`).
- Remote language discovery now lists all compatible Hunspell variants from the LibreOffice dictionaries repository, including regional variants such as
  `es_ES`.
- Remote language metadata uses versioned cache invalidation while retaining the automatic fetch and network fallback behavior.

### Fixed

- Hunspell affix conditions with invalid character ranges (for example `[z-a]`) are escaped instead of causing an error.
- Hunspell affix conditions that are still not valid regular expressions now match any word and log a warning, instead of failing.
- Context-menu spellchecking now ignores multi-word selections instead of suggesting, ignoring, or adding the entire selection as one word.

## [1.2.1]

### Fixed

- Refactored UI components to use CSS classes instead of inline styles, adhering to Obsidian's best practices and resolving linter warnings.

## [1.2.0]

### Added

- **Interactive Status Bar:** The status bar now displays the active language and the number of misspelled words currently visible on your screen.
    - Click the active language to open the plugin settings.
    - Click the error count (🔴) to see a dropdown list of misspelled words. Click any word in the list to jump directly to it in your text.
- **Smart Capitalization:** The plugin now respects and preserves the original capitalization of words when you add them to your personal dictionary or ignored
  words list.
- **Pre-commit Hook:** Added a pre-commit hook to ensure version consistency across `package.json`, `manifest.json`, and `CHANGELOG.md`.

### Changed

- Refactored the codebase to separate responsibilities (UI, Editor logic, and Main plugin logic) into different files for better maintainability.

## [1.1.1]

### Added

- Initial public release optimizations and bug fixes.
