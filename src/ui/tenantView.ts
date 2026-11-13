import * as vscode from "vscode";
import { accountInUse } from "./auth";
import { activeTenant } from "./tenantContext";

/**
 * The Tenant view at the top of the Lantern side bar, and the only place the
 * tenant is shown: which tenant, environment and account Lantern is using. Each
 * row's right-click has that row's actions (the tenant's configuration, the
 * environment's connection and publishing, signing in). Solutions and Environment
 * start straight at their contents and stay hidden until a tenant is selected.
 */

interface Row {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon: string;
  command: vscode.Command;
  contextValue?: string;
}

export class TenantView implements vscode.TreeDataProvider<Row> {
  private readonly changed = new vscode.EventEmitter<Row | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(row: Row): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.id = row.id;
    item.description = row.description;
    item.tooltip = row.tooltip;
    item.iconPath = new vscode.ThemeIcon(row.icon);
    item.command = row.command;
    item.contextValue = row.contextValue;
    return item;
  }

  getChildren(row?: Row): Row[] {
    if (row) return [];
    const t = activeTenant();
    // No tenant: no rows, so the view's welcome (Select Tenant, Add Tenant) shows instead.
    if (!t) return [];
    const rows: Row[] = [
      {
        id: "tenant",
        label: t.name,
        description: t.environments.length > 1 ? `${t.environments.length} environments` : undefined,
        tooltip: `Tenant ${t.name}. Click to switch tenants.`,
        icon: "organization",
        command: { command: "lantern.selectTenant", title: "Select Tenant" },
        contextValue: "tenantView.tenant",
      },
    ];
    if (t.config.org) {
      rows.push({
        id: "environment",
        label: t.envName || t.orgHost,
        description: [t.envName ? t.orgHost : "", t.isProtected ? "protected" : ""].filter(Boolean).join(" · ") || undefined,
        tooltip: `${t.envName ? `${t.envName}: ` : ""}${t.config.org}${t.isProtected ? "\nProtected: Lantern asks before changing anything here." : ""}\nClick to switch environments.`,
        icon: t.isProtected ? "shield" : "server-environment",
        command: { command: "lantern.environments.switch", title: "Switch Environment", arguments: [t] },
        contextValue: "tenantView.environment",
      });
      const account = accountInUse(t);
      rows.push({
        id: "account",
        label: account ? account.account : "Not signed in yet",
        description: account?.pinned ? "pinned" : undefined,
        tooltip: account ? `Signed in as ${account.account}${account.pinned ? " (pinned in the tenant configuration)" : ""}. Click to sign in as someone else.` : "Click to sign in.",
        icon: "account",
        command: { command: "lantern.signInAs", title: "Sign In As", arguments: [t] },
        contextValue: "tenantView.account",
      });
    } else {
      rows.push({
        id: "connect",
        label: "Set the Dataverse URL to connect",
        icon: "plug",
        command: { command: "lantern.openClientConfig", title: "Edit Tenant Configuration", arguments: [t] },
      });
    }
    return rows;
  }
}
