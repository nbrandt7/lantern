export interface FormScriptOptions {
  /** Root namespace, e.g. "Acme". */
  namespace: string;
  /** Table logical name, e.g. "account". */
  entity: string;
  /** PascalCase name used under the namespace, e.g. "Account". */
  entityPascal: string;
  /** XrmDefinitelyTyped form type, e.g. "Form.account.Main.Information". Generic typing when omitted. */
  formType?: string;
}

/**
 * A form script registered in Dataverse as <Namespace>.<Entity>.onLoad / onSave,
 * with JSDoc annotations so checkJs gives full IntelliSense.
 */
export function formScript(o: FormScriptOptions): string {
  const ctxType = o.formType ? "Xrm.ExecutionContext<any, any>" : "Xrm.Events.EventContext";
  const formContext = o.formType
    ? `    /** @type {${o.formType}} */\n    const formContext = executionContext.getFormContext();`
    : `    const formContext = executionContext.getFormContext();`;
  // Each part has to be an identifier ("365Retail" isn't) and declared in turn ("var Contoso.Sales" doesn't parse).
  const parts = o.namespace
    .split(".")
    .filter(Boolean)
    .map((part) => part.replace(/[^$\p{ID_Continue}]/gu, "_"))
    .map((part) => (/^[$_\p{ID_Start}]/u.test(part) ? part : `_${part}`));
  const nested = parts.slice(1).map((_, i) => parts.slice(0, i + 2).join("."));
  const full = `${parts.join(".")}.${o.entityPascal}`;

  return `// Form script for ${o.entity}.
// Register handlers on the form as ${full}.onLoad / ${full}.onSave
// and tick "Pass execution context as first parameter".

/** @type {Record<string, any>} */
var ${parts[0]} = ${parts[0]} || {};
${nested.map((n) => `${n} = ${n} || {};\n`).join("")}
${full} = (function () {
  "use strict";

  /** @param {${ctxType}} executionContext */
  function onLoad(executionContext) {
${formContext}
  }

  /** @param {${ctxType}} executionContext */
  function onSave(executionContext) {
${formContext}
  }

  return { onLoad: onLoad, onSave: onSave };
})();
`;
}
