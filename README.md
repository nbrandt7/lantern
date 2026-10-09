# Lantern for Dataverse

A suite of VS Code tools for Dynamics 365 and Power Platform developers who work across many clients. Each client gets its own folder, optionally connected to the client's Azure DevOps repo, and its own Microsoft account if it needs one. From there, Lantern pulls from Dataverse with a review step, pushes web resources and plug-ins, runs SQL and FetchXML queries, inspects records and their audit history, shows plug-in traces, steps, and system jobs, browses metadata, and gives you Dataverse-aware IntelliSense for JavaScript and C#.

A **Get started with Lantern** walkthrough (Help > Get Started) covers adding a client, signing in, environments, pull, push, and queries.

## Install

1. In VS Code, open the Extensions view, click `...`, and choose **Install from VSIX...**.
2. Pick `lantern-<version>.vsix`.
3. Open the folder that holds (or will hold) your client folders, then click the **Lantern** icon in the activity bar.
4. Run **Initialize Workspace** once. It creates a `package.json` with `@types/xrm`, a `.gitignore` that keeps client folders out of any repo at this level, and runs `npm install`.

### Requirements

| Tool | Used for | Install |
| --- | --- | --- |
| Git | Connecting client folders to ADO repos | Git for Windows (includes Git Credential Manager for ADO sign-in) |
| Power Platform CLI (`pac`) | Pull, solutions, C# early-bound classes | `dotnet tool install --global Microsoft.PowerApps.CLI.Tool` |
| .NET SDK | Building plug-ins, NuGet restore | dotnet.microsoft.com |
| ILSpy command line (`ilspycmd`, optional) | Get Plug-in Source, Compare Deployed Plug-in | Lantern offers `dotnet tool install --global ilspycmd` the first time |
| XrmDefinitelyTyped (optional) | Org-specific JS form types | Extract the `Delegate.XrmDefinitelyTyped` NuGet package into `tools/xdt` (Windows only) |
| Azure CLI (optional) | Web API sign-in when a tenant blocks VS Code's | Only if you set `authMethod` to `azureCli` |

C# Dev Kit is recommended for C# IntelliSense.

## Features

### Clients view

Everything about a client lives under its name in one tree:

```
developer-environment          DEV  org4d07465f.crm.dynamics.com  ⎇ main
  Solutions                                                   [+]
    AcmeCore                   pulled
      Tables                   this solution's tables
      Web resources            click to open your copy, or Dataverse's if not pulled
    Cr7e97c                    not pulled yet
  Plug-ins
    Projects                   your plug-in projects, matched to the active environment
      AcmePlugins              Plugins/AcmePlugins
        1.0.0.3 in DEV         what's registered
        AccountPlugin          2 steps, 1 off
        ContactPlugin          not registered yet
        OldPlugin              only in DEV (registered, gone from your code)
      Acme.Legacy              2.1.0.0 in DEV, no project here
    Steps                      every custom step in the org, grouped by assembly
    Traces                     errors only, last 24 hours
  Queries                      saved queries, plus Recent
  All tables                   every table in the org
  System jobs                  failed, last 24 hours
  Environment variables
  Environment                  your account, roles, IDs, links
```

**Solutions** lists the solutions in `client.json` and whether each one has been pulled into the folder. Right-click a pulled solution for **Pack and Import from Your Files…**, which packs what's in your folder with `pac solution pack` and imports it into any environment (handy for deploying from source control). The **+** button adds more: it lists the org's solutions (unmanaged first, with publisher and version) so you can pick several at once, then offers to pull. Right-click a solution to remove it from the client (its folder stays) or reveal its folder. An unpacked solution folder that isn't in `client.json` shows up too, dimmed, with a button to add it. Plug-in steps and traces sit under **Plug-ins** with your projects; system jobs and the rest stay at the client level. All of these cover the whole org, including things outside your solutions.

Org sections load when you expand them and stay loaded until you click their refresh icon, so redrawing the tree never refetches. Every subfolder of your workspace is a client; new subfolders you create in Explorer are configured automatically (`client.json`, `jsconfig.json`), and the tooling files are added to the clone's `.git/info/exclude`, so they never show up as changes in the client's repo.

**New Client** walks through four prompts: ADO repo URL (blank for a local-only folder), folder name, org URL, and solution names. With a repo URL it clones; if the folder already exists, it attaches it to the repo without overwriting local files. It then restores NuGet packages for any `.sln`.

Each connected client has inline buttons for **Switch Environment**, **Pull**, **Publish All Customizations**, and **Edit client.json**.

### Environments (DEV, TEST, PROD)

A client can have several environments. Right-click it and choose **Add Environment…**: the first time, Lantern asks what to call the current org (DEV by default), then the new environment's name and org URL, and whether to protect it. Switch with **Switch Environment** on the client or by clicking the status bar. Everything follows the active environment: Tables, queries, traces, steps, pushes, and pull. Each environment keeps its own metadata cache, its own pac profile, and its own account (**Sign In As…** saves the account for the environment you're on).

A **protected** environment (PROD, typically) asks for confirmation before anything that changes it: pushing web resources or plug-ins, publishing, importing solutions, `UPDATE`/`DELETE`/`INSERT`, CSV imports, registering or toggling steps, environment variable edits, and user settings. The status bar turns to its warning color while you're on one.

**Compare Environments…** (client or solution right-click) compares one solution between the active environment and another: solution version, each table's columns (added, removed, type, required level, labels, choices) and forms (layout, header, event handlers, libraries), web resource contents, every custom plug-in step, and environment variable values. Changed web resources open side by side with **Diff Web Resources**.

### Solutions: export, import, deploy, check, document

Right-click a solution for:

- **Export Solution…** as managed or unmanaged, into the client's `exports` folder (kept out of git) or anywhere you choose.
- **Copy Solution to Environment…** exports from the environment you're on and imports into another, for example DEV to TEST as managed, in one step.
- **Import Solution…** (also on the client) imports a zip into any of the client's environments and publishes.
- **Change Solution Version…** suggests the next revision, build, minor, or major version, or takes one you type.
- **Run Solution Checker** exports the solution, runs Microsoft's solution checker on it, shows a report with links to each rule, and puts issues in files you've pulled into the Problems panel.
- **Generate Documentation** writes `docs/<solution>.md`: tables with their custom columns and choices, forms with their libraries and event handlers, web resources with the functions in each and where they run (forms and command bar), plug-in steps on those tables, and the solution's environment variables.

### Pull from Dataverse, with review

**Pull** runs `pac solution sync` into a temporary copy, compares it with your files, and opens the **Pull Review** panel. Nothing touches your files until you click **Apply**.

- Each difference gets a choice: take Dataverse, or keep yours. Select several to set them together, or use the title buttons for everything undecided.
- Clicking a file opens a diff (Dataverse on the left, your file on the right, editable). If you have uncommitted edits to that file, it opens the 3-way merge editor with the committed version as the base.
- Binary files (assemblies, images) get take or keep only.
- Files your repo's `.gitignore` ignores, such as built plug-in DLLs, are left alone.
- Any file that gets replaced is copied to `.pull-backup/` first.
- Solutions listed in `client.json` that aren't in the folder yet are cloned with `pac solution clone`.

Each client gets its own pac auth profile, named after the folder, so switching between client tenants needs no manual `pac auth select`.

### Web resources

- **Push to Dataverse** (CodeLens, editor title, Explorer context menu, `Ctrl+Alt+U`): updates the web resource and publishes it. Multi-select in Explorer pushes several and publishes once. If it doesn't exist yet, you can create it and choose the solution.
- **Compare with Dataverse** (`Ctrl+Alt+D`): diff of the live version against your file.
- **Push on save**: off by default (`lantern.pushOnSave`).
- Web resources named without an extension (like `cr36f_AccountFormOnLoad`) are recognized from the solution's `.data.xml` and open as JavaScript, HTML, CSS, or XML as appropriate. New web resources are easier to work with if their names include a folder path and extension, like `nb_/scripts/account.js`.
- The web resource name comes from the solution's `.data.xml`, a `webResourceRoots` folder in `client.json`, or the path after `WebResources/`. If none apply, you're asked to confirm a guess.

### Plug-ins (C#)

Lantern treats a plug-in project in your folder and its registration in Dataverse as one thing. The assembly is matched by name, and each class by its full type name, which is the name Dataverse stores for a plug-in type. The Plug-ins list in the Clients view, the CodeLens on each class, and the steps and traces that open a class all use the same matching.

- **Build and Push Plug-in** (Ctrl+Alt+U in a plug-in class, the CodeLens above each class, the Clients view, a `.csproj` in Explorer) runs `dotnet build`, reads the built DLL, and works through the Web API the way the Plugin Registration Tool does. No `pac` and no IDs to paste:
  - The first push registers the assembly (sandboxed, stored in Dataverse) and a plug-in type for every plug-in and workflow activity class, and asks which solution to add it to.
  - Later pushes replace the registered assembly's content, so its steps stay, and register any classes that are new.
  - Classes you deleted from the code are listed with their steps. Dataverse refuses the update while they're registered, so Lantern offers to unregister them (steps first) or stop.
  - Before sending anything it checks what Dataverse would refuse: a change to the first or second part of the version (it offers to register the build as a separate assembly instead), a different signing key or culture, or an assembly that came from a managed solution or a plug-in package.
  - Plug-in assemblies need a strong name. For a new assembly, Lantern can create a key file and turn on signing. For a registered one, it looks through your folders for a `.snk` with the registered public key token and offers to use it.
  - Plug-in packages (`.nupkg`, named by `PackageId`) are created or updated as packages; Dataverse registers the classes inside them.
- **Get Plug-in Source from Dataverse…** (right-click Plug-ins, or an assembly with no project here) downloads the registered DLL and decompiles it with ILSpy's command-line tool into a project in the client folder. It offers to install `ilspycmd` the first time. The project gets a clean `.csproj` with the Dataverse SDK packages, the framework references the DLL uses, and signing with the original key when Lantern finds it in your folders by its token. From then on it's an ordinary plug-in project, and Build and Push updates the same registered assembly. If a project in your folder already builds that assembly, Get Source doesn't make a second copy and offers a comparison instead. Assemblies from managed solutions get a warning first, since a vendor's license may not allow decompiling.
- **Compare Deployed Plug-in with Local** (Ctrl+Alt+D in a plug-in class, the CodeLens, or right-click) builds your project, downloads what's registered, decompiles both, and lists the files that differ, each opening as a diff. Because both sides are decompiled, comments and formatting don't count as differences.

Decompiling can't recover comments, local variable names, or the signing key. Dataverse doesn't keep the `.snk`, and the DLL only carries the public half, so without the original key a rebuilt DLL can't update the registered assembly in place. If nobody has the key, change the first or second part of the version, push to register the build as a separate assembly, and move the steps to it.

### Typed IntelliSense

- **JavaScript, generic:** `@types/xrm` via each client's `jsconfig.json`.
- **JavaScript, org-specific:** **Generate JS Form Types** runs XrmDefinitelyTyped and switches that client to the generated types, so field names and form controls are checked.
- **C#:** **Generate C# Early-Bound Classes** runs `pac modelbuilder build`. It asks for the output folder and tables the first time and saves them. A `builderSettings.json` in the output folder takes priority.
- **New Form Script** (right-click a folder): creates `<table>.js` with the namespace pattern and JSDoc types. With org-specific types, it lists that table's forms so the script is typed to the one you pick.
- Snippets: type `xrm-` in JavaScript or `dv-` in C#.

### Tables

Each solution's **Tables** lists that solution's tables; **All tables** under the client lists every table in the org (system tables like `systemuser` included). Use **Find Table** (the search icon on All tables) to jump to one by display name or logical name.

- **Columns** show display name, logical name, type, and whether they're required. Hover for schema name, max length, lookup targets, and description. Choice and yes/no columns expand to their values and labels.
- **Forms** expand to tabs, sections, and controls with the exact names for `tabs.get()`, `sections.get()`, and `getControl()`. Composite fields (addresses, full name) list their inner controls, like `address1_composite_compositionLinkControl_address1_line3`. **Event handlers** shows which function runs on load, save, and each column's change, and flags handlers that don't get the execution context. Click a handler (or right-click, **Go to Function**) to jump to its definition in your local copy of the library. If the library isn't in the client folder, you can open a read-only copy from Dataverse instead, and if the function can't be found in the file, you get a warning, since the form would fail at runtime.
- Right-click a **table** to **Select Top 1000 Rows** (also the play icon on each table), start a **New Query with All Columns**, **Count Rows**, open the table or a new record in the browser, or add it to the C# early-bound tables.
- Right-click a **column** to insert `formContext.getAttribute("…")` / `getControl("…")` at your cursor, or find where it's used.
- The **Query** submenu (tables and columns) runs common debugging queries. Each opens as a query document with a comment explaining it, so you can tweak and rerun it:

  | On a table | On a column |
  | --- | --- |
  | Select Top 1000 Rows, New Query with All Columns | Select Rows with a Value, Rows Where This Is Empty |
  | Recently Created Rows, Recently Changed Rows, Inactive Rows | Show Value Counts |
  | Count Rows, Rows by Status Reason, Rows by Owner | Find Duplicate Values |
  | Find Duplicates… (pick the columns that must match), Rows Missing Required Values | Values with Leading or Trailing Spaces (text columns) |

  Duplicate searches leave out empty values and list the largest groups first. Queries that don't apply to a table (no status, organization-owned) say why instead of failing.
- Right-click a **choice value** to insert `setValue(…)` with that value, and a **tab or section** to insert its `formContext.ui.tabs.get(…)` reference.
- The **Copy** submenu copies logical name, schema name, display name, entity set name, Web API URL, labels, values, or IDs, depending on what you clicked.
- **Open Table Reference** (the preview icon on a table) opens a one-page reference: every column, every choice value, and each form's layout and handlers.

Metadata is cached per org in VS Code's storage (never in client repos), so after the first load it's instant and works offline. The refresh icon on a table reloads just that table.

### Live warnings in form scripts

While you edit a form script, the Problems panel and squiggles show what Lantern can tell without running it: a `getAttribute` name that isn't a column of the table (error), a column or control that isn't on any of the table's forms (so `getAttribute`/`getControl` return `null`), tabs and sections that don't exist, and form handlers registered for this library whose function the file doesn't define. Functions the command bar calls aren't flagged as missing handlers. Turn this off with `lantern.diagnostics.enabled`.

### Column-aware IntelliSense

Inside `getAttribute("…")`, `getControl("…")`, `tabs.get("…")`, and `sections.get("…")`, you get the real names from the org, with display names alongside. You can type part of a display name, too: `"primary con"` finds `primarycontactid`. Hovering over a name shows its details.

Columns that aren't on any of the table's forms are marked. `getAttribute` returns `null` for those at runtime, which is the usual cause of *Cannot read properties of null (reading 'getValue')*. Misspelled names get a warning on hover.

The table a script works with comes from, in order: a mapping in `client.json` (`fileTables`), an XrmDefinitelyTyped annotation like `Form.account.Main.Information`, or the file name (`cr36f_AccountFormOnLoad` → account). When none of those work, the suggestion list offers **Set the Dataverse table for this file**. These features never prompt for sign-in; they start working once you've signed in by expanding Tables or pushing a web resource.

### SQL and FetchXML queries

**New Query** (the database icon in the Clients view, or a client's right-click menu) opens a SQL document aimed at that client. Write SQL against Dataverse tables and press **F5** (or click **Run** above the query). Select part of the document to run just that part. Several statements separated by `;` or `GO` each get their own results.

```sql
SELECT TOP 50 a.name, a.revenue, c.fullname AS primary_contact
FROM account a
LEFT JOIN contact c ON c.contactid = a.primarycontactid
WHERE a.statecode = 0 AND a.name LIKE 'Con%'
ORDER BY a.revenue DESC
```

Supported: `SELECT` with `TOP` and `DISTINCT`, `*` and `alias.*`, column aliases, `INNER` and `LEFT JOIN` on one `a.col = b.col` condition, `WHERE` with `=`, `<>`, `<`, `>`, `LIKE`, `IN`, `IS NULL`, `BETWEEN`, `AND`, `OR`, `NOT`, `GROUP BY` with `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `HAVING` (conditions on those aggregates, joined with `AND`), and `ORDER BY`. FetchXML has no `HAVING`, so the extension applies it to the grouped rows after they come back; **Show FetchXML** and **Copy as code** say so. Each query is translated to FetchXML, so results respect the same security as the app. FetchXML documents get completions too: table names in `<entity>` and `<link-entity>`, columns of the right entity in `<attribute>`, `<condition>`, and `<order>` (including `entityname` aliases), the parent's columns for a link-entity's `to`, and operators.

**Saved queries:** **Save Query…** (right-click in a query) saves it to the client's `queries` folder, which the **Queries** node in the tree lists. **Recent** under it keeps your last 30 queries per client, with the environment and row count; click one to reopen it. **Show FetchXML** opens the translation, which is a handy way to learn FetchXML.

FetchXML documents run the same way: open one (or paste one into an XML file in a client folder) and press F5.

Results open in the **Query Results** tab of the bottom panel, next to Problems, Output, and Terminal. Each statement shows on one line; click it to see all of it. Lookups, choices, and dates show what users see; tick **Stored values** for the underlying GUIDs, numbers, and UTC dates. Click a column header to sort, double-click a lookup or a row number to open that record in the browser, and save results as CSV or JSON (the confirmation has **Open File** and **Show in Folder**). Right-click a cell to copy its value, its row, or its whole column, or to open the record. Queries stop after `lantern.query.maxRows` rows (5,000 by default) unless they use `TOP`.

Table and column names autocomplete: tables after `FROM` and `JOIN`, columns after an alias like `a.`.

**UPDATE, DELETE, and INSERT** run with a preview. `UPDATE account SET fax = '555-0199' WHERE statecode = 0` first finds the matching rows, then asks "Set fax = '555-0199' on 12 Account rows?" and lists the first ten by name, with a stronger warning when there's no `WHERE`. Nothing changes until you confirm, and the results show each row's outcome. Text, number, yes/no, choice (number or label), date, and lookup columns can be set. A lookup takes a record ID, or `'table:ID'` for customer and owner lookups (`SET ownerid = 'team:…'`), and `NULL` clears it. `INSERT INTO account (name, industrycode) VALUES ('Contoso', 'Accounting'), ('Fabrikam', 2)` creates rows after showing how many.

**Import CSV…** (right-click a table) matches the file's headers to columns by logical, schema, or display name, previews the rows in the results panel, then asks before importing. Rows with a value in the table's ID column (like `accountid`) update that record; the rest are created. Empty cells are left alone, and headers that don't match a column are listed and skipped.

**Run as…** (above the query, or right-click) runs it as another user, using Dataverse impersonation, so you see exactly what their security roles allow. You need the act-on-behalf-of-another-user privilege, which admins have.

**Copy as code** (above the query, the **Code** button in results, or right-click) turns the query into JavaScript (`Xrm.WebApi.retrieveMultipleRecords`), a Web API URL, C# `FetchExpression`, or C# `QueryExpression`. With several statements, it uses the one your cursor is in.

### Records and audit history

**Inspect a Record** (a client's right-click menu, or a results cell's right-click menu) shows every column of one record: display name, logical name, type, and value, with lookups you can click through and empty columns last. Paste a record URL from the app, `table:GUID`, or a bare GUID (it then asks for the table); a GUID on your clipboard is filled in for you. **Open Record from Clipboard** opens the record in the browser.

**Audit History** shows who changed what and when, one row per changed column with old and new values. Right-click a column in a record view for that column's history alone. If nothing shows up, auditing is probably off for the org, the table, or the column.

### Plug-in steps, traces, and system jobs

- **Register Plug-in Step…** (the **+** on Plug-ins > Steps, or right-click an assembly or a plug-in class) walks through the plug-in class, message, table, stage, synchronous or asynchronous, filtering columns, and pre- and post-images with their columns, all picked from metadata, then adds the step to a solution if you choose one.
- **Steps** (under Plug-ins) lists your custom steps by assembly, showing message, table, stage, and whether each runs asynchronously. Turn a step off or on from its right-click menu (handy while debugging something else), or click it to open its plug-in class in your code.
- **Traces** (under Plug-ins) lists the newest trace log entries, with failures marked. **Go to Plug-in Class** on an entry opens the class in your code. Click one to read its trace output and exception. The filter icon narrows to errors only, a time window, or a plug-in name. If trace logging is off in the org, it offers to turn it on (it asks first, since it's an org-wide setting).
- **System jobs** lists async operations, failed ones by default: workflows, async plug-ins, and system jobs, with their error messages. Right-click a job to open the record it ran against.

### Environment variables and environment details

**Environment variables** shows each variable's current value (or its default). Click one to change it; values that only had a default get their own value row. Secrets and data source variables are shown but not editable here.

**Environment** shows who you're signed in as, your security roles, your business unit, the org's version, and its organization and environment IDs (click any value to copy it), plus links to the maker portal, the admin center, and the app.

### Security roles and access

**View Security Role…** (client right-click) shows a role's privileges as a grid: one row per table, with the level for Create, Read, Write, Delete, Append, Append To, Assign, and Share (User, Business unit, Parent: child business units, or Organization).

**Check a User's Access to a Record…** asks Dataverse what access a user has to a record, then explains it: their best Read level for the table across their own and their teams' roles, who owns the record, and which business units are involved, with what would give them access.

### TypeScript web resources

**Set Up TypeScript Web Resources** (client right-click) creates `ts/tsconfig.json`, typed with `@types/xrm`, compiling into the web resources folder you pick. Saving a `.ts` file under it compiles the project and pushes the compiled `.js` (turn the push off with `lantern.typescript.pushOnSave`). **Compile and Push** does the same on demand. TypeScript must be installed (`npm install -D typescript` in the workspace folder).

### Plug-ins: projects, classes, steps on the class

**New Plug-in Project…** (client right-click) runs `pac plugin init` in `Plugins/<name>`. **New Plug-in Class…** (right-click a plug-in project) adds a plug-in, a Custom API handler, or a custom workflow activity, in the project's namespace; plug-ins use the project's `PluginBase` when it has one.

Above each plug-in class, besides **Build and push**, a CodeLens shows the class's registration in the active environment: its steps (like "2 steps: Update of account, Create of account (off)"), or "Not registered in DEV yet". Clicking the steps line shows the class in the Lantern view under Plug-ins > Projects, with its steps expanded. The CodeLens also offers **Register step** with the class already chosen and **Compare with deployed**.

### PCF controls

**New PCF Control…** (client right-click) runs `pac pcf init` (field or dataset, React or standard) in `PCF/<name>` and installs its packages. Controls show under **PCF controls** in the client, with **Build**, **Push** (to the active environment; the publisher prefix is asked once and saved in `client.json`), and **Start Test Harness** (runs `npm start watch` in a terminal).

### Power Pages

**Download Power Pages Site…** (client right-click) lists the org's sites, downloads one into `pages/` with `pac pages download`, and remembers its ID and data model. Sites show under **Power Pages sites**, with **Upload** to the active environment.

### FetchXML in your code

FetchXML inside JavaScript, TypeScript, or C# strings gets **Run FetchXML** and **Edit as query** above it, including FetchXML built from `"..." + value + "..."` pieces, template literals, and C# verbatim, interpolated, and raw strings. Values spliced in at runtime (`${id}`, `{0}`, `{accountId}`, or the expression in a `+` chain) become placeholders; running asks for a value for each. **Edit as query** opens it as a query document with IntelliSense; **Write back to <file>** above it replaces the literal in your code (a `+` chain becomes one template literal or interpolated string).

### Custom APIs

**New Custom API…** (client right-click) creates `customapis/<uniquename>.json`, a definition with a JSON schema for completions and validation: binding, action or function, request parameters, response properties, and the plug-in class that runs it. Above the file:

- **Deploy Custom API** creates it with its parameters and properties, or updates what Dataverse allows changing (names, description, privacy, the plug-in, new parameters and properties). A parameter whose type changed is reported, since Dataverse can't change that in place.
- **Generate C# handler** writes the plug-in class into your plug-in project, reading every request parameter with the right type.
- **Generate TypeScript client** writes a typed function that calls it through `Xrm.WebApi.online.execute`.

### Registering form event handlers

**Register Function as Form Event Handler…** (right-click in a form script) adds the function at your cursor to the forms you pick, on OnLoad, OnSave, or OnChange of a column, with or without the execution context. Lantern adds the library to the forms if needed, keeps every existing handler, skips forms that already have it, and publishes the table. The script has to be pushed first.

### Script unit tests

**Set Up Script Unit Tests** (client right-click) creates a `tests` folder with Jest and xrm-mock, a helper that loads a web resource script (they aren't modules) with the Xrm mock in place, and a first test for a script you pick. **Install and Run Tests** runs `npm install && npm test` in a terminal.

### Copilot Chat

In Copilot Chat's agent mode, Lantern adds tools Copilot can use on its own or that you can reference with `#`: **#lanternClients** (clients, environments, solutions), **#lanternTable** (a table's columns, choices, lookups, forms, and handlers), **#lanternQuery** (a read-only SQL or FetchXML query; you confirm each one), and **#lanternWhereUsed** (where a column is used). Nothing they do changes data. They need a VS Code version with language model tools.

### Dependencies and code analysis

**Show Dependencies** (right-click a table, column, form, web resource, plug-in step, or environment variable; or a web resource file) asks Dataverse what depends on it and what it depends on, the same tracking behind "Show dependencies" in the maker portal. The report groups them by type (forms, views, processes, apps, and so on) with names resolved, and links web resources to your local copies. Dataverse doesn't track code, so scripts and plug-ins don't appear there; the tools below cover code.

**What Does This Function Touch?** (right-click inside a function, right-click a form event handler, or click a "Runs on" CodeLens) lists every column, control, tab, and section the function uses and what it does with each (`getValue`, `setVisible`, `setRequiredLevel`...), its `Xrm.WebApi` calls, and the other functions it calls. Names are checked against the forms of the script's table, so a column or control that isn't on any form is marked **no**, which is what makes `getAttribute` return `null`. Names built at runtime, like `getAttribute(fieldName)`, are listed separately since they can't be checked without running the code.

**Library Outline** (right-click a script, or a web resource under a solution) lists every function in the file, where each one runs, and which functions call it. Functions that nothing registers or calls are listed as possibly unused; they might still run from the command bar or another library, so check before deleting.

**Find Where Column Is Used** now names the function each code reference sits in and where that function runs, like "in AddressStreet3Hide (runs on Account (Main) OnChange of address1_line2)".

**Check Step Against Its Code** (right-click a plug-in step) reads the step's plug-in class and compares it with the step's registration. It lists the columns the class reads and writes, from Target, images, or other rows, and flags common mistakes: reading an image the step doesn't register, reading a column an image doesn't include, and on Update, reading a column from Target that won't be there unless it changed.

### Form handler CodeLens

Above each function that a form runs, a CodeLens says where: "Runs on Account (Main) OnLoad". If a form registers a handler that the file doesn't define, a warning appears at the top of the file, since that handler fails when the event fires. This uses the forms of the script's table (worked out the same way as column completions).

### Find where a column is used

Right-click a column under Tables and choose **Find Where Column Is Used**. The report covers forms (with tab, section, and change handlers), views (shown, filtered, or sorted), business rules, workflows, and actions, plug-in steps that filter on the column, and lines in the client folder's code that name it. Cloud flows and canvas apps aren't searched.

### User settings

**Edit User Settings** (a client's right-click menu) changes a personal setting for one or many users: time zone, records per page, display language, help language, or week numbers. It shows the current values first and confirms before saving.

### Compared with XrmToolBox and Level Up

| Tool | Here |
| --- | --- |
| SQL 4 CDS | New Query (SELECT, plus UPDATE and DELETE with preview) |
| FetchXml Tester | Run a FetchXML document with F5 |
| Dataverse REST Builder | Copy as code |
| Metadata Browser | Tables and Open Table Reference |
| Field Reference Finder | Find Where Column Is Used |
| Plugin Trace Viewer | Plug-in traces |
| Plugin Registration Tool (register and update assemblies, steps) | Build and Push Plug-in, Register Plug-in Step, Plug-in steps |
| User Settings Utility | Edit User Settings |
| Level Up: All Fields, Record URL | Inspect a Record, Open Record from Clipboard |
| Level Up: Impersonation | Run as… (for queries) |
| Level Up: Environment details, My roles | Environment |

Level Up's form tricks (God mode, logical names on the form, changed fields) work on the live page in the browser, so keep Level Up for those.

From Dataverse PowerTools, Lantern doesn't have plug-in profiling and replay debugging, webpack bundling for TypeScript web resources (it compiles with `tsc`), a visual FetchXML editor (it has SQL and FetchXML IntelliSense instead), DataverseUnitTest scaffolding for plug-ins, or live debugging of a deployed PCF control.

### Status bar

Shows the active file's client and environment, in the warning color on a protected environment. Click it for that client's actions, including switching environments.

## Client settings (client.json)

Lantern keeps each client's settings (org, environments, solutions, accounts) in its own storage on your machine, not in the client's folder, so nothing of Lantern's appears in the client's repo. **Edit client.json** (client right-click) opens them; they're still validated against the schema. A `client.json` already in a folder moves to the storage the next time VS Code starts, unless the repo tracks it (then a team committed it on purpose, and it stays). To keep settings in the folder instead, set `lantern.clientSettingsLocation` to `folder`.

The one file Lantern still writes into a client folder is `jsconfig.json`, which typed Xrm IntelliSense needs. Lantern adds it (and its other local files: `typings/`, `.pull-backup/`, `exports/`) to the local exclude list (`.git/info/exclude`) of whichever repo holds the folder, even when the repo's root is above it, so they never show in Source Control and no `.gitignore` changes are needed. Turn it off with `lantern.createJsconfig`.

Lantern only configures a workspace subfolder as a client automatically when it's a repo of its own (a cloned client) or the workspace folder isn't a repo. If you open a repo directly, its project folders are left alone. **Remove Lantern from Folder…** (client right-click) removes Lantern's settings and the `jsconfig.json` it created from a folder, and keeps it from being configured again.

### Settings format

`client.json` has a JSON schema, so you get completions and validation while editing it.

```json
{
  "org": "https://contoso.crm.dynamics.com",
  "environments": [
    { "name": "DEV", "org": "https://contoso-dev.crm.dynamics.com" },
    { "name": "PROD", "org": "https://contoso.crm.dynamics.com", "protected": true }
  ],
  "environment": "DEV",
  "accounts": { "PROD": "nathan@contoso.com" },
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

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `lantern.clientsFolder` | first workspace folder | Folder holding client folders |
| `lantern.autoConfigureNewFolders` | `true` | |
| `lantern.authMethod` | `vscode` | `azureCli` if a tenant blocks VS Code's Microsoft sign-in |
| `lantern.publishAfterPush` | `true` | |
| `lantern.pushOnSave` | `false` | |
| `lantern.plugins.buildConfiguration` | `Release` | |
| `lantern.pacPath` / `dotnetPath` / `azPath` | on PATH | |
| `lantern.xrmDefinitelyTypedPath` | search `tools/xdt` | |
| `lantern.codeLens.enabled` | `true` | |
| `lantern.metadata.completions` | `true` | Column, control, tab, and section suggestions and hovers |
| `lantern.query.maxRows` | `5000` | Row limit for queries without `TOP`, and for UPDATE/DELETE |
| `lantern.diagnostics.enabled` | `true` | Live warnings in form scripts |
| `lantern.typescript.pushOnSave` | `true` | Push compiled TypeScript output when a `.ts` file is saved |
| `lantern.clientSettingsLocation` | `outside` | Keep client settings in Lantern's storage (`outside`) or in `client.json` in the folder (`folder`) |
| `lantern.createJsconfig` | `true` | Create `jsconfig.json` in client folders for typed Xrm IntelliSense |

## Sign-in and multiple accounts

Lantern signs in two ways, and both follow the account you choose for each client:

- **pac** (Pull, plug-in push, early-bound classes) keeps one profile per client, named after the folder, created on first use.
- **The Dataverse Web API** (everything else) uses VS Code's Microsoft account sign-in.

If different clients use different logins, right-click a client and choose **Sign In As…**. Pick an account VS Code is already signed into, or sign in with a new one. Lantern saves it as `"account"` in that client's `client.json` and from then on always signs in to that client's org with it, whatever account other clients use. Tokens are cached per account, so switching between clients never reuses another client's token. If the client's pac profile was created with a different account, Lantern offers to recreate it so pac and the Web API agree. The account each client uses shows in its tooltip and under **Environment**.

Without a pinned account, Lantern uses whichever account VS Code picks, which is fine if you only have one.

**App registrations:** in **Sign In As…**, choose **Use an app registration (service principal)** and enter its application ID, tenant, and client secret. The secret goes into VS Code's secret storage, never `client.json`, and is masked in the output panel. Lantern uses it for the Web API (client credentials) and for a separate pac profile. It applies to the active environment, so DEV can use your account while a CI-style environment uses an app. The app needs an application user in the org.

Some client tenants block VS Code's sign-in. If that happens, set `lantern.authMethod` to `azureCli`, put the tenant in `client.json` (`"tenant"`), and run `az login --tenant <tenant>` once per tenant. The Azure CLI picks the account by tenant, so pinning an account doesn't apply with that method.

## Moving from Dataverse Workspace

Lantern used to be called Dataverse Workspace. It's a separate install, so uninstall Dataverse Workspace after installing Lantern (Lantern reminds you if both are installed). Your settings carry over automatically the first time Lantern starts: every `dataverseWorkspace.*` setting is copied to the matching `lantern.*` setting, unless you've already set the new one. Custom keybindings that refer to `dataverseWorkspace.*` commands need updating to `lantern.*` by hand. `client.json` files don't change. The metadata cache starts fresh, so the first expand of Tables reloads from Dataverse.

## Building from source

```bash
npm install
npm run compile
npm test            # all three suites below
npm run package     # produces the .vsix
```

`npm test` runs:

- `test/unit.js`: edge cases for the core modules (SQL, script and plug-in analysis, records, environments, CSV, lookups, comparison, sign-in, the Web API client, the manifest).
- `test/run.js`: end-to-end runs of every command against fake `pac`, `dotnet`, and `tsc` CLIs, real git, and a fake Web API, including an Esc-at-every-prompt sweep of the Command Palette and simulated Dataverse outages.
- `test/webview.js`: loads the results panel in Chromium for every kind of result and clicks through it. It needs Playwright and skips itself without it.

Press F5 in VS Code to run it in an Extension Development Host.

## Known limits

- Pull recognizes the classic unpacked solution layout (`.cdsproj` or `Other/Solution.xml`). Repos written by Dataverse's native Git integration use a YAML layout that isn't supported yet.
- XrmDefinitelyTyped is a .NET Framework tool and only runs on Windows.
- Older non-SDK-style plug-in projects may need Visual Studio or msbuild to build.
