import * as vscode from "vscode";
import { DataverseClient } from "../core/dataverse";
import { dataverseFor } from "../ui/auth";
import { confirmProtected, resolveClient, withProgress } from "../ui/context";

interface User {
  systemuserid: string;
  fullname: string;
  domainname: string;
}

interface Setting {
  label: string;
  column: string;
  /** Choices to pick from, with how to label a stored value. */
  options: (dv: DataverseClient) => Promise<Array<{ label: string; value: number | boolean }>>;
}

const LANGUAGES: Record<number, string> = {
  1025: "Arabic", 1028: "Chinese (Traditional)", 1029: "Czech", 1030: "Danish", 1031: "German", 1032: "Greek", 1033: "English",
  1035: "Finnish", 1036: "French", 1037: "Hebrew", 1038: "Hungarian", 1040: "Italian", 1041: "Japanese", 1042: "Korean",
  1043: "Dutch", 1044: "Norwegian", 1045: "Polish", 1046: "Portuguese (Brazil)", 1049: "Russian", 1053: "Swedish",
  1055: "Turkish", 2052: "Chinese (Simplified)", 2070: "Portuguese (Portugal)", 3082: "Spanish",
};

async function languages(dv: DataverseClient): Promise<Array<{ label: string; value: number }>> {
  const r = await dv.getJson<{ RetrieveProvisionedLanguages: number[] }>("RetrieveProvisionedLanguages()");
  return r.RetrieveProvisionedLanguages.map((lcid) => ({ label: `${LANGUAGES[lcid] ?? "Language"} (${lcid})`, value: lcid }));
}

const SETTINGS: Setting[] = [
  {
    label: "Time zone",
    column: "timezonecode",
    options: async (dv) => {
      const rows = await dv.getAll<{ timezonecode: number; userinterfacename: string }>(
        "timezonedefinitions?$select=timezonecode,userinterfacename&$orderby=userinterfacename"
      );
      return rows.map((r) => ({ label: r.userinterfacename, value: r.timezonecode }));
    },
  },
  {
    label: "Records per page",
    column: "paginglimit",
    options: async () => [25, 50, 75, 100, 250].map((n) => ({ label: String(n), value: n })),
  },
  { label: "Display language", column: "uilanguageid", options: languages },
  { label: "Help language", column: "helplanguageid", options: languages },
  {
    label: "Show week numbers in calendars",
    column: "showweeknumber",
    options: async () => [{ label: "Yes", value: true }, { label: "No", value: false }],
  },
];

/**
 * Changes personal settings (time zone, page size, language...) for one or more users,
 * like XrmToolBox's User Settings Utility. Shows current values before asking for
 * the new one, and confirms before saving.
 */
export async function editUserSettings(arg?: unknown): Promise<void> {
  const client = await resolveClient(arg);
  if (!client?.config.org || !(await confirmProtected(client, "Change user settings"))) return;
  const dv = dataverseFor(client);

  const users = await withProgress(`Loading users from ${client.orgHost}`, () =>
    dv.getAll<User>(
      "systemusers?$select=systemuserid,fullname,domainname&$filter=isdisabled eq false and accessmode ne 4 and applicationid eq null&$orderby=fullname"
    )
  );
  if (!users) return;
  const picked = await vscode.window.showQuickPick(
    users.map((u) => ({ label: u.fullname, description: u.domainname, user: u })),
    { canPickMany: true, placeHolder: "Which users? (type to filter, space to select)", matchOnDescription: true }
  );
  if (!picked?.length) return;
  const chosen: User[] = picked.map((p: { user: User }) => p.user);

  const setting = await vscode.window.showQuickPick(SETTINGS.map((s) => ({ label: s.label, setting: s })), { placeHolder: "Which setting?" });
  if (!setting) return;
  const s: Setting = setting.setting;

  const loaded = await withProgress(`Reading current ${s.label.toLowerCase()}`, async () => {
    const options = await s.options(dv);
    const current = await Promise.all(
      chosen.map((u) => dv.getJson<Record<string, unknown>>(`usersettingscollection(${u.systemuserid})?$select=${s.column}`).then((r) => r[s.column]))
    );
    return { options, current };
  });
  if (!loaded) return;
  const labelOf = (v: unknown) => loaded.options.find((o) => o.value === v)?.label ?? String(v);
  const counts = new Map<string, number>();
  for (const v of loaded.current) counts.set(labelOf(v), (counts.get(labelOf(v)) ?? 0) + 1);
  const now = [...counts].map(([label, n]) => (chosen.length === 1 ? label : `${label} (${n})`)).join(", ");

  const value = await vscode.window.showQuickPick(
    loaded.options.map((o) => ({ label: o.label, option: o })),
    { placeHolder: `New ${s.label.toLowerCase()}. Currently: ${now}` }
  );
  if (!value) return;

  const who = chosen.length === 1 ? chosen[0].fullname : `${chosen.length} users`;
  const confirm = await vscode.window.showWarningMessage(`Set ${s.label.toLowerCase()} to ${value.option.label} for ${who}?`, { modal: true }, "Update");
  if (!confirm) return;

  const failures: string[] = [];
  await withProgress(`Updating ${who}`, async (_ctx, progress) => {
    for (const [i, u] of chosen.entries()) {
      progress.report({ message: `${i + 1} of ${chosen.length}` });
      try {
        await dv.update(`usersettingscollection(${u.systemuserid})`, { [s.column]: value.option.value });
      } catch (err) {
        failures.push(`${u.fullname}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
  if (failures.length) {
    void vscode.window.showErrorMessage(`Updated ${chosen.length - failures.length} of ${chosen.length}. ${failures.join(" ")}`);
  } else {
    void vscode.window.showInformationMessage(`Updated ${s.label.toLowerCase()} for ${who}. Users see it after they refresh.`);
  }
}
