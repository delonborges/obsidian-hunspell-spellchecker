import {App, Modal, TextAreaComponent} from "obsidian";

export class TextEditorModal extends Modal {
    content: string;
    onSave: (content: string) => Promise<void>;
    textArea: TextAreaComponent | null = null;
    title: string;

    constructor(app: App, title: string, content: string, onSave: (content: string) => Promise<void>) {
        super(app);
        this.title = title;
        this.content = content;
        this.onSave = onSave;
    }

    onOpen() {
        const {contentEl} = this;
        contentEl.empty();
        contentEl.createEl('h2', {text: this.title});

        this.textArea = new TextAreaComponent(contentEl)
            .setValue(this.content)
            .onChange((value) => {
                this.content = value;
            });

        this.textArea.inputEl.classList.add("hunspell-text-area");

        const buttonContainer = contentEl.createEl('div', {
            cls: 'hunspell-modal-buttons hunspell-modal-buttons-margin-m'
        });

        const cancelBtn = buttonContainer.createEl('button', {text: 'Cancel'});
        cancelBtn.addEventListener('click', () => this.close());

        const saveBtn = buttonContainer.createEl('button', {
            text: 'Save', cls: 'mod-cta'
        });
        saveBtn.addEventListener('click', () => {
            void this.onSave(this.content);
            this.close();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

export class ConfirmationModal extends Modal {
    title: string;
    message: string;
    onConfirm: () => void;

    constructor(app: App, title: string, message: string, onConfirm: () => void) {
        super(app);
        this.title = title;
        this.message = message;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const {contentEl} = this;
        contentEl.empty();

        contentEl.createEl('h2', {text: this.title});
        contentEl.createEl('p', {text: this.message});

        const buttonContainer = contentEl.createEl('div', {
            cls: 'hunspell-modal-buttons hunspell-modal-buttons-margin-l'
        });

        const cancelBtn = buttonContainer.createEl('button', {text: 'Cancel'});
        cancelBtn.addEventListener('click', () => this.close());

        const confirmBtn = buttonContainer.createEl('button', {
            text: 'Confirm', cls: 'mod-warning'
        });
        confirmBtn.addEventListener('click', () => {
            this.onConfirm();
            this.close();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}
