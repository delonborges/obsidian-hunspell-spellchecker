export interface DictionaryFiles {
    aff: string;
    dic: string;
}

interface AffixRule {
    flag: string;
    strip: string;
    add: string;
    condition: RegExp;
    crossProduct: boolean;
    type: "PFX" | "SFX";
}

interface ParsedAffixes {
    flagMode: "UTF-8" | "LONG" | "NUM" | "ASCII";
    prefixes: Map<string, AffixRule[]>;
    suffixes: Map<string, AffixRule[]>;
    ignoredChars: Set<string>;
    replacements: ReplacementRule[];
    maps: string[][];
    tryChars: string[];
}

interface ParsedWord {
    word: string;
    flags: string[];
}

interface ReplacementRule {
    from: string;
    to: string;
}

const WORD_SEPARATOR = "/";

export class HunspellDictionary {
    private readonly rootWords = new Map<string, string[]>();
    private readonly lowerRootWords = new Map<string, string[]>();
    private readonly affixes: ParsedAffixes;

    private readonly flatSuffixes: Array<{
        flag: string;
        rule: AffixRule
    }> = [];
    private readonly flatPrefixes: Array<{
        flag: string;
        rule: AffixRule
    }> = [];

    private constructor(affixes: ParsedAffixes) {
        this.affixes = affixes;
        for (const [flag, rules] of affixes.suffixes.entries()) {
            for (const rule of rules) {
                this.flatSuffixes.push({flag, rule});
            }
        }
        for (const [flag, rules] of affixes.prefixes.entries()) {
            for (const rule of rules) {
                this.flatPrefixes.push({flag, rule});
            }
        }
    }

    static async fromFiles(files: DictionaryFiles, onProgress?: (msg: string) => void): Promise<HunspellDictionary> {
        if (onProgress) onProgress("Parsing affixes...");
        const affixes = parseAffixes(files.aff);

        await new Promise(resolve => window.setTimeout(resolve, 0));

        if (onProgress) onProgress("Parsing dictionary file...");
        const parsedWords = parseDictionary(files.dic, affixes.flagMode);

        const dict = new HunspellDictionary(affixes);

        const CHUNK_SIZE = 5000;
        const total = parsedWords.length;

        for (let i = 0; i < total; i += CHUNK_SIZE) {
            if (onProgress && i % (CHUNK_SIZE * 3) === 0) {
                onProgress(`Loading roots... ${Math.round((i / total) * 100)}%`);
            }

            const chunk = parsedWords.slice(i, i + CHUNK_SIZE);
            for (const parsed of chunk) {
                dict.addRootWord(parsed);
            }

            await new Promise(resolve => window.setTimeout(resolve, 0));
        }

        if (onProgress) onProgress("Dictionary loaded");
        return dict;
    }

    has(word: string): boolean {
        const normalized = this.normalizeWord(word);
        if (!normalized) {
            return true;
        }

        if (this.rootWords.has(normalized) || this.lowerRootWords.has(normalized.toLocaleLowerCase())) {
            return true;
        }

        if (normalized.includes("-")) {
            return normalized.split("-").every((part) => this.has(part));
        }

        const lowerNormalized = normalized.toLocaleLowerCase();
        return this.checkAffixes(normalized) || this.checkAffixes(lowerNormalized);
    }

    suggest(word: string, limit = 8): string[] {
        const normalized = this.normalizeWord(word);
        if (!normalized || this.has(normalized)) {
            return [];
        }

        const candidates = new Set<string>();
        for (const candidate of this.buildReplacementCandidates(normalized)) {
            this.addSuggestionIfValid(candidates, candidate);
        }

        for (const candidate of this.buildMapCandidates(normalized)) {
            this.addSuggestionIfValid(candidates, candidate);
        }

        for (const candidate of this.buildEditCandidates(normalized)) {
            this.addSuggestionIfValid(candidates, candidate);
        }

        return Array.from(candidates)
            .sort((left, right) => this.scoreSuggestion(normalized, left) - this.scoreSuggestion(normalized, right))
            .slice(0, limit)
            .map((candidate) => applyOriginalCasing(word, candidate));
    }

    private addRootWord(parsed: ParsedWord): void {
        const normalized = this.normalizeWord(parsed.word);
        if (!normalized) return;

        this.rootWords.set(normalized, parsed.flags);
        this.lowerRootWords.set(normalized.toLocaleLowerCase(), parsed.flags);
    }

    private checkAffixes(word: string): boolean {
        const validSuffixes = [];
        for (let i = 0; i < this.flatSuffixes.length; i++) {
            const s = this.flatSuffixes[i];
            if (!s.rule.add || word.endsWith(s.rule.add)) {
                validSuffixes.push(s);
            }
        }

        const validPrefixes = [];
        for (let i = 0; i < this.flatPrefixes.length; i++) {
            const p = this.flatPrefixes[i];
            if (!p.rule.add || word.startsWith(p.rule.add)) {
                validPrefixes.push(p);
            }
        }

        for (let i = 0; i < validSuffixes.length; i++) {
            const {flag, rule} = validSuffixes[i];
            const candidateRoot = word.slice(0, word.length - rule.add.length) + rule.strip;
            if (this.hasRootWithFlag(candidateRoot, flag) && rule.condition.test(candidateRoot)) {
                return true;
            }
        }

        for (let i = 0; i < validPrefixes.length; i++) {
            const {flag, rule} = validPrefixes[i];
            const candidateRoot = rule.strip + word.slice(rule.add.length);
            if (this.hasRootWithFlag(candidateRoot, flag) && rule.condition.test(candidateRoot)) {
                return true;
            }
        }

        for (let i = 0; i < validSuffixes.length; i++) {
            const {flag: sFlag, rule: sRule} = validSuffixes[i];
            if (!sRule.crossProduct) continue;

            const prefixedWord = word.slice(0, word.length - sRule.add.length) + sRule.strip;

            for (let j = 0; j < validPrefixes.length; j++) {
                const {flag: pFlag, rule: pRule} = validPrefixes[j];
                if (!pRule.crossProduct) continue;
                if (pRule.add && !prefixedWord.startsWith(pRule.add)) continue;

                const candidateRoot = pRule.strip + prefixedWord.slice(pRule.add.length);

                if (this.hasRootWithFlag(candidateRoot, sFlag) && this.hasRootWithFlag(candidateRoot, pFlag)) {
                    if (pRule.condition.test(candidateRoot) && sRule.condition.test(prefixedWord)) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    private hasRootWithFlag(root: string, flag: string): boolean {
        const exactFlags = this.rootWords.get(root);
        if (exactFlags && exactFlags.includes(flag)) return true;

        const lower = root.toLocaleLowerCase();
        const lowerFlags = this.lowerRootWords.get(lower);
        return !!(lowerFlags && lowerFlags.includes(flag));

    }

    private addSuggestionIfValid(candidates: Set<string>, candidate: string): void {
        const normalized = this.normalizeWord(candidate);
        if (!normalized || normalized.length < 2) {
            return;
        }

        if (this.has(normalized)) {
            candidates.add(normalized);
        }
    }

    private buildReplacementCandidates(word: string): Set<string> {
        const candidates = new Set<string>();
        for (const replacement of this.affixes.replacements) {
            addStringReplacementCandidates(candidates, word, replacement.from, replacement.to);
            addStringReplacementCandidates(candidates, word, replacement.to, replacement.from);
        }
        return candidates;
    }

    private buildMapCandidates(word: string): Set<string> {
        const candidates = new Set<string>();
        const chars = Array.from(word);

        chars.forEach((char, index) => {
            const lowerChar = char.toLocaleLowerCase();
            const group = this.affixes.maps.find((item) => item.some((mapped) => mapped.toLocaleLowerCase() === lowerChar));
            if (!group) {
                return;
            }

            for (const mapped of group) {
                if (mapped === char) {
                    continue;
                }

                const next = [...chars];
                next[index] = preserveCharCasing(char, mapped);
                candidates.add(next.join(""));
            }
        });

        return candidates;
    }

    private buildEditCandidates(word: string): Set<string> {
        const candidates = new Set<string>();
        const chars = Array.from(word);
        const alphabet = this.affixes.tryChars.length ? this.affixes.tryChars : defaultTryChars();

        for (let index = 0; index <= chars.length; index += 1) {
            for (const char of alphabet) {
                candidates.add([...chars.slice(0, index), char, ...chars.slice(index)].join(""));
            }
        }

        for (let index = 0; index < chars.length; index += 1) {
            candidates.add([...chars.slice(0, index), ...chars.slice(index + 1)].join(""));

            for (const char of alphabet) {
                if (char !== chars[index]) {
                    candidates.add([...chars.slice(0, index), char, ...chars.slice(index + 1)].join(""));
                }
            }

            if (index < chars.length - 1) {
                candidates.add([...chars.slice(0, index), chars[index + 1], chars[index], ...chars.slice(index + 2)].join(""));
            }
        }

        return candidates;
    }

    private scoreSuggestion(word: string, candidate: string): number {
        const lowerWord = word.toLocaleLowerCase();
        const lowerCandidate = candidate.toLocaleLowerCase();
        const distance = boundedLevenshteinDistance(lowerWord, lowerCandidate, 4);
        const lengthPenalty = Math.abs(Array.from(lowerWord).length - Array.from(lowerCandidate).length) * 0.25;
        const prefixBonus = lowerCandidate.startsWith(lowerWord[0] ?? "") ? -0.2 : 0;
        return distance + lengthPenalty + prefixBonus;
    }

    private normalizeWord(word: string): string {
        let normalized = word.trim();
        for (const ignored of this.affixes.ignoredChars) {
            normalized = normalized.split(ignored).join("");
        }
        return normalized;
    }
}

export function parseAffixes(source: string): ParsedAffixes {
    const prefixes = new Map<string, AffixRule[]>();
    const suffixes = new Map<string, AffixRule[]>();
    const ignoredChars = new Set<string>();
    const replacements: ReplacementRule[] = [];
    const maps: string[][] = [];
    let tryChars: string[] = [];
    let flagMode: ParsedAffixes["flagMode"] = "ASCII";
    const lines = source.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
        const line = cleanLine(lines[index]);
        if (!line) {
            continue;
        }

        const parts = line.split(/\s+/);
        if (parts[0] === "FLAG" && parts[1]) {
            flagMode = parts[1] as ParsedAffixes["flagMode"];
            continue;
        }

        if (parts[0] === "TRY" && parts[1]) {
            tryChars = Array.from(parts[1]);
            continue;
        }

        if (parts[0] === "MAP" && parts.length === 2 && !/^\d+$/.test(parts[1])) {
            maps.push(Array.from(parts[1]));
            continue;
        }

        if (parts[0] === "REP" && parts.length >= 3 && !/^\d+$/.test(parts[1])) {
            replacements.push({
                from: unescapeAffixPattern(parts[1]), to: unescapeAffixPattern(parts[2])
            });
            continue;
        }

        if (parts[0] === "IGNORE" && parts[1]) {
            for (const char of Array.from(parts[1])) {
                ignoredChars.add(char);
            }
            continue;
        }

        if ((parts[0] === "PFX" || parts[0] === "SFX") && parts.length >= 4 && /^\d+$/.test(parts[3])) {
            const type = parts[0] as AffixRule["type"];
            const flag = parts[1];
            const crossProduct = parts[2] === "Y";
            const count = Number(parts[3]);
            const target = type === "PFX" ? prefixes : suffixes;
            const rules = target.get(flag) ?? [];

            for (let offset = 1; offset <= count && index + offset < lines.length; offset += 1) {
                const ruleLine = cleanLine(lines[index + offset]);
                const ruleParts = ruleLine.split(/\s+/);
                if (ruleParts[0] !== type || ruleParts[1] !== flag || ruleParts.length < 5) {
                    continue;
                }

                rules.push({
                    flag, type, crossProduct, strip: ruleParts[2] === "0" ? "" : unescapeHunspellValue(ruleParts[2]), add: stripAffixFlags(ruleParts[3] === "0" ? "" : unescapeHunspellValue(ruleParts[3])), condition: conditionToRegExp(ruleParts[4], type)
                });
            }

            target.set(flag, rules);
            index += count;
        }
    }

    return {flagMode, prefixes, suffixes, ignoredChars, replacements, maps, tryChars};
}

export function parseDictionary(source: string, flagMode: ParsedAffixes["flagMode"]): ParsedWord[] {
    const lines = source.split(/\r?\n/);
    const words: ParsedWord[] = [];
    const start = /^\d+$/.test(lines[0]?.trim() ?? "") ? 1 : 0;

    for (let index = start; index < lines.length; index += 1) {
        const line = cleanLine(lines[index]);
        if (!line) {
            continue;
        }

        const separatorIndex = findFlagSeparator(line);
        if (separatorIndex === -1) {
            words.push({word: line, flags: []});
            continue;
        }

        const word = line.slice(0, separatorIndex);
        const rawFlags = line.slice(separatorIndex + WORD_SEPARATOR.length).split(/\s+/)[0] ?? "";
        words.push({word, flags: parseFlags(rawFlags, flagMode)});
    }

    return words;
}

function parseFlags(flags: string, mode: ParsedAffixes["flagMode"]): string[] {
    if (!flags) {
        return [];
    }

    if (mode === "UTF-8" || mode === "ASCII") {
        return Array.from(flags);
    }

    if (mode === "LONG") {
        return flags.match(/.{1,2}/g) ?? [];
    }

    return flags.split(",");
}

function conditionToRegExp(condition: string, type: AffixRule["type"]): RegExp {
    const normalized = condition === "." ? ".*" : condition;
    return new RegExp(type === "SFX" ? `${normalized}$` : `^${normalized}`, "u");
}

function stripAffixFlags(value: string): string {
    const separatorIndex = value.indexOf(WORD_SEPARATOR);
    return separatorIndex === -1 ? value : value.slice(0, separatorIndex);
}

function findFlagSeparator(line: string): number {
    for (let index = 1; index < line.length; index += 1) {
        if (line[index] === WORD_SEPARATOR && line[index - 1] !== "\\") {
            return index;
        }
    }

    return -1;
}

function cleanLine(line: string | undefined): string {
    if (!line) {
        return "";
    }

    return line.replace(/\s+#.*$/, "").trim();
}

function unescapeHunspellValue(value: string): string {
    return value.replace(/\\\//g, WORD_SEPARATOR);
}

function unescapeAffixPattern(value: string): string {
    return value.replace(/_/g, " ").replace(/\\\//g, WORD_SEPARATOR);
}

function addStringReplacementCandidates(candidates: Set<string>, word: string, from: string, to: string): void {
    if (!from || !word.includes(from)) {
        return;
    }

    let index = word.indexOf(from);
    while (index !== -1) {
        candidates.add(`${word.slice(0, index)}${to}${word.slice(index + from.length)}`);
        index = word.indexOf(from, index + 1);
    }
}

function defaultTryChars(): string[] {
    return Array.from("abcdefghijklmnopqrstuvwxyzáàãâéêíóõôúüç");
}

function applyOriginalCasing(original: string, suggestion: string): string {
    if (/^[A-ZÁÀÂÃÉÊÍÓÔÕÚÜÇ]+$/u.test(original)) {
        return suggestion.toLocaleUpperCase();
    }

    if (/^[A-ZÁÀÂÃÉÊÍÓÔÕÚÜÇ]/u.test(original)) {
        const chars = Array.from(suggestion);
        return `${chars[0]?.toLocaleUpperCase() ?? ""}${chars.slice(1).join("")}`;
    }

    return suggestion;
}

function preserveCharCasing(original: string, replacement: string): string {
    return original === original.toLocaleUpperCase() ? replacement.toLocaleUpperCase() : replacement.toLocaleLowerCase();
}

export function boundedLevenshteinDistance(left: string, right: string, maxDistance: number): number {
    const leftChars = Array.from(left);
    const rightChars = Array.from(right);

    if (Math.abs(leftChars.length - rightChars.length) > maxDistance) {
        return maxDistance + 1;
    }

    const previous = Array.from({length: rightChars.length + 1}, (_, index) => index);
    const current = new Array<number>(rightChars.length + 1);

    for (let leftIndex = 1; leftIndex <= leftChars.length; leftIndex += 1) {
        current[0] = leftIndex;
        let colMin = current[0];

        for (let rightIndex = 1; rightIndex <= rightChars.length; rightIndex += 1) {
            const substitutionCost = leftChars[leftIndex - 1] === rightChars[rightIndex - 1] ? 0 : 1;
            current[rightIndex] = Math.min(previous[rightIndex] + 1, current[rightIndex - 1] + 1, previous[rightIndex - 1] + substitutionCost);
            colMin = Math.min(colMin, current[rightIndex]);
        }

        if (colMin > maxDistance) {
            return maxDistance + 1;
        }

        for (let index = 0; index < previous.length; index += 1) {
            previous[index] = current[index];
        }
    }

    return previous[rightChars.length];
}