# Changelog

## [1.2.1]

### Fixed
- Refactored UI components to use CSS classes instead of inline styles, adhering to Obsidian's best practices and resolving linter warnings.

## [1.2.0]

### Added
- **Interactive Status Bar:** The status bar now displays the active language and the number of misspelled words currently visible on your screen.
  - Click the active language to open the plugin settings.
  - Click the error count (🔴) to see a dropdown list of misspelled words. Click any word in the list to jump directly to it in your text.
- **Smart Capitalization:** The plugin now respects and preserves the original capitalization of words when you add them to your personal dictionary or ignored words list.
- **Pre-commit Hook:** Added a pre-commit hook to ensure version consistency across `package.json`, `manifest.json`, and `CHANGELOG.md`.

### Changed
- Refactored the codebase to separate responsibilities (UI, Editor logic, and Main plugin logic) into different files for better maintainability.

## [1.1.1]

### Added
- Initial public release optimizations and bug fixes.
