import { randomUUID } from "crypto";

export interface HandlerRequest {
  library: string;
  functionName: string;
  /** onload, onsave, or onchange (with attribute). */
  event: "onload" | "onsave" | "onchange";
  attribute?: string;
  passExecutionContext: boolean;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const guid = () => `{${randomUUID()}}`;

/**
 * Adds a library (if missing) and an event handler (if not already there) to a form's
 * XML, keeping everything else as it is. Tab events (tabstatechange) live inside tabs and
 * aren't handled here.
 */
export function addHandler(formXml: string, h: HandlerRequest): { xml: string; changed: boolean; already: boolean } {
  let xml = formXml;
  let changed = false;

  // 1. The library, in <formLibraries>.
  const hasLibrary = new RegExp(`<Library\\b[^>]*\\bname="${reEsc(esc(h.library))}"`, "i").test(xml);
  if (!hasLibrary) {
    const lib = `<Library name="${esc(h.library)}" libraryUniqueId="${guid()}" />`;
    if (/<formLibraries\s*\/>/.test(xml)) xml = xml.replace(/<formLibraries\s*\/>/, `<formLibraries>${lib}</formLibraries>`);
    else if (/<formLibraries>/.test(xml)) xml = xml.replace(/<\/formLibraries>/, `${lib}</formLibraries>`);
    else xml = xml.replace(/<\/form>\s*$/, `<formLibraries>${lib}</formLibraries></form>`);
    changed = true;
  }

  // 2. The event, in the form-level <events> (not a tab's).
  const handler = `<Handler functionName="${esc(h.functionName)}" libraryName="${esc(h.library)}" handlerUniqueId="${guid()}" enabled="true" parameters="" passExecutionContext="${h.passExecutionContext}" />`;
  const formEvents = formLevelEvents(xml);
  const attrPart = h.event === "onchange" ? `[^>]*\\battribute="${reEsc(h.attribute ?? "")}"` : "";
  const eventRe = new RegExp(`<event\\b(?=[^>]*\\bname="${h.event}")${attrPart}[^>]*?(\\/?)>([\\s\\S]*?)(<\\/event>|$)`, "i");
  if (formEvents) {
    const inner = xml.slice(formEvents.innerStart, formEvents.innerEnd);
    const m = eventRe.exec(inner);
    if (m && m[1] !== "/") {
      const body = m[2];
      const exists = new RegExp(`<Handler\\b(?=[^>]*\\bfunctionName="${reEsc(esc(h.functionName))}")(?=[^>]*\\blibraryName="${reEsc(esc(h.library))}")`, "i").test(body);
      if (exists) return { xml, changed, already: true };
      const newBody = /<Handlers>/.test(body) ? body.replace(/<\/Handlers>/, `${handler}</Handlers>`) : /<Handlers\s*\/>/.test(body) ? body.replace(/<Handlers\s*\/>/, `<Handlers>${handler}</Handlers>`) : `<Handlers>${handler}</Handlers>${body}`;
      const start = formEvents.innerStart + m.index;
      const openTagEnd = start + m[0].indexOf(">") + 1;
      xml = xml.slice(0, openTagEnd) + newBody + xml.slice(openTagEnd + body.length);
      return { xml, changed: true, already: false };
    }
    const newEvent = eventXml(h, handler);
    if (m && m[1] === "/") {
      const start = formEvents.innerStart + m.index;
      xml = xml.slice(0, start) + newEvent + xml.slice(start + m[0].length - m[3].length);
    } else xml = xml.slice(0, formEvents.innerEnd) + newEvent + xml.slice(formEvents.innerEnd);
    return { xml, changed: true, already: false };
  }
  const events = `<events>${eventXml(h, handler)}</events>`;
  xml = /<formLibraries/.test(xml) ? xml.replace(/<formLibraries/, `${events}<formLibraries`) : xml.replace(/<\/form>\s*$/, `${events}</form>`);
  return { xml, changed: true, already: false };
}

function eventXml(h: HandlerRequest, handler: string): string {
  const attr = h.event === "onchange" ? ` attribute="${esc(h.attribute ?? "")}"` : "";
  return `<event name="${h.event}" application="false" active="false"${attr}><Handlers>${handler}</Handlers></event>`;
}

/** The form-level <events> element: the one that isn't inside a <tab>. */
function formLevelEvents(xml: string): { innerStart: number; innerEnd: number } | undefined {
  const re = /<events>([\s\S]*?)<\/events>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const before = xml.slice(0, m.index);
    const openTabs = (before.match(/<tab\b/g) ?? []).length - (before.match(/<\/tab>/g) ?? []).length;
    if (openTabs === 0) return { innerStart: m.index + "<events>".length, innerEnd: m.index + m[0].length - "</events>".length };
  }
  return undefined;
}
