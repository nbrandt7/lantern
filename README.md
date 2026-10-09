# Lantern for Dataverse

Lantern for Dataverse is a suite of tools designed to help developers work on Dynamics 365 and Power Platform projects in Visual Studio Code. Each client gets its own folder, environments, and sign-in, so moving between clients, or between DEV, TEST, and PROD, doesn't mean reconfiguring anything. From there, Lantern pulls solutions from Dataverse with a review step, pushes web resources, builds and registers plug-ins, runs SQL and FetchXML queries against your org, and gives you IntelliSense that knows your org's columns and forms.

## Contents

- [Features at a glance](#features-at-a-glance)
- [Installation](#installation)
- [Getting started](#getting-started)
- [Features](#features)
- [Configuration](#configuration)
- [Sign-in and multiple accounts](#sign-in-and-multiple-accounts)
- [Contributing](#contributing)
- [Known limitations](#known-limitations)
- [License](#license)

## Features at a glance

| Area | What you get |
| --- | --- |
| **Clients and environments** | A folder per client, optionally linked to its Azure DevOps repo; DEV, TEST, and PROD environments per client; protected environments that confirm before any change; a per-client Microsoft account or app registration |
| **Solutions** | Pull with a review step, export, import, copy between environments, version bumps, solution checker, generated documentation, environment comparison |
| **Web resources** | Push and compare from the editor, TypeScript web resources, push on save |
| **Plug-ins** | Build and push (registers new assemblies and classes, updates existing ones), get source from a registered assembly, compare deployed with local, new projects and classes, step registration |
| **Script IntelliSense** | Typed `Xrm`, org-specific form types, column, control, tab, and section completions, live warnings, form handler CodeLens |
| **Queries** | SQL and FetchXML with IntelliSense, `UPDATE`/`DELETE`/`INSERT` with preview, CSV import, run as another user, copy as code, saved and recent queries |
| **Records** | Inspect any record, audit history |
| **Metadata** | Tables, columns, choices, forms, event handlers, table reference pages, find where a column is used, dependencies |
| **Code analysis** | What a function touches, library outline, check a plug-in step against its code, FetchXML inside your code |
| **Diagnostics** | Plug-in traces, plug-in steps, system jobs |
| **Administration** | Environment variables, environment details, security roles, a user's access to a record, user settings |
| **More** | PCF controls, Power Pages sites, Custom APIs, script unit tests, Copilot Chat tools, snippets |

## Installation

Lantern runs in VS Code 1.90 or later.

### Install the latest release

1. Download `lantern-<version>.vsix` from the [latest release](../../releases/latest).
2. In VS Code, open the Extensions view, click `...` at the top, and choose **Install from VSIX...**. Pick the file you downloaded.

   Or from a terminal:

   ```bash
   code --install-extension lantern-<version>.vsix
   ```

To update, download the newer `.vsix` from [Releases](../../releases) and install it the same way. VS Code replaces the installed version.

### Build it yourself

You need [Node.js](https://nodejs.org/) 20 or later and Git.

```bash
git clone https://github.com/nbrandt7/lantern.git
cd lantern
npm install
npm run package
```

`npm run package` compiles the extension and writes `lantern-<version>.vsix` to the repository folder. Install it as described above.

### Requirements

Lantern calls these tools for some features. Install the ones you need.

| Tool | Used for | Install |
| --- | --- | --- |
| Git | Connecting client folders to Azure DevOps repos | [git-scm.com](https://git-scm.com/) (Git for Windows includes Git Credential Manager for Azure DevOps sign-in) |
| Power Platform CLI (`pac`) | Pull, solutions, C# early-bound classes, PCF, Power Pages | `dotnet tool install --global Microsoft.PowerApps.CLI.Tool` |
| .NET SDK | Building plug-ins, NuGet restore | [dotnet.microsoft.com](https://dotnet.microsoft.com/) |
| ILSpy command line (`ilspycmd`, optional) | Get Plug-in Source, Compare Deployed Plug-in | Lantern offers `dotnet tool install --global ilspycmd` the first time you need it |
| XrmDefinitelyTyped (optional) | Org-specific JavaScript form types | Extract the `Delegate.XrmDefinitelyTyped` NuGet package into `tools/xdt` (Windows only) |
| Azure CLI (optional) | Web API sign-in when a tenant blocks VS Code's | Only needed if you set `lantern.authMethod` to `azureCli` |

The C# Dev Kit extension is recommended for C# IntelliSense.

## Getting started

1. Open the folder that holds (or will hold) your client folders, then click the **Lantern** icon in the activity bar.
2. Run **Initialize Workspace** once. It creates a `package.json` with `@types/xrm`, a `.gitignore` that keeps client folders out of any repo at this level, and runs `npm install`.
3. Click **New Client** and answer four prompts: the Azure DevOps repo URL (leave it blank for a local-only folder), the folder name, the org URL, and the solution names.

The **Get started with Lantern** walkthrough (**Help > Get Started**) covers adding a client, signing in, environments, pull, push, and queries.

## Features

### Clients view

Everything about a client lives under its name in one tree:

```
contoso                        DEV  contoso-dev.crm.dynamics.com  ⎇ main
  Solutions                                                   [+]
    ContosoCore                pulled
      Tables                   this solution's tables
      Web resources            click to open your copy, or Dataverse's if not pulled
    ContosoExtras              not pulled yet
  Plug-ins
    Projects                   your plug-in projects, matched to the active environment
      Contoso.Plugins          Plugins/Contoso.Plugins
        1.0.0.3 in DEV         what's registered
        AccountPlugin          2 steps, 1 off
        ContactPlugin          not registered yet
        OldPlugin              only in DEV (registered, gone from your code)
      Contoso.Legacy           2.1.0.0 in DEV, no project here
    Steps                      every custom step in the org, grouped by assembly
    Traces                     errors only, last 24 hours
  Queries                      saved queries, plus Recent
  All tables                   every table in the org
  System jobs                  failed, last 24 hours
  Environment variables
  Environment                  your account, roles, IDs, links
```

- **Solutions** lists the client's solutions and whether each one has been pulled into the folder. The **+** button lists the org's solutions (unmanaged first, with publisher and version) so you can add several at once, then offers to pull. Right-click a solution to remove it from the client (its folder stays) or reveal its folder. An unpacked solution folder the client doesn't list yet shows up dimmed, with a button to add it.
- **Pack and Import from Your Files…** (right-click a pulled solution) packs what's in your folder with `pac solution pack` and imports it into any environment, which is useful for deploying from source control.
- Org sections load when you expand them and stay loaded until you click their refresh icon, so redrawing the tree never refetches.
- Every subfolder of your workspace is a client. New subfolders you create in Explorer are configured automatically, and Lantern's files are added to the repo's `.git/info/exclude`, so they never show up as changes in the client's repo.
- **New Client** clones the repo when you give a URL. If the folder already exists, it attaches it to the repo without overwriting local files. It then restores NuGet packages for any `.sln`.
- Each connected client has inline buttons for **Switch Environment**, **Pull**, **Publish All Customizations**, and **Edit client.json**.
- The **status bar** shows the active file's client and environment, in the warning color on a protected environment. Click it for that client's actions, including switching environments.

### Environments (DEV, TEST, PROD)

A client can have several environments. Right-click it and choose **Add Environment…**. The first time, Lantern asks what to call the current org (DEV by default), then the new environment's name and org URL, and whether to protect it. Switch with **Switch Environment** on the client or by clicking the status bar.

Everything follows the active environment: tables, queries, traces, steps, pushes, and pull. Each environment keeps its own metadata cache, its own pac profile, and its own account.

A **protected** environment (PROD, typically) asks for confirmation before anything that changes it: pushing web resources or plug-ins, publishing, importing solutions, `UPDATE`/`DELETE`/`INSERT`, CSV imports, registering or toggling steps, environment variable edits, and user settings.

**Compare Environments…** (client or solution right-click) compares one solution between the active environment and another:

- solution version
- each table's columns (added, removed, type, required level, labels, choices) and forms (layout, header, event handlers, libraries)
- web resource contents, with **Diff Web Resources** to open changed ones side by side
- every custom plug-in step
- environment variable values

### Solutions

Right-click a solution for:

- **Export Solution…** as managed or unmanaged, into the client's `exports` folder (kept out of git) or anywhere you choose.
- **Copy Solution to Environment…** exports from the environment you're on and imports into another, for example DEV to TEST as managed, in one step.
- **Import Solution…** (also on the client) imports a zip into any of the client's environments and publishes.
- **Change Solution Version…** suggests the next revision, build, minor, or major version, or takes one you type.
- **Run Solution Checker** exports the solution, runs Microsoft's solution checker on it, shows a report with links to each rule, and puts issues in files you've pulled into the Problems panel.
- **Generate Documentation** writes `docs/<solution>.md`: tables with their custom columns and choices, forms with their libraries and event handlers, web resources with the functions in each and where they run, plug-in steps on those tables, and the solution's environment variables.

### Pull from Dataverse, with review

**Pull** runs `pac solution sync` into a temporary copy, compares it with your files, and opens the **Pull Review** panel. Nothing touches your files until you click **Apply**.

- Each difference gets a choice: take Dataverse's version, or keep yours. Select several to set them together, or use the title buttons for everything undecided.
- Clicking a file opens a diff (Dataverse on the left, your file on the right, editable). If you have uncommitted edits to that file, it opens the 3-way merge editor with the committed version as the base.
- Binary files (assemblies, images) get take or keep only.
- Files your repo's `.gitignore` ignores, such as built plug-in DLLs, are left alone.
- Any file that gets replaced is copied to `.pull-backup/` first.
- Solutions the client lists that aren't in the folder yet are cloned with `pac solution clone`.

Each client gets its own pac auth profile, named after the folder, so switching between client tenants needs no manual `pac auth select`.

### Web resources

- **Push to Dataverse** (CodeLens, editor title, Explorer context menu, or `Ctrl+Alt+U` / `Cmd+Alt+U`) updates the web resource and publishes it. Multi-select in Explorer pushes several and publishes once. If the web resource doesn't exist yet, you can create it and choose the solution.
- **Compare with Dataverse** (`Ctrl+Alt+D` / `Cmd+Alt+D`) shows a diff of the live version against your file.
- **Push on save** is off by default (`lantern.pushOnSave`).
- Web resources named without an extension (like `new_AccountFormOnLoad`) are recognized from the solution's `.data.xml` and open as JavaScript, HTML, CSS, or XML as appropriate. New web resources are easier to work with if their names include a folder path and extension, like `contoso_/scripts/account.js`.
- The web resource name comes from the solution's `.data.xml`, a `webResourceRoots` folder in the client settings, or the path after `WebResources/`. If none apply, you're asked to confirm a guess.

### TypeScript web resources

**Set Up TypeScript Web Resources** (client right-click) creates `ts/tsconfig.json`, typed with `@types/xrm`, compiling into the web resources folder you pick. Saving a `.ts` file under it compiles the project and pushes the compiled `.js` (turn the push off with `lantern.typescript.pushOnSave`). **Compile and Push** does the same on demand. TypeScript must be installed (`npm install -D typescript` in the workspace folder).

### Plug-ins

Lantern treats a plug-in project in your folder and its registration in Dataverse as one thing. The assembly is matched by name, and each class by its full type name, which is the name Dataverse stores for a plug-in type. The Plug-ins list in the Clients view, the CodeLens on each class, and the steps and traces that open a class all use the same matching.

**Build and Push Plug-in** (`Ctrl+Alt+U` in a plug-in class, the CodeLens above each class, the Clients view, or a `.csproj` in Explorer) runs `dotnet build`, reads the built DLL, and registers it through the Dataverse Web API. There's no `pac` step and no IDs to paste.

- The first push registers the assembly (sandboxed, stored in Dataverse) and a plug-in type for every plug-in and workflow activity class, and asks which solution to add it to.
- Later pushes replace the registered assembly's content, so its steps stay, and register any classes that are new.
- Classes you deleted from the code are listed with their steps. Dataverse refuses the update while they're registered, so Lantern offers to unregister them (steps first) or stop.
- Before sending anything, it checks what Dataverse would refuse: a change to the first or second part of the version (it offers to register the build as a separate assembly instead), a different signing key or culture, or an assembly that came from a managed solution or a plug-in package.
- Plug-in assemblies need a strong name. For a new assembly, Lantern can create a key file and turn on signing. For a registered one, it looks through your folders for a `.snk` with the registered public key token and offers to use it.
- Plug-in packages (`.nupkg`, named by `PackageId`) are created or updated as packages, and Dataverse registers the classes inside them.

**Get Plug-in Source from Dataverse…** (right-click Plug-ins, or an assembly with no project here) downloads the registered DLL and decompiles it with ILSpy's command-line tool into a project in the client folder. The project gets a clean `.csproj` with the Dataverse SDK packages, the framework references the DLL uses, and signing with the original key when Lantern finds it in your folders. From then on it's an ordinary plug-in project, and Build and Push updates the same registered assembly. If a project in your folder already builds that assembly, Lantern doesn't make a second copy and offers a comparison instead. Assemblies from managed solutions get a warning first, since a vendor's license may not allow decompiling.

**Compare Deployed Plug-in with Local** (`Ctrl+Alt+D` in a plug-in class, the CodeLens, or right-click) builds your project, downloads what's registered, decompiles both, and lists the files that differ, each opening as a diff. Because both sides are decompiled, comments and formatting don't count as differences.

Decompiling can't recover comments, local variable names, or the signing key. Dataverse doesn't keep the `.snk`, and the DLL only carries the public half, so without the original key a rebuilt DLL can't update the registered assembly in place. If nobody has the key, change the first or second part of the version, push to register the build as a separate assembly, and move the steps to it.

**New Plug-in Project…** (client right-click) runs `pac plugin init` in `Plugins/<name>`. **New Plug-in Class…** (right-click a plug-in project) adds a plug-in, a Custom API handler, or a custom workflow activity in the project's namespace. Plug-ins use the project's `PluginBase` when it has one.

Above each plug-in class, a CodeLens shows the class's registration in the active environment: its steps (like "2 steps: Update of account, Create of account (off)"), or "Not registered in DEV yet". Clicking the steps line shows the class in the Lantern view with its steps expanded. The CodeLens also offers **Build and push**, **Register step** with the class already chosen, and **Compare with deployed**.

### Plug-in steps, traces, and system jobs

- **Register Plug-in Step…** (the **+** on Plug-ins > Steps, or right-click an assembly or a plug-in class) walks through the plug-in class, message, table, stage, synchronous or asynchronous, filtering columns, and pre- and post-images with their columns, all picked from metadata, then adds the step to a solution if you choose one.
- **Steps** lists your custom steps by assembly, showing message, table, stage, and whether each runs asynchronously. Turn a step off or on from its right-click menu, or click it to open its plug-in class in your code.
- **Traces** lists the newest plug-in trace log entries, with failures marked. Click one to read its trace output and exception, or use **Go to Plug-in Class** to open the class in your code. The filter icon narrows to errors only, a time window, or a plug-in name. If trace logging is off in the org, Lantern offers to turn it on (it asks first, since it's an org-wide setting).
- **System jobs** lists async operations, failed ones by default: workflows, async plug-ins, and system jobs, with their error messages. Right-click a job to open the record it ran against.
- **Check Step Against Its Code** (right-click a step) reads the step's plug-in class and compares it with the step's registration. It lists the columns the class reads and writes, from Target, images, or other rows, and flags common mistakes: reading an image the step doesn't register, reading a column an image doesn't include, and on Update, reading a column from Target that won't be there unless it changed.

### Typed IntelliSense for scripts and C#

- **JavaScript, generic:** `@types/xrm` through each client's `jsconfig.json`.
- **JavaScript, org-specific:** **Generate JS Form Types** runs XrmDefinitelyTyped and switches that client to the generated types, so field names and form controls are checked.
- **C#:** **Generate C# Early-Bound Classes** runs `pac modelbuilder build`. It asks for the output folder and tables the first time and saves them. A `builderSettings.json` in the output folder takes priority.
- **New Form Script** (right-click a folder) creates `<table>.js` with the namespace pattern and JSDoc types. With org-specific types, it lists that table's forms so the script is typed to the one you pick.
- **Snippets:** type `xrm-` in JavaScript or `dv-` in C#.

### Column-aware IntelliSense

Inside `getAttribute("…")`, `getControl("…")`, `tabs.get("…")`, and `sections.get("…")`, you get the real names from the org, with display names alongside. You can type part of a display name too: `"primary con"` finds `primarycontactid`. Hovering over a name shows its details.

Columns that aren't on any of the table's forms are marked. `getAttribute` returns `null` for those at runtime, which is the usual cause of *Cannot read properties of null (reading 'getValue')*. Misspelled names get a warning on hover.

The table a script works with comes from, in order: a mapping in the client settings (`fileTables`), an XrmDefinitelyTyped annotation like `Form.account.Main.Information`, or the file name (`new_AccountFormOnLoad` → account). When none of those work, the suggestion list offers **Set the Dataverse table for this file**. These features never prompt for sign-in; they start working once you've signed in by expanding Tables or pushing a web resource.

### Live warnings in form scripts

While you edit a form script, the Problems panel and squiggles show what Lantern can tell without running it:

- a `getAttribute` name that isn't a column of the table (error)
- a column or control that isn't on any of the table's forms, so `getAttribute`/`getControl` return `null`
- tabs and sections that don't exist
- form handlers registered for this library whose function the file doesn't define

Functions the command bar calls aren't flagged as missing handlers. Turn the warnings off with `lantern.diagnostics.enabled`.

### Form handlers

- **Form handler CodeLens:** above each function a form runs, a CodeLens says where, like "Runs on Account (Main) OnLoad". If a form registers a handler the file doesn't define, a warning appears at the top of the file, since that handler fails when the event fires.
- **Register Function as Form Event Handler…** (right-click in a form script) adds the function at your cursor to the forms you pick, on OnLoad, OnSave, or OnChange of a column, with or without the execution context. Lantern adds the library to the forms if needed, keeps every existing handler, skips forms that already have it, and publishes the table. Push the script first.

### Tables and metadata

Each solution's **Tables** lists that solution's tables, and **All tables** under the client lists every table in the org, system tables like `systemuser` included. **Find Table** (the search icon on All tables) jumps to one by display name or logical name.

- **Columns** show display name, logical name, type, and whether they're required. Hover for schema name, max length, lookup targets, and description. Choice and yes/no columns expand to their values and labels.
- **Forms** expand to tabs, sections, and controls with the exact names for `tabs.get()`, `sections.get()`, and `getControl()`. Composite fields (addresses, full name) list their inner controls, like `address1_composite_compositionLinkControl_address1_line3`.
- **Event handlers** shows which function runs on load, save, and each column's change, and flags handlers that don't get the execution context. Click a handler (or right-click, **Go to Function**) to jump to its definition in your local copy of the library. If the library isn't in the client folder, you can open a read-only copy from Dataverse instead. If the function can't be found in the file, you get a warning, since the form would fail at runtime.
- Right-click a **table** to **Select Top 1000 Rows** (also the play icon on each table), start a **New Query with All Columns**, **Count Rows**, open the table or a new record in the browser, or add it to the C# early-bound tables.
- Right-click a **column** to insert `formContext.getAttribute("…")` or `getControl("…")` at your cursor, or find where it's used.
- Right-click a **choice value** to insert `setValue(…)` with that value, or a **tab or section** to insert its `formContext.ui.tabs.get(…)` reference.
- The **Copy** submenu copies logical name, schema name, display name, entity set name, Web API URL, labels, values, or IDs, depending on what you clicked.
- **Open Table Reference** (the preview icon on a table) opens a one-page reference: every column, every choice value, and each form's layout and handlers.

The **Query** submenu on tables and columns runs common debugging queries. Each opens as a query document with a comment explaining it, so you can tweak and rerun it:

| On a table | On a column |
| --- | --- |
| Select Top 1000 Rows, New Query with All Columns | Select Rows with a Value, Rows Where This Is Empty |
| Recently Created Rows, Recently Changed Rows, Inactive Rows | Show Value Counts |
| Count Rows, Rows by Status Reason, Rows by Owner | Find Duplicate Values |
| Find Duplicates… (pick the columns that must match), Rows Missing Required Values | Values with Leading or Trailing Spaces (text columns) |

Duplicate searches leave out empty values and list the largest groups first. Queries that don't apply to a table (no status, organization-owned) say why instead of failing.

Metadata is cached per org in VS Code's storage (never in client repos), so after the first load it's instant and works offline. The refresh icon on a table reloads just that table.

### SQL and FetchXML queries

**New Query** (the database icon in the Clients view, or a client's right-click menu) opens a SQL document aimed at that client. Write SQL against Dataverse tables and press **F5** (or click **Run** above the query). Select part of the document to run just that part. Several statements separated by `;` or `GO` each get their own results.

```sql
SELECT TOP 50 a.name, a.revenue, c.fullname AS primary_contact
FROM account a
LEFT JOIN contact c ON c.contactid = a.primarycontactid
WHERE a.statecode = 0 AND a.name LIKE 'Con%'
ORDER BY a.revenue DESC
```

Supported SQL:

- `SELECT` with `TOP` and `DISTINCT`, `*` and `alias.*`, and column aliases
- `INNER` and `LEFT JOIN` on one `a.col = b.col` condition
- `WHERE` with `=`, `<>`, `<`, `>`, `LIKE`, `IN`, `IS NULL`, `BETWEEN`, `AND`, `OR`, and `NOT`
- `GROUP BY` with `COUNT`, `SUM`, `AVG`, `MIN`, and `MAX`
- `HAVING` with conditions on those aggregates, joined with `AND` (FetchXML has no `HAVING`, so Lantern applies it to the grouped rows after they come back)
- `ORDER BY`

Each query is translated to FetchXML, so results respect the same security as the app. **Show FetchXML** opens the translation, which is a handy way to learn FetchXML. Table and column names autocomplete: tables after `FROM` and `JOIN`, columns after an alias like `a.`.

**FetchXML documents** run the same way: open one (or paste one into an XML file in a client folder) and press F5. They get completions too: table names in `<entity>` and `<link-entity>`, columns of the right entity in `<attribute>`, `<condition>`, and `<order>` (including `entityname` aliases), the parent's columns for a link-entity's `to`, and operators.

**Results** open in the **Query Results** tab of the bottom panel, next to Problems, Output, and Terminal.

- Lookups, choices, and dates show what users see. Tick **Stored values** for the underlying GUIDs, numbers, and UTC dates.
- Click a column header to sort, and double-click a lookup or a row number to open that record in the browser.
- Right-click a cell to copy its value, its row, or its whole column, or to open the record.
- Save results as CSV or JSON.
- Queries stop after `lantern.query.maxRows` rows (5,000 by default) unless they use `TOP`.

**Saved and recent queries:** **Save Query…** (right-click in a query) saves it to the client's `queries` folder, which the **Queries** node in the tree lists. **Recent** under it keeps your last 30 queries per client, with the environment and row count.

**UPDATE, DELETE, and INSERT** run with a preview. `UPDATE account SET fax = '555-0199' WHERE statecode = 0` first finds the matching rows, then asks "Set fax = '555-0199' on 12 Account rows?" and lists the first ten by name, with a stronger warning when there's no `WHERE`. Nothing changes until you confirm, and the results show each row's outcome. Text, number, yes/no, choice (number or label), date, and lookup columns can be set. A lookup takes a record ID, or `'table:ID'` for customer and owner lookups (`SET ownerid = 'team:…'`), and `NULL` clears it. `INSERT INTO account (name, industrycode) VALUES ('Contoso', 'Accounting'), ('Fabrikam', 2)` creates rows after showing how many.

**Import CSV…** (right-click a table) matches the file's headers to columns by logical, schema, or display name, previews the rows in the results panel, then asks before importing. Rows with a value in the table's ID column (like `accountid`) update that record, and the rest are created. Empty cells are left alone, and headers that don't match a column are listed and skipped.

**Run as…** (above the query, or right-click) runs it as another user through Dataverse impersonation, so you see exactly what their security roles allow. You need the act-on-behalf-of-another-user privilege, which admins have.

**Copy as code** (above the query, the **Code** button in results, or right-click) turns the query into JavaScript (`Xrm.WebApi.retrieveMultipleRecords`), a Web API URL, C# `FetchExpression`, or C# `QueryExpression`. With several statements, it uses the one your cursor is in.

### FetchXML in your code

FetchXML inside JavaScript, TypeScript, or C# strings gets **Run FetchXML** and **Edit as query** above it. That includes FetchXML built from `"..." + value + "..."` pieces, template literals, and C# verbatim, interpolated, and raw strings. Values spliced in at runtime (`${id}`, `{0}`, `{accountId}`, or the expression in a `+` chain) become placeholders, and running asks for a value for each. **Edit as query** opens it as a query document with IntelliSense, and **Write back to &lt;file&gt;** above it replaces the literal in your code (a `+` chain becomes one template literal or interpolated string).

### Records and audit history

**Inspect a Record** (a client's right-click menu, or a results cell's right-click menu) shows every column of one record: display name, logical name, type, and value, with lookups you can click through and empty columns last. Paste a record URL from the app, `table:GUID`, or a bare GUID (it then asks for the table). A GUID on your clipboard is filled in for you. **Open Record from Clipboard** opens the record in the browser.

**Audit History** shows who changed what and when, one row per changed column with old and new values. Right-click a column in a record view for that column's history alone. If nothing shows up, auditing is probably off for the org, the table, or the column.

### Dependencies and code analysis

- **Show Dependencies** (right-click a table, column, form, web resource, plug-in step, or environment variable, or a web resource file) asks Dataverse what depends on it and what it depends on. The report groups them by type (forms, views, processes, apps, and so on) with names resolved, and links web resources to your local copies. Dataverse doesn't track code, so scripts and plug-ins don't appear there; the tools below cover code.
- **Find Where Column Is Used** (right-click a column under Tables) covers forms (with tab, section, and change handlers), views (shown, filtered, or sorted), business rules, workflows, actions, plug-in steps that filter on the column, and lines in the client folder's code that name it. Each code reference names the function it's in and where that function runs, like "in AddressStreet3Hide (runs on Account (Main) OnChange of address1_line2)". Cloud flows and canvas apps aren't searched.
- **What Does This Function Touch?** (right-click inside a function, right-click a form event handler, or click a "Runs on" CodeLens) lists every column, control, tab, and section the function uses and what it does with each (`getValue`, `setVisible`, `setRequiredLevel`...), its `Xrm.WebApi` calls, and the other functions it calls. Names are checked against the forms of the script's table, so a column or control that isn't on any form is marked **no**. Names built at runtime, like `getAttribute(fieldName)`, are listed separately since they can't be checked without running the code.
- **Library Outline** (right-click a script, or a web resource under a solution) lists every function in the file, where each one runs, and which functions call it. Functions that nothing registers or calls are listed as possibly unused. They might still run from the command bar or another library, so check before deleting.

### Environment variables and environment details

**Environment variables** shows each variable's current value (or its default). Click one to change it; values that only had a default get their own value row. Secrets and data source variables are shown but not editable.

**Environment** shows who you're signed in as, your security roles, your business unit, the org's version, and its organization and environment IDs (click any value to copy it), plus links to the maker portal, the admin center, and the app.

### Security roles and access

**View Security Role…** (client right-click) shows a role's privileges as a grid: one row per table, with the level for Create, Read, Write, Delete, Append, Append To, Assign, and Share (User, Business unit, Parent: child business units, or Organization).

**Check a User's Access to a Record…** asks Dataverse what access a user has to a record, then explains it: their best Read level for the table across their own and their teams' roles, who owns the record, which business units are involved, and what would give them access.

### User settings

**Edit User Settings** (a client's right-click menu) changes a personal setting for one or many users: time zone, records per page, display language, help language, or week numbers. It shows the current values first and confirms before saving.

### PCF controls

**New PCF Control…** (client right-click) runs `pac pcf init` (field or dataset, React or standard) in `PCF/<name>` and installs its packages. Controls show under **PCF controls** in the client, with **Build**, **Push** (to the active environment; the publisher prefix is asked once and saved in the client settings), and **Start Test Harness** (runs `npm start watch` in a terminal).

### Power Pages

**Download Power Pages Site…** (client right-click) lists the org's sites, downloads one into `pages/` with `pac pages download`, and remembers its ID and data model. Sites show under **Power Pages sites**, with **Upload** to the active environment.

### Custom APIs

**New Custom API…** (client right-click) creates `customapis/<uniquename>.json`, a definition with a JSON schema for completions and validation: binding, action or function, request parameters, response properties, and the plug-in class that runs it. Above the file:

- **Deploy Custom API** creates it with its parameters and properties, or updates what Dataverse allows changing (names, description, privacy, the plug-in, new parameters and properties). A parameter whose type changed is reported, since Dataverse can't change that in place.
- **Generate C# handler** writes the plug-in class into your plug-in project, reading every request parameter with the right type.
- **Generate TypeScript client** writes a typed function that calls it through `Xrm.WebApi.online.execute`.

### Script unit tests

**Set Up Script Unit Tests** (client right-click) creates a `tests` folder with Jest and xrm-mock, a helper that loads a web resource script (they aren't modules) with the Xrm mock in place, and a first test for a script you pick. **Install and Run Tests** runs `npm install && npm test` in a terminal.

### Copilot Chat tools

In Copilot Chat's agent mode, Lantern adds tools Copilot can use on its own or that you can reference with `#`:

| Tool | What it gives Copilot |
| --- | --- |
| `#lanternClients` | Clients, environments, and solutions |
| `#lanternTable` | A table's columns, choices, lookups, forms, and handlers |
| `#lanternQuery` | A read-only SQL or FetchXML query (you confirm each one) |
| `#lanternWhereUsed` | Where a column is used |

None of them change data. They need a VS Code version with language model tools.

## Configuration

### Client settings

Lantern keeps each client's settings (org, environments, solutions, accounts) in its own storage on your machine, not in the client's folder, so nothing of Lantern's appears in the client's repo. **Edit client.json** (client right-click) opens them, with completions and validation from a JSON schema. A `client.json` already in a folder moves to the storage the next time VS Code starts, unless the repo tracks it (then a team committed it on purpose, and it stays). To keep settings in the folder instead, set `lantern.clientSettingsLocation` to `folder`.

```json
{
  "org": "https://contoso.crm.dynamics.com",
  "environments": [
    { "name": "DEV", "org": "https://contoso-dev.crm.dynamics.com" },
    { "name": "PROD", "org": "https://contoso.crm.dynamics.com", "protected": true }
  ],
  "environment": "DEV",
  "accounts": { "PROD": "dev@contoso.com" },
  "account": "",
  "tenant": "",
  "solutions": ["ContosoCore"],
  "entities": [],
  "username": "",
  "scriptNamespace": "Contoso",
  "webResourceRoots": ["src/WebResources"],
  "earlyBound": { "outDir": "Plugins/Model", "namespace": "Contoso.Model", "entities": ["account", "contact"] },
  "plugins": { "Contoso.Plugins": "00000000-0000-0000-0000-000000000000" },
  "fileTables": { "scripts/utils.js": "account" }
}
```

`environments` and `environment` are managed by Add Environment and Switch Environment; with no environments, `org` is the single org. `accounts` holds the account per environment and `account` the default (both set with **Sign In As…**). `tenant` is only needed for a guest account in the client's tenant, or for the `azureCli` sign-in method.

The one file Lantern writes into a client folder is `jsconfig.json`, which typed Xrm IntelliSense needs. Lantern adds it, and its other local files (`typings/`, `.pull-backup/`, `exports/`), to the local exclude list (`.git/info/exclude`) of whichever repo holds the folder, even when the repo's root is above it. They never show in Source Control and no `.gitignore` changes are needed. Turn the file off with `lantern.createJsconfig`.

Lantern only configures a workspace subfolder as a client automatically when it's a repo of its own (a cloned client) or the workspace folder isn't a repo. If you open a repo directly, its project folders are left alone. **Remove Lantern from Folder…** (client right-click) removes Lantern's settings and the `jsconfig.json` it created, and keeps the folder from being configured again.

### VS Code settings

| Setting | Default | Notes |
| --- | --- | --- |
| `lantern.clientsFolder` | first workspace folder | Folder holding client folders |
| `lantern.autoConfigureNewFolders` | `true` | Configure new subfolders of the clients folder automatically |
| `lantern.authMethod` | `vscode` | `azureCli` if a tenant blocks VS Code's Microsoft sign-in |
| `lantern.publishAfterPush` | `true` | Publish web resources after pushing |
| `lantern.pushOnSave` | `false` | Push web resources when saved |
| `lantern.typescript.pushOnSave` | `true` | Push compiled TypeScript output when a `.ts` file is saved |
| `lantern.plugins.buildConfiguration` | `Release` | Build configuration used before pushing plug-ins |
| `lantern.pacPath`, `lantern.dotnetPath`, `lantern.ilspyPath`, `lantern.azPath` | on PATH | Paths to the command-line tools |
| `lantern.xrmDefinitelyTypedPath` | search `tools/xdt` | Path to XrmDefinitelyTyped |
| `lantern.codeLens.enabled` | `true` | Push and Compare links on web resources, Build and Push on plug-in classes |
| `lantern.metadata.completions` | `true` | Column, control, tab, and section suggestions and hovers |
| `lantern.diagnostics.enabled` | `true` | Live warnings in form scripts |
| `lantern.query.maxRows` | `5000` | Row limit for queries without `TOP`, and for `UPDATE`/`DELETE` |
| `lantern.clientSettingsLocation` | `outside` | Keep client settings in Lantern's storage (`outside`) or in `client.json` in the folder (`folder`) |
| `lantern.createJsconfig` | `true` | Create `jsconfig.json` in client folders for typed Xrm IntelliSense |

## Sign-in and multiple accounts

Lantern signs in two ways, and both follow the account you choose for each client:

- **pac** (pull, solution packing, PCF, Power Pages, early-bound classes) keeps one profile per client, named after the folder, created on first use.
- **The Dataverse Web API** (everything else) uses VS Code's Microsoft account sign-in.

If different clients use different logins, right-click a client and choose **Sign In As…**. Pick an account VS Code is already signed into, or sign in with a new one. Lantern saves it for that client and from then on always signs in to that client's org with it, whatever account other clients use. Tokens are cached per account, so switching between clients never reuses another client's token. If the client's pac profile was created with a different account, Lantern offers to recreate it so pac and the Web API agree. The account each client uses shows in its tooltip and under **Environment**. Without a pinned account, Lantern uses whichever account VS Code picks, which is fine if you only have one.

**App registrations:** in **Sign In As…**, choose **Use an app registration (service principal)** and enter its application ID, tenant, and client secret. The secret goes into VS Code's secret storage, never into the client settings, and is masked in the output panel. Lantern uses it for the Web API (client credentials) and for a separate pac profile. It applies to the active environment, so DEV can use your account while another environment uses an app. The app needs an application user in the org.

**Tenants that block VS Code's sign-in:** set `lantern.authMethod` to `azureCli`, put the tenant in the client settings (`"tenant"`), and run `az login --tenant <tenant>` once per tenant. The Azure CLI picks the account by tenant, so pinning an account doesn't apply with that method.

## Contributing

Contributions are welcome. Open an issue for a bug or a feature idea, or send a pull request. For anything bigger than a small fix, opening an issue first to talk through the approach saves rework on both sides.

### Set up a development environment

1. Install [Node.js](https://nodejs.org/) 20 or later, Git, and VS Code 1.90 or later.
2. Fork the repository and clone your fork:

   ```bash
   git clone https://github.com/<your-account>/REPO.git
   cd REPO
   npm install
   ```

3. Open the folder in VS Code and press **F5**. The **Run Extension** launch configuration starts `npm run watch` and opens an Extension Development Host with Lantern loaded. Changes recompile as you save; reload the development host window (`Ctrl+R` / `Cmd+R`) to pick them up.

You don't need a Dataverse org to work on most of Lantern: the test suites run every command against fakes. To try a change against a real org, use a developer or trial environment you own.

### Run the tests

```bash
npm test
```

This compiles the extension and runs three suites:

| Suite | What it covers |
| --- | --- |
| `test/unit.js` | Edge cases for the core modules: SQL translation, script and plug-in analysis, records, environments, CSV, lookups, comparison, sign-in, the Web API client, and the manifest |
| `test/run.js` | End-to-end runs of every command against fake `pac`, `dotnet`, and `tsc` command-line tools, real git, and a fake Web API, including pressing Esc at every prompt in the Command Palette and simulated Dataverse outages |
| `test/webview.js` | Loads the query results panel in Chromium for every kind of result and clicks through it. It needs Playwright (`npm install -g playwright`) and skips itself without it |

You can run a single suite with `node test/unit.js` (after `npm run compile`).

### Project layout

| Folder | Contents |
| --- | --- |
| `src/extension.ts` | Activation and command registration |
| `src/commands/` | Command handlers: the prompts and flows behind each command |
| `src/core/` | Dataverse Web API client, SQL translation, pull, plug-in assembly reading and registration, code analysis, and other logic |
| `src/ui/` | Tree views, editors, CodeLens, diagnostics, the results panel, sign-in, and Copilot tools |
| `schemas/` | JSON schemas for client settings and Custom API definitions |
| `snippets/` | JavaScript and C# snippets |
| `media/` | Icons and walkthrough content |
| `test/` | The test suites, the VS Code mock, and the fake command-line tools |

### Guidelines

- **Add tests with your change.** New commands get an end-to-end step in `test/run.js`, and new parsing or analysis logic gets cases in `test/unit.js`.
- **Every prompt should be cancellable.** Pressing Esc at any prompt must leave things unchanged; the Esc sweep in `test/run.js` checks this for every command.
- **Confirm before changing an environment.** Anything that writes to Dataverse goes through the protected-environment confirmation.
- **Keep secrets out of files.** Credentials belong in VS Code's secret storage, never in client settings, logs, or backups.
- **Update the docs.** Describe user-facing changes in this README and add an entry to `CHANGELOG.md`.
- **Match the existing style.** TypeScript in strict mode, and user-facing messages that say what happened and what to do next.

### Submit a pull request

1. Create a branch from `main` in your fork.
2. Make your change, with tests, and run `npm test`.
3. Open a pull request that describes what changed and why, and how you tested it. Screenshots help for anything visible.

## Known limitations

- Pull recognizes the classic unpacked solution layout (`.cdsproj` or `Other/Solution.xml`). Repos written by Dataverse's native Git integration use a YAML layout that isn't supported yet.
- XrmDefinitelyTyped is a .NET Framework tool and only runs on Windows.
- Older non-SDK-style plug-in projects may need Visual Studio or MSBuild to build.

## License

Lantern for Dataverse is released under the [MIT License](LICENSE). By contributing, you agree that your contributions are licensed under the same terms.
