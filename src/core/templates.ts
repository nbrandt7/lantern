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
  const full = `${o.namespace}.${o.entityPascal}`;

  return `// Form script for ${o.entity}.
// Register handlers on the form as ${full}.onLoad / ${full}.onSave
// and tick "Pass execution context as first parameter".

/** @type {Record<string, any>} */
var ${o.namespace} = ${o.namespace} || {};

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
