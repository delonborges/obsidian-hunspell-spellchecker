export interface Token {
    text: string;
    from: number;
    to: number;
}

const WORD_PATTERN = /[\p{L}\p{M}]+(?:['’.-][\p{L}\p{M}]+)*/gu;

export function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    WORD_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = WORD_PATTERN.exec(text)) !== null) {
        if (!/^\d+$/.test(match[0])) {
            tokens.push({
                text: match[0], from: match.index, to: match.index + match[0].length
            });
        }
    }

    return tokens;
}
