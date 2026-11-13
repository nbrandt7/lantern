import * as vscode from "vscode";
import { createHash } from "crypto";
import { Client } from "../core/clients";
import { DataverseClient } from "../core/dataverse";
import { UserError } from "../core/errors";
import { run } from "../core/process";
import { settings } from "./context";

const cache = new Map<string, { token: string; expires: number }>();

/** VS Code's secret storage, where app registration secrets are kept (never in .lantern/config.json). */
interface Secrets {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}
let secrets: Secrets | undefined;
export function useSecrets(s: Secrets): void {
  secrets = s;
}
const oldSecretKey = (client: Client) => `lantern.appSecret.${client.name}.${client.envName || "default"}.${client.config.appId}`;
const hashedSecretKey = (identity: string) => `lantern.appSecret.${createHash("sha256").update(identity).digest("hex")}`;
/** Not keyed on the environment's name, which Add Environment gives a single org and people rename. */
const secretKey = (client: Client) => hashedSecretKey(`${client.config.org}|${client.config.tenant}|${client.config.appId}`);
/** Where earlier versions kept the secret: per environment name ("" before the org had one), then per tenant name. */
const earlierSecretKeys = (client: Client) => [
  ...new Set([client.envName, ""].map((env) => hashedSecretKey(`${client.config.org}|${client.config.tenant}|${env}|${client.config.appId}`))),
  oldSecretKey(client),
];
export async function appSecret(client: Client): Promise<string | undefined> {
  if (!client.config.appId || !secrets) return undefined;
  const secret = await secrets.get(secretKey(client));
  if (secret !== undefined) return secret;
  for (const key of earlierSecretKeys(client)) {
    const earlier = await secrets.get(key);
    if (earlier === undefined) continue;
    // Moved to the current key, so renaming the environment later can't lose it.
    await secrets.store(secretKey(client), earlier);
    return earlier;
  }
  return undefined;
}
export async function storeAppSecret(client: Client, secret: string): Promise<void> {
  if (!secrets) throw new UserError("VS Code's secret storage isn't available.");
  await secrets.store(secretKey(client), secret);
}

/** Token for an app registration, with the client credentials flow. */
async function appToken(client: Client): Promise<{ token: string; expires: number }> {
  const { appId, tenant, org } = client.config;
  if (!tenant) throw new UserError(`${client.name} signs in with an app registration, which needs an Entra tenant ID in its configuration.`);
  const secret = await appSecret(client);
  if (!secret) throw new UserError(`There's no secret stored for app ${appId} on ${client.name}. Use "Sign In As…" to enter it again.`);
  let response: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: appId, client_secret: secret, scope: `${org}/.default`, grant_type: "client_credentials" }).toString(),
    });
  } catch {
    throw new UserError("Couldn't reach login.microsoftonline.com to sign in with the app registration.");
  }
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !body.access_token) {
    throw new UserError(`The app registration couldn't sign in: ${(body.error_description ?? `HTTP ${response.status}`).split("\r\n")[0]}`);
  }
  return { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
}
/** The Microsoft account each client actually signed in with, for the tree and Environment. */
const signedIn = new Map<string, string>();
const signInListeners = new Set<() => void>();

/** Called whenever the account a client is signed in with changes (signed in, switched, forgotten). */
export function onSignInChanged(listener: () => void): vscode.Disposable {
  signInListeners.add(listener);
  return { dispose: () => signInListeners.delete(listener) };
}

function setSignedIn(key: string, account: string | undefined): void {
  if (signedIn.get(key) === account) return;
  if (account === undefined) signedIn.delete(key);
  else signedIn.set(key, account);
  for (const l of signInListeners) l();
}

interface AccountInfo {
  id: string;
  label: string;
}

/**
 * Account selection in VS Code's auth API (getAccounts plus getSession's "account" option).
 * Typed loosely so the extension builds against older @types/vscode; on a VS Code without it,
 * a pinned account is checked after sign-in instead of requested up front.
 */
type AccountAwareAuth = {
  getAccounts?: (providerId: string) => PromiseLike<readonly AccountInfo[]>;
  getSession(providerId: string, scopes: readonly string[], options: Record<string, unknown>): PromiseLike<vscode.AuthenticationSession | undefined>;
};
const auth = (): AccountAwareAuth => vscode.authentication as unknown as AccountAwareAuth;

export async function microsoftAccounts(): Promise<readonly AccountInfo[]> {
  const a = auth();
  return a.getAccounts ? a.getAccounts("microsoft") : [];
}

const sameAccount = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function scopesFor(client: Client): string[] {
  const scopes = [`${client.config.org}/user_impersonation`];
  if (client.config.tenant) scopes.push(`VSCODE_TENANT:${client.config.tenant}`);
  return scopes;
}

/** The account a client signs in with: pinned in .lantern/config.json, or whatever it last used. */
export function accountInUse(client: Client): { account: string; pinned: boolean } | undefined {
  if (client.config.appId) return { account: `app ${client.config.appId}`, pinned: true };
  if (client.config.account) return { account: client.config.account, pinned: true };
  const last = signedIn.get(`${client.name}@${client.orgHost}`);
  return last ? { account: last, pinned: false } : undefined;
}

/**
 * Access token for a client's org.
 *  - "vscode": VS Code's built-in Microsoft account sign-in. When .lantern/config.json pins an
 *    "account", that account is always used for this client, whatever other clients use.
 *  - "azureCli": "az account get-access-token", picked per tenant (.lantern/config.json "tenant").
 * silent: never prompt. Used by editor features (completions, hovers) that run while you
 * type; they quietly do nothing until you've signed in some other way.
 */
export async function getToken(client: Client, options: { silent?: boolean; fresh?: boolean } = {}): Promise<string> {
  const { authMethod, azPath } = settings();
  const pinned = client.config.account;
  // Per account (or app registration), so one client never reuses another client's token.
  const key = `${client.config.appId ? `app:${client.config.appId}` : authMethod}|${client.config.org}|${client.config.tenant}|${pinned.toLowerCase()}`;
  const hit = cache.get(key);
  // fresh: Dataverse rejected the cached token, so don't hand it out again.
  if (options.fresh) cache.delete(key);
  else if (hit && hit.expires > Date.now() + 60_000) return hit.token;

  let token: string;
  let expires = Date.now() + 45 * 60_000;
  if (client.config.appId) {
    ({ token, expires } = await appToken(client));
  } else if (authMethod === "azureCli") {
    const args = ["account", "get-access-token", "--resource", client.config.org, "--query", "accessToken", "-o", "tsv"];
    if (client.config.tenant) args.push("--tenant", client.config.tenant);
    const r = await run(azPath, args);
    if (r.missing) throw new UserError("Azure CLI (az) isn't installed. Install it or switch lantern.authMethod to \"vscode\".");
    if (r.code !== 0) {
      const tenant = client.config.tenant ? ` --tenant ${client.config.tenant}` : "";
      throw new UserError(`Azure CLI couldn't get a token. Run "az login${tenant}" in a terminal, then try again.`);
    }
    token = r.stdout.trim();
  } else {
    const session = await sessionFor(client, options.silent ?? false);
    setSignedIn(`${client.name}@${client.orgHost}`, session.account.label);
    token = session.accessToken;
    expires = jwtExpiry(token) ?? expires;
  }
  cache.set(key, { token, expires });
  return token;
}

async function sessionFor(client: Client, silent: boolean): Promise<vscode.AuthenticationSession> {
  const scopes = scopesFor(client);
  const pinned = client.config.account;
  let account: AccountInfo | undefined;
  if (pinned) {
    account = (await microsoftAccounts()).find((a) => sameAccount(a.label, pinned));
    if (!account && silent) throw new UserError(`Not signed in as ${pinned} yet.`);
  }
  let session: vscode.AuthenticationSession | undefined;
  try {
    const base: Record<string, unknown> = silent ? { silent: true } : { createIfNone: true };
    if (account) base.account = account;
    // A pinned account VS Code isn't signed into yet: let the person sign in with it now.
    else if (pinned) base.clearSessionPreference = true;
    session = await auth().getSession("microsoft", scopes, base);
  } catch (err) {
    throw new UserError(
      `Microsoft sign-in failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'If the client\'s tenant blocks it, set lantern.authMethod to "azureCli".'
    );
  }
  if (!session) throw new UserError(silent ? "Not signed in to Dataverse yet." : "Sign-in was cancelled.");
  if (pinned && !sameAccount(session.account.label, pinned)) {
    throw new UserError(
      `Signed in as ${session.account.label}, but ${client.name}'s tenant configuration says to use ${pinned}. ` +
        `Use "Sign In As…" on ${client.name} to sign in with ${pinned} or change the account.`
    );
  }
  return session;
}

/**
 * Pins a client to an account: one VS Code already knows, or a new sign-in.
 * Returns the account label, or undefined if cancelled.
 */
export async function chooseAccount(client: Client): Promise<string | undefined | null> {
  const accounts = await microsoftAccounts();
  const current = client.config.account;
  type Item = vscode.QuickPickItem & { action: "use" | "new" | "unpin" | "app"; label: string };
  const items: Item[] = accounts.map((a) => ({
    label: a.label,
    description: sameAccount(a.label, current) ? "current" : undefined,
    action: "use" as const,
  }));
  items.push({ label: "$(add) Sign in with another account…", action: "new" });
  items.push({ label: "$(key) Use an app registration (service principal)…", description: client.config.appId ? "current" : undefined, action: "app" });
  if (current) items.push({ label: "$(close) Don't pin an account", description: "use whichever account VS Code picks", action: "unpin" });
  const pick = await vscode.window.showQuickPick(items, { placeHolder: `Which Microsoft account should ${client.name} use for ${client.orgHost}?` });
  if (!pick) return undefined;
  if (pick.action === "unpin") return null;
  if (pick.action === "app") return APP_REGISTRATION;
  if (pick.action === "use") return pick.label;
  const session = await auth().getSession("microsoft", scopesFor(client), { createIfNone: true, clearSessionPreference: true });
  return session?.account.label;
}

/** chooseAccount's answer when the person picked an app registration. */
/**
 * A token for the Global Discovery Service (resource), to list the environments the
 * client's account can open. Undefined with an app registration: discovery lists
 * a person's environments, and an app has none.
 */
export async function discoveryToken(client: Client, resource: string): Promise<string | undefined> {
  if (client.config.appId) return undefined;
  const { authMethod, azPath } = settings();
  if (authMethod === "azureCli") {
    const args = ["account", "get-access-token", "--resource", resource, "--query", "accessToken", "-o", "tsv"];
    if (client.config.tenant) args.push("--tenant", client.config.tenant);
    const r = await run(azPath, args);
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  }
  const scopes = [`${resource}/user_impersonation`];
  if (client.config.tenant) scopes.push(`VSCODE_TENANT:${client.config.tenant}`);
  // The account this tenant already uses, so the list is that account's environments.
  const label = accountInUse(client)?.account;
  const account = label ? (await microsoftAccounts()).find((a) => sameAccount(a.label, label)) : undefined;
  const session = await auth().getSession("microsoft", scopes, { createIfNone: true, ...(account ? { account } : {}) });
  return session?.accessToken;
}

export const APP_REGISTRATION = "\u0000app";

export function forgetSignIn(client: Client): void {
  setSignedIn(`${client.name}@${client.orgHost}`, undefined);
  for (const key of [...cache.keys()]) if (key.includes(`|${client.config.org}|`)) cache.delete(key);
}

export function dataverseFor(client: Client, options: { silent?: boolean } = {}): DataverseClient {
  if (!client.config.org) throw new UserError(`Set "org" in the ${client.name} tenant configuration first.`);
  const org = client.config.org;
  // A client switches environments in place. A request still running from before a switch keeps
  // the org it was made for, so it must get that org's token, not the new environment's.
  const pinned = client.withEnvironment(client.envName);
  return new DataverseClient(org, (_org, fresh) => getToken(client.config.org === org ? client : pinned, { ...options, fresh }));
}

export function clearTokenCache(): void {
  cache.clear();
}

function jwtExpiry(token: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { exp?: number };
    return payload.exp ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
