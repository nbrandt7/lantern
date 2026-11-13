import * as vscode from "vscode";
import { normalizeOrg } from "../core/clients";
import { activeTenant, addTenant, availableTenants, selectTenant, tenantMode, unreadableTenantFile } from "../ui/tenantContext";

export async function selectTenantCommand(onChange: () => void): Promise<void> {
  const tenants = availableTenants();
  if (!tenants.length) {
    // An empty list from a file that doesn't parse isn't "no tenants": point at the file instead.
    const problem = unreadableTenantFile();
    if (problem) {
      const open = await vscode.window.showWarningMessage(`Lantern couldn't read its tenant list in ${problem.file}: ${problem.message}`, "Open File");
      if (open) await vscode.window.showTextDocument(vscode.Uri.file(problem.file));
      return;
    }
    void vscode.window.showInformationMessage("No tenants are configured. Use Lantern: Add Tenant to add one.");
    return;
  }
  const current = activeTenant();
  const pick = await vscode.window.showQuickPick(
    tenants.map((tenant) => ({
      label: tenant.name,
      description: [tenant.orgHost, tenant.envName].filter(Boolean).join(" · "),
      detail: tenant.config.org || "No Dataverse URL set",
      tenant,
      picked: tenant.name === current?.name && tenant.configFile === current.configFile,
    })),
    { title: "Select Tenant", placeHolder: "Choose the tenant Lantern should use" }
  );
  if (!pick) return;
  selectTenant(pick.tenant);
  onChange();
}

export async function addTenantCommand(onChange: () => void): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: "Add Tenant (1/4)",
    prompt: "Name shown in Lantern",
    ignoreFocusOut: true,
    validateInput: (value) => !value.trim() ? "Enter a tenant name." : availableTenants().some((t) => t.name.toLowerCase() === value.trim().toLowerCase()) ? "A tenant with this name already exists." : undefined,
  });
  if (!name) return;
  const org = await vscode.window.showInputBox({
    title: "Add Tenant (2/4)",
    prompt: "Dataverse environment URL",
    placeHolder: "https://contoso.crm.dynamics.com",
    ignoreFocusOut: true,
    validateInput: (value) => { try { return new URL(normalizeOrg(value)).protocol === "https:" ? undefined : "Enter an HTTPS URL."; } catch { return "Enter a valid URL."; } },
  });
  if (org === undefined) return;
  const directory = await vscode.window.showInputBox({
    title: "Add Tenant (3/4)",
    prompt: "Microsoft Entra tenant ID or domain (optional)",
    placeHolder: "contoso.onmicrosoft.com",
    ignoreFocusOut: true,
  });
  if (directory === undefined) return;
  const solutions = await vscode.window.showInputBox({
    title: "Add Tenant (4/4)",
    prompt: "Solution unique names, separated by commas (optional)",
    ignoreFocusOut: true,
  });
  if (solutions === undefined) return;
  const tenant = addTenant(name.trim(), {
    org: normalizeOrg(org), tenant: directory.trim(),
    solutions: solutions.split(",").map((value) => value.trim()).filter(Boolean),
  });
  onChange();
  const location = tenantMode() === "global" ? "Lantern's global tenant list" : ".lantern/config.json";
  const choice = await vscode.window.showInformationMessage(`${tenant.name} was added to ${location}.`, "Edit Configuration");
  if (choice === "Edit Configuration") await vscode.window.showTextDocument(vscode.Uri.file(tenant.configFile));
}
