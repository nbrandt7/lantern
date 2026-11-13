import { openPanel, Problem, Status } from "./panel";

/**
 * The column picker for C# classes and script models as an editor tab: the
 * namespace, output folder and language above (only while they're not set yet),
 * then a searchable checklist of the table's columns, custom ones first, with
 * what's in the class or model and what's in the solution ticked.
 */

export interface ColumnItem {
  /** The logical name. */
  id: string;
  label: string;
  meta?: string;
  group: string;
  tags?: string[];
  picked: boolean;
  title?: string;
}

export interface PickerField {
  label: string;
  value: string;
  hint?: string;
  placeholder?: string;
  /** A regular expression the trimmed value has to match (when not empty). */
  pattern?: string;
  patternText?: string;
  required?: boolean;
  /** A select instead of a text box. */
  options?: Array<{ value: string; label: string; description?: string }>;
}

export interface ColumnPickerDraft {
  picked: string[];
  fields: Record<string, string>;
}

export interface ColumnPickerState {
  subtitle: string;
  table: { logical: string; label: string; primaryId: string };
  /** Fields above the list, by key (namespace, outDir, language). */
  fields: Record<string, PickerField>;
  items: ColumnItem[];
  /** Why things are ticked. */
  notes: string[];
  draft: ColumnPickerDraft;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function columnPickerProblems(d: ColumnPickerDraft, fields: Record<string, PickerField>): Problem[] {
  const problems: Problem[] = [];
  for (const [key, f] of Object.entries(fields)) {
    const v = (d.fields[key] ?? "").trim();
    if (!v && f.required) problems.push({ field: key, text: `Enter the ${f.label.toLowerCase()}.` });
    else if (v && f.pattern && !new RegExp(f.pattern).test(v)) problems.push({ field: key, text: f.patternText ?? `That isn't a valid ${f.label.toLowerCase()}.` });
  }
  return problems;
}

const BODY = `
<main class="single" id="main">
  <section class="form" id="form"></section>
</main>`;

const SCRIPT = `
  function build() {
    const form = document.getElementById("form");
    const parts = [];
    const keys = Object.keys(state.fields);
    if (keys.length) {
      parts.push(h("h2", {}, "Settings"), h("div", { class: "grid" }, ...keys.flatMap((key) => {
        const f = state.fields[key];
        const control = f.options
          ? select(key, draft.fields[key], f.options, (v) => { draft.fields[key] = v; changed(); })
          : text(key, draft.fields[key], { placeholder: f.placeholder, set: (v) => { draft.fields[key] = v; changed(); } });
        return field(f.label, control, { hint: f.hint });
      })));
    }
    const picked = new Set(draft.picked);
    const list = checklist(state.items, picked, { tall: true, placeholder: "Search columns by name, logical name or type", noneText: "none picked", onChange: () => { draft.picked = state.items.map((i) => i.id).filter((i) => picked.has(i)); changed(); } });
    parts.push(h("h2", {}, "Columns of " + state.table.label), h("p", { class: "note" }, state.table.primaryId + " is always included. " + state.notes.join(" ")), list);
    form.replaceChildren(...parts);
  }
`;

/** Opens the page. Resolves with the picked logical names and the fields on the primary button, undefined on Cancel. */
export function openColumnPicker(title: string, action: string, state: ColumnPickerState): Promise<ColumnPickerDraft | undefined> {
  const validate = (d: ColumnPickerDraft): Status => ({ problems: columnPickerProblems(d, state.fields), summary: `${plural(d.picked.length, "column")} picked` });
  return openPanel<ColumnPickerState, ColumnPickerDraft>({ viewType: "lantern.columns", title, subtitle: state.subtitle, state, body: BODY, script: SCRIPT, validate, action });
}
