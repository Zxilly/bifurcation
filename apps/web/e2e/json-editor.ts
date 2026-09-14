import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

type MonacoEditor = {
  getRawOptions(): { ariaLabel?: string };
  getValue(): string;
  getModel(): { getFullModelRange(): unknown } | null;
  executeEdits(source: string, edits: { range: unknown; text: string }[]): boolean;
  focus(): void;
};
type MonacoWindow = Window & { monaco?: { editor: { getEditors(): MonacoEditor[] } } };

// Monaco keeps the document in its model, not in the accessible textbox, and
// typing into it triggers auto-closing pairs. Tests therefore address the
// editor instance that carries the field's label and replace the document
// through the same edit path the UI uses.
export function jsonEditor(page: Page, label: string) {
  const textbox = page.getByRole("textbox", { name: label, exact: true });
  const read = () =>
    page.evaluate((label) => {
      const editor = (window as MonacoWindow).monaco?.editor
        .getEditors()
        .find((candidate) => candidate.getRawOptions().ariaLabel === label);
      if (!editor) throw new Error(`No JSON editor labelled ${label}`);
      return editor.getValue();
    }, label);
  return {
    textbox,
    async value() {
      await textbox.waitFor({ state: "attached" });
      return read();
    },
    async fill(text: string) {
      await textbox.waitFor({ state: "attached" });
      await page.evaluate(
        ([label, text]) => {
          const editor = (window as MonacoWindow).monaco?.editor
            .getEditors()
            .find((candidate) => candidate.getRawOptions().ariaLabel === label);
          if (!editor) throw new Error(`No JSON editor labelled ${label}`);
          editor.focus();
          editor.executeEdits("e2e", [{ range: editor.getModel()!.getFullModelRange(), text }]);
        },
        [label, text] as const,
      );
      await expect.poll(read).toBe(text);
    },
  };
}
