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

        this.textArea.inputEl.style.width = '100%';
        this.textArea.inputEl.style.minHeight = '300px';
        this.textArea.inputEl.style.resize = 'vertical';

        const buttonContainer = contentEl.createEl('div', {
            attr: {style: 'display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px;'}
        });

        const cancelBtn = buttonContainer.createEl('button', {text: 'Cancel'});
        cancelBtn.addEventListener('click', () => this.close());

        const saveBtn = buttonContainer.createEl('button', {
            text: 'Save', cls: 'mod-cta'
        });
        saveBtn.addEventListener('click', async () => {
            await this.onSave(this.content);
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
            attr: {style: 'display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px;'}
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
