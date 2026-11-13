<p align="center">
  <img src="media/icon.png" alt="Lantern" width="128">
</p>

# Lantern for Dataverse

Lantern for Dataverse is a suite of tools designed to help developers work on Dynamics 365 and Power Platform projects in Visual Studio Code. Each tenant has environments and sign-in, so moving between tenants, or between DEV, TEST, and PROD, doesn't mean reconfiguring anything. From there, Lantern lists configured solutions, pushes web resources, builds and registers plug-ins, runs SQL and FetchXML queries against your org, and gives you IntelliSense that knows your org's columns and forms. It also generates C# classes and JavaScript or TypeScript models from the org's metadata, adds existing components to solutions the way the maker portal does, and gives Claude Code, Codex and Copilot tools that search and explain flows, plug-ins, web resources and columns.

## Contents

- [Features at a glance](#features-at-a-glance)
- [Installation](#installation)
- [Getting started](#getting-started)
- [Features](#features)
- [Search](#search)
- [Configuration](#configuration)
- [Sign-in and multiple accounts](#sign-in-and-multiple-accounts)
- [Contributing](#contributing)
- [Known limitations](#known-limitations)
- [License](#license)

## Features at a glance

| Area | What you get |
| --- | --- |
| **Clients and environments** | A folder per client, optionally linked to its Azure DevOps repo; DEV, TEST, and PROD environments per client; protected environments that confirm before any change; a per-client Microsoft account or app registration |
| **Solutions** | List configured solutions, export, import, copy between environments, version bumps, solution checker, generated documentation, environment comparison; add existing tables, columns, forms, web resources, flows, plug-ins and steps to a solution (or take them out), Open in Maker Portal |
| **Web resources** | Push and compare from the editor, TypeScript web resources, push on save |
| **Power Automate** | Browse cloud flows under each solution, add them to solutions, find them by what they do through the AI tools |
| **Plug-ins** | Build and push (registers new assemblies and classes, updates existing ones), get source from a registered assembly, compare deployed with local, new projects and classes, step registration, editing a registration (names, descriptions, isolation, package) and its steps (stage, mode, filtering columns, images, configurations), debugging a step (record a run, replay it locally with breakpoints) |
| **Script IntelliSense** | Typed `Xrm`, org-specific form types, column, control, tab, and section completions, live warnings, form handler CodeLens |
| **Queries** | SQL and FetchXML with IntelliSense, `UPDATE`/`DELETE`/`INSERT` with preview, CSV import, run as another user, copy as code, saved and recent queries |
| **Records** | Inspect any record, audit history |
| **Metadata** | Tables, columns, choices, forms, event handlers, table reference pages, find where a column is used, dependencies |
| **Generated code** | C# classes for plug-ins and JavaScript or TypeScript models for form scripts, from the org's metadata: pick the columns, edit them from a CodeLens, insert typed gets and sets |
| **AI tools** | Claude Code, Codex and Copilot connect to Lantern (an MCP server inside VS Code) to find flows by what they do, outline flows, plug-ins and web resources, trace what affects a column, query, and generate C# classes from a user story |
| **Code analysis** | What a function touches, library outline, check a plug-in step against its code, FetchXML inside your code |
| **Diagnostics** | Plug-in traces, plug-in steps, system jobs |
| **Administration** | Environment variables, environment details, security roles, a user's access to a record, user settings |
| **More** | PCF controls, Power Pages sites, Custom APIs, script unit tests, snippets |

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
| Power Platform CLI (`pac`) | Solution export and import, PCF, Power Pages | `dotnet tool install --global Microsoft.PowerApps.CLI.Tool` |
| .NET SDK | Building plug-ins, NuGet restore | [dotnet.microsoft.com](https://dotnet.microsoft.com/) |
| ILSpy command line (`ilspycmd`, optional) | Get Plug-in Source, Compare Deployed Plug-in | Lantern offers `dotnet tool install --global ilspycmd` the first time you need it |
| XrmDefinitelyTyped (optional) | Org-specific JavaScript form types | Extract the `Delegate.XrmDefinitelyTyped` NuGet package into `tools/xdt` (Windows only) |
| Azure CLI (optional) | Web API sign-in when a tenant blocks VS Code's | Only needed if you set `lantern.authMethod` to `azureCli` |

The C# Dev Kit extension is recommended for C# IntelliSense.

## Getting started

1. Open the folder that holds (or will hold) your client folders, then click the **Lantern** icon in the activity bar.
2. Run **Initialize Workspace** once (the **…** menu on the Tenant view). It creates a `package.json` with `@types/xrm`, a `.gitignore` that keeps client folders out of any repo at this level, and runs `npm install`.
3. Click **Add Tenant** (**+** on the Tenant view), enter the Dataverse URL and optional Entra tenant and solution names, then select the tenant to work with. **New Tenant Folder** also creates a local project folder or clones an Azure DevOps repo.

The **Get started with Lantern** walkthrough (**Help > Get Started**) covers adding a tenant, signing in, environments, push, and queries.

## Features

### Solutions and Environment views

Lantern's sidebar has three views. **Tenant** shows the selected tenant, its environment and your account (and, with no tenant selected, buttons to select or add one; the other two views appear once one is). **Solutions** lists its configured solutions and **Environment** the org-wide items, each starting straight at its contents:

```
Tenant                                   [account] [+] [✨] [↻] [...]
  contoso                      2 environments
  DEV                          contoso-dev.crm.dynamics.com
  you@contoso.com              pinned
Solutions                                                  [+] [↻]
  ContosoCore
    Tables                     this solution's tables
    Web resources              click to open a local copy when available, or Dataverse's
  ContosoExtras
Environment                                         [New Query] [↻] [...]
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

Each row's right-click has what belongs to it: the **tenant** row its configuration (Edit, Remove) and code setup (JS form types, TypeScript, script tests); the **environment** row switching, adding and comparing environments, Open in Browser, Test Connection, Edit User Settings, Publish All Customizations and Import Solution; the **account** row Sign In As. The Environment view's **…** has records (Inspect, Audit History), security (roles, a user's access), new projects (plug-in, custom API, PCF, Power Pages download) and Publish All.

- **Solutions** lists the configured solution names. The **+** button lists the org's solutions (unmanaged first, with publisher and version) so you can add several at once. Right-click a solution to remove it from the tenant configuration. Columns and forms under a solution's table show only that solution's components; tables set to include all objects show all their columns and forms. **All tables** remains org-wide.
- Org sections load when you expand them and stay loaded until you click their refresh icon, so redrawing the tree never refetches. The refresh icon on the Solutions and Environment titles, or on a solution, also reloads the org's table list and the solutions' components, so a table created in the maker portal shows up (a table's columns and forms are refreshed from the metadata view).
- Right-click a workspace folder in the Explorer and choose **Configure as Tenant** to add it as a tenant. Lantern's files are added to the repo's `.git/info/exclude`, so they never show up as changes in the client's repo.
- **New Tenant Folder** clones the repo when you give a URL. If the folder already exists, it attaches it to the repo without overwriting local files. It then restores NuGet packages for any `.sln`.
- The **status bar** shows the active file's client and environment, in the warning color on a protected environment. Click it for that client's actions, including switching environments.

### Environments (DEV, TEST, PROD)

A tenant can have several environments. Right-click the environment row in the Tenant view and choose **Add Environment…**. It opens as an editor tab: the environments your account can open are listed on the left (from the Global Discovery Service; **Enter an org URL…** for one that isn't listed), and the name, org URL and whether to protect it are on the right, with a name suggested from the org's own name (`contosodev` suggests DEV) and PROD-like names protected by default. The first time, the same page also asks what to call the org the tenant uses now, so it becomes one of the environments. Add stays off until the name and URL are valid. Switch by clicking the environment row or the status bar.

Everything follows the active environment: tables, queries, traces, steps, and pushes. Each environment keeps its own metadata cache, its own pac profile, and its own account.

A **protected** environment (PROD, typically) asks for confirmation before anything that changes it: pushing web resources or plug-ins, publishing, importing solutions, `UPDATE`/`DELETE`/`INSERT`, CSV imports, registering or toggling steps, environment variable edits, and user settings.

**Compare Environments…** (on the environment row or a solution) compares one solution between the active environment and another:

- solution version
- each table's columns (added, removed, type, required level, labels, choices) and forms (layout, header, event handlers, libraries)
- web resource contents, with **Diff Web Resources** to open changed ones side by side
- every custom plug-in step
- environment variable values

### Solutions

Right-click a solution for:

- **Export Solution…** as managed or unmanaged, into the client's `exports` folder (kept out of git) or anywhere you choose.
- **Copy Solution to Environment…** exports from the environment you're on and imports into another, for example DEV to TEST as managed, in one step.
- **Import Solution…** (also on the environment row and the Solutions view title) imports a zip into any of the client's environments and publishes.
- **Change Solution Version…** suggests the next revision, build, minor, or major version, or takes one you type.
- **Run Solution Checker** exports the solution, runs Microsoft's solution checker on it, shows a report with links to each rule, and puts issues matching local web resource files into the Problems panel.
- **Generate Documentation** writes `docs/<solution>.md`: tables with their custom columns and choices, forms with their libraries and event handlers, web resources with the functions in each and where they run, plug-in steps on those tables, and the solution's environment variables.

Each client gets its own pac auth profile, named after the folder, so switching between client tenants needs no manual `pac auth select`.

**Adding existing components**, like the maker portal's Add existing: right-click a plug-in project or registered assembly (its plug-in package when it's in one), a plug-in step, a web resource, a cloud flow, a table, or a column and choose **Add to Solution…**. The tenant's own solutions come first; managed ones and Default aren't offered. A step can bring the assembly it runs, and a flow its connection references, environment variables and child flows. A table goes in as metadata only, with everything in it, or with **the columns you pick**: a checklist where the columns already in that solution are ticked, so ticking adds and unticking takes one out (after asking). A column whose table isn't in the solution brings the table in as metadata only. **Remove from Solution…** takes a component out of a solution (the one it's listed under, or one you pick) and leaves it in the environment. Hover over any of these to see which solutions it's in.

Inside a solution, the **+** on **Tables**, **Web resources** and **Power Automate flows**, and on **Columns** and **Forms** under one of its tables, opens a searchable list of what isn't in the solution yet (custom ones first; your own unmanaged web resources), read from the org's current metadata, so a table or column created a moment ago is there. Tick several and they're all added: tables as metadata only or with everything in them, flows with or without what they need. **Open in Maker Portal** on a solution, table, column, form, web resource or flow opens it there, inside that solution: a column opens its table, a form opens the form designer, a web resource its solution's Web resources list (the maker portal has no page for one web resource; the editor opens from there), and a flow the Power Automate designer.

### Search

Run **Lantern: Search** from the Command Palette to search the selected tenant's active Dataverse environment. Each command is:

| Command | What it searches | Example |
| --- | --- | --- |
| `pa <flow name>` | Power Automate cloud flows by name. | `pa test` |
| `t <table name>` | Tables by display, logical, or schema name. | `t account` |
| `br <business rule name>` | Business rules by name. | `br approval` |
| `a <app name> e` | Model-driven, canvas, and code apps by name; `e` opens the selected app for editing. | `a sales e` |
| `a <app name> r` | Model-driven, canvas, and code apps by name; `r` runs the selected app. | `a sales r` |
| `s <solution name>` | Solutions by unique or friendly name. An exact unique name opens directly; a partial name shows matches. | `s CrmCore` or `s crm` |

Component searches are global by default. To make the scope explicit, put `g` first: `g pa test`, `g t account`, `g br approval`, or `g a sales r`. To search only one solution, put `s <solution unique name>` first: `s CrmCore pa test`, `s CrmCore t account`, `s CrmCore br approval`, or `s CrmCore a sales e`. A solution-scoped result opens in that solution's context. App searches always require `e` or `r` at the end.

| Scope parameter | Value | Meaning |
| --- | --- | --- |
| `g` | None | Explicitly searches the whole selected environment. |
| `s` | Exact solution unique name when followed by a component command | Limits that component search to one solution. Used alone, it searches solution names. |

Results show each component's index, name, and solution memberships. The Default Solution is omitted from the membership list. Select a component to open it in the active environment's configured browser and profile. Solution results show friendly and unique names. Classic workflows and desktop flows are excluded from `pa` results.

Code apps run in the browser, but their source is edited locally. Selecting a code app from an `a ... e` search reports that Lantern cannot locate its source from Dataverse.

Expand **Tenants > selected tenant > Solutions > your solution > Power Automate flows** to browse flows in that solution. Use Lantern's Refresh action to reload the list after changing flows.

### Web resources

- **Push to Dataverse** (CodeLens, editor title, Explorer context menu, or `Ctrl+Alt+U` / `Cmd+Alt+U`) updates the web resource and publishes it. Multi-select in Explorer pushes several and publishes once. If the web resource doesn't exist yet, you can create it and choose the solution.
- **Compare with Dataverse** (`Ctrl+Alt+D` / `Cmd+Alt+D`) shows a diff of the live version against your file.
- **Push on save** is off by default (`lantern.pushOnSave`).
- Web resources named without an extension (like `new_AccountFormOnLoad`) are recognized from the solution's `.data.xml` and open as JavaScript, HTML, CSS, or XML as appropriate. New web resources are easier to work with if their names include a folder path and extension, like `contoso_/scripts/account.js`.
- The web resource name comes from the solution's `.data.xml`, a `webResourceRoots` folder in the client settings, or the path after `WebResources/`. If none apply, you're asked to confirm a guess.

### TypeScript web resources

**Set Up TypeScript Web Resources** (client right-click) creates `ts/tsconfig.json`, typed with `@types/xrm`, compiling into the web resources folder you pick. Saving a `.ts` file under it compiles the project and pushes the compiled `.js` (turn the push off with `lantern.typescript.pushOnSave`). **Compile and Push** does the same on demand. TypeScript must be installed (`npm install -D typescript` in the workspace folder).

### Plug-ins

Lantern treats a plug-in project in your folder and its registration in Dataverse as one thing. The assembly is matched by name, and each class by its full type name, which is the name Dataverse stores for a plug-in type. The Plug-ins list in the Environment view, the CodeLens on each class, and the steps and traces that open a class all use the same matching.

**Build and Push Plug-in** (`Ctrl+Alt+U` in a plug-in class, the CodeLens above each class, the Environment view, or a `.csproj` in Explorer) runs `dotnet build`, reads the built DLL, and registers it through the Dataverse Web API. There's no `pac` step and no IDs to paste.

- The first push registers the assembly (sandboxed, stored in Dataverse) and a plug-in type for every plug-in and workflow activity class, and asks which solution to add it to.
- Later pushes replace the registered assembly's content, so its steps stay, and register any classes that are new.
- Classes you deleted from the code are listed with their steps. Dataverse refuses the update while they're registered, so Lantern offers to unregister them (steps first) or stop.
- Before sending anything, it checks what Dataverse would refuse: a change to the first or second part of the version (it offers to register the build as a separate assembly instead), a different signing key or culture, or an assembly that came from a managed solution or a plug-in package.
- Plug-in assemblies need a strong name. For a new assembly, Lantern can create a key file and turn on signing. For a registered one, it looks through your folders for a `.snk` with the registered public key token and offers to use it.
- Plug-in packages (`.nupkg`, named by `PackageId`) are created or updated as packages, and Dataverse registers the classes inside them. A project that builds both a `.dll` and a `.nupkg` (projects from recent `pac plugin init` templates package on build) is pushed the way the org already has it: a registered assembly keeps getting the `.dll`, a registered package the `.nupkg`. When neither is registered yet, Lantern asks once which to deploy and remembers it for the tenant (`pluginDeploy` in the client settings). An incremental build recompiles the DLL but keeps the last `.nupkg` (NuGet doesn't count the DLL the plug-in package targets add as an input), so before building a project that packages on build, Lantern deletes its last `.nupkg` and `.nuspec`. After the build it checks that the package holds the DLL just built and won't push one that doesn't; when the environment's package already has this exact build, it asks before pushing it again. The Output panel names the file pushed, when it was written, and the assembly version inside. **Unregister Plug-in Package…** (right-click Plug-ins, a registered assembly, or a project's "version in environment" row) removes a package the way the Plugin Registration Tool does: it shows the package's assemblies, plug-in types and steps, then unregisters the steps first (Dataverse requires it) and the package, which takes its assemblies and types with it.

Registering a new assembly first opens a page (an editor tab) with what the Plugin Registration Tool would let you set: the assembly's description and isolation mode, and, picked from the list on the left, each class's name, display name, description and workflow activity group. A new package gets the same page for its name and unique name, which has to start with the chosen solution's publisher prefix (Dataverse refuses one without it; the rule is shown next to the field). **Edit Plug-in Registration…** (the pencil on a registered assembly or class, its right-click menu, or a click on the project's "version in environment" row) opens the same page for what's registered; Save stays off until something changed and is valid, and everything is saved together. Display names show beside the classes in the tree. Nothing is sent until Register or Save; Cancel or Escape closes the page without changes.

**Get Plug-in Source from Dataverse…** (right-click Plug-ins, or an assembly with no project here) downloads the registered DLL and decompiles it with ILSpy's command-line tool into a project in the client folder. The project gets a clean `.csproj` with the Dataverse SDK packages, the framework references the DLL uses, and signing with the original key when Lantern finds it in your folders. From then on it's an ordinary plug-in project, and Build and Push updates the same registered assembly. If a project in your folder already builds that assembly, Lantern doesn't make a second copy and offers a comparison instead. Assemblies from managed solutions get a warning first, since a vendor's license may not allow decompiling.

**Compare Deployed Plug-in with Local** (`Ctrl+Alt+D` in a plug-in class, the CodeLens, or right-click) builds your project, downloads what's registered, decompiles both, and lists the files that differ, each opening as a diff. Because both sides are decompiled, comments and formatting don't count as differences.

Decompiling can't recover comments, local variable names, or the signing key. Dataverse doesn't keep the `.snk`, and the DLL only carries the public half, so without the original key a rebuilt DLL can't update the registered assembly in place. If nobody has the key, change the first or second part of the version, push to register the build as a separate assembly, and move the steps to it.

**New Plug-in Project…** (client right-click) runs `pac plugin init` in `Plugins/<name>`. **New Plug-in Class…** (right-click a plug-in project) adds a plug-in, a Custom API handler, or a custom workflow activity in the project's namespace. Plug-ins use the project's `PluginBase` when it has one.

Above each plug-in class, a CodeLens shows the class's registration in the active environment: its steps (like "2 steps: Update of account, Create of account (off)"), or "Not registered in DEV yet". Clicking the steps line shows the class in the Lantern view with its steps expanded. The CodeLens also offers **Build and push**, **Register step** with the class already chosen, and **Compare with deployed**.

### Plug-in steps, traces, and system jobs

- **Register Plug-in Step…** (the **+** on Plug-ins > Steps, or right-click an assembly or a plug-in class) opens a page for the new step: the plug-in class, message (the common ones, or any other by name), table, solution, stage, synchronous or asynchronous, execution order, filtering columns (a searchable checklist from the table's metadata), run-as user, unsecure configuration, and images added from the list on the left, each with its alias, type and columns. The name follows the class, message and table until you type one. Register stays off while anything is wrong, and a message that doesn't exist (or isn't available for the table) is reported on the page.
- **Edit Step…** (the pencil on a step, or right-click) opens the same page for a registered step: name, description, stage, synchronous or asynchronous, execution order, filtering columns, run-as user (type to search by name or sign-in), deleting the system job on success, unsecure and secure configuration, and its images (add one, change its alias, type and columns, remove it). Dataverse's rules are checked as you go and shown next to the field they're about: asynchronous only post-operation, post-images only post-operation, no pre-image on Create, no post-image on Delete, no two images with the same alias. Save stays off while any remain or nothing changed; nothing is sent until Save. **Unregister Step…** deletes a step with its images and secure configuration after asking.
- **Debug Plug-in Step…** (the debug icon on a step, or right-click). A plug-in runs in Dataverse's sandbox, so nothing can attach to it live; the way to debug one is to record a run and replay it locally. Lantern turns the step's profiler on (the Plugin Registration Tool's trace-log profiler, a flag on the step; no profiler solution), sets the org's plug-in trace logging to All if it isn't (asking first; every plug-in then writes trace logs), builds the project in Debug so there are symbols, adds an attach configuration to `.vscode/launch.json` (`clr`, the C# extension's .NET Framework debugger, process `PluginRegistration`), then waits while you trigger the step in the app. When the run arrives in the trace log it saves the profile to `.lantern/profiles/<Class>.<Message>.<table>.<time>.profile` and opens the Plugin Registration Tool (from the NuGet cache, or through `pac tool prt`). In the tool: connect to the org, **Replay Plug-in Execution**, pick that profile and the Debug DLL; in VS Code set breakpoints and start the attach configuration; then **Start Plug-in Execution** in the tool. The step shows as "profiling" in the tree until **Stop Profiling**, which also offers to put the trace logging setting back. Replaying calls `IOrganizationService` against the real environment, so a plug-in that writes data writes it again.
- **Steps** lists your custom steps by assembly, showing message, table, stage, and whether each runs asynchronously. Turn a step off or on from its right-click menu, or click it to open its plug-in class in your code.
- **Traces** lists the newest plug-in trace log entries, with failures marked. Click one to read its trace output and exception, or use **Go to Plug-in Class** to open the class in your code. The filter icon narrows to errors only, a time window, or a plug-in name. If trace logging is off in the org, Lantern offers to turn it on (it asks first, since it's an org-wide setting).
- **System jobs** lists async operations, failed ones by default: workflows, async plug-ins, and system jobs, with their error messages. Right-click a job to open the record it ran against.
- **Check Step Against Its Code** (right-click a step) reads the step's plug-in class and compares it with the step's registration. It lists the columns the class reads and writes, from Target, images, or other rows, and flags common mistakes: reading an image the step doesn't register, reading a column an image doesn't include, and on Update, reading a column from Target that won't be there unless it changed.

### Typed IntelliSense for scripts and C#

- **JavaScript, generic:** `@types/xrm` through each client's `jsconfig.json`.
- **JavaScript, org-specific:** **Generate JS Form Types** runs XrmDefinitelyTyped and switches that client to the generated types, so field names and form controls are checked.
- **C# classes:** right-click a table in the Environment view and choose **Add to C# Classes…**, then pick the columns your plug-ins use on the page that opens: a searchable checklist, custom columns first, with the columns already in your class and in the solution ticked, and the output folder and namespace above it the first time. Tables wait in a queue, shown in the status bar (**C# classes: N tables queued**) until you generate; click it to change a table's columns, remove tables, add more, or **Generate**. **Generate C# Classes…** on a tenant opens the same queue. Lantern writes one partial class per table from the org's metadata, with only the picked columns, choice columns as enums, a `Fields` class of column names, and XML comments on every member (no `#pragma warning disable`). The namespace is confirmed when you generate (empty for none). Regenerating doesn't lose anything: the columns already in a class come pre-picked, a column that's only in your code is kept as written, choice columns keep the enum type your code uses, and tables you don't queue keep their files. A class that shares its file with other classes is left alone. Old-style projects get `<Compile Include>` entries for new files; `[assembly: ProxyTypesAssembly]` is added once if the project doesn't have it. Right-click a **column** and choose **Add C# Property** to add just that column to its table's class right away; properties are in alphabetical order by column, the primary key first. In a class file, the CodeLens above each class has **Edit Columns (N)**, to tick and untick its columns and rewrite the file, and **Update from Dataverse**, to regenerate it with the same columns and current names, descriptions and choices. AI assistants can do the same from a pasted user story with the `lantern_generate_csharp_classes` tool (AI Tools): it matches display or logical names, only adds, and queues the tables for you to review unless you ask for the files now.
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

### Command bar

**Open Command Bar…** (right-click a table under a solution or All tables, or run it from the command palette and pick a table) is Lantern's command bar editor: the table's ribbon as an editor tab, loaded with `RetrieveEntityRibbon` for the form, main grid and subgrid, plus the modern commands (`appaction` rows) of every app. On the left, every location → tab → group → control (buttons, split buttons with their menus, flyouts, toggles), then each app's modern commands, then your own commands and rules; on the right, the selected control with a preview of the bar it sits in (icons from your image web resources, your buttons outlined, hidden ones left out), its label, tooltip, icon, command, the command's actions (JavaScript function with library and parameters, URL, dialog) and its enable and display rules, each rule in words ("The user can write account records (at least their business unit's)", "The form is not read-only", "Acme.Account.canApprove in acme_/account/ribbon.js returns true").

The RibbonDiffXml for the table in your local solution folders (`Entities/<Table>/RibbonDiff.xml` from `pac solution unpack`, or the `<RibbonDiffXml>` in a `customizations.xml`) is laid over it: controls, groups, tabs, commands and rules your solution defines are tagged **yours** (tick **Only my solution's** to see just those), buttons your diff adds that aren't in the environment yet show as *local only*, and the controls it hides are listed under **Hidden by your solution**.

What's yours can be edited, the way the Ribbon Workbench does it, with the checks done as you type:

- **Buttons**: label and tooltips (kept as LocLabels, other languages untouched), sequence, command, modern icon name and 16×16 / 32×32 image web resources. **Add Button** on a group makes a new one (Id from your publisher prefix, fixed once saved); Microsoft's and other solutions' buttons can be hidden (a HideCustomAction) and unhidden.
- **Commands**: actions (JavaScript function with its library picked from the workspace's scripts and its parameters, or a URL), and the enable and display rules they use, picked from every rule in the ribbon or created new.
- **Rules**: steps of any kind (custom rule with function and library, form state, value, privilege, selection count, client type, …) with the attributes each takes, explained in words as you edit.
- **Modern commands**: label, tooltips, location, type, sequence, hidden, the JavaScript function and library (or the names of the Power Fx function and component library; the formula itself is edited in the command designer), the font icon or icon web resource, and new commands for an app.

Every JavaScript function the commands, custom rules and modern commands call is checked the way the form-script warnings are: the library has to be a web resource in the client folder and the function has to be defined in it. Those are warnings, shown next to the action and counted on the button in the list; what Dataverse would reject (a missing label or command, an Id without your prefix, an empty rule) is a problem that keeps Save off.

**Save** (the **Save options** row says where) writes the RibbonDiffXml to your solution folder (`Entities/<Table>/RibbonDiff.xml`, or the table's entity in a `customizations.xml`), writes the modern commands to the environment (created in the chosen solution, changed, or deleted, then the apps touched are published), and, with **Publish to <environment> now** ticked, publishes the classic command bar: Dataverse only takes a ribbon through a solution import, so Lantern exports the solution you pick, puts the RibbonDiffXml into its customizations.xml, imports it and publishes the table. A small solution that holds just the table is fastest; a big one works but takes as long as its export and import do. Protected environments ask first. Not covered: Power Fx formulas, the application ribbon, and changing Microsoft's buttons beyond hiding them.

### Tables and metadata

Each solution's **Tables** lists that solution's tables, and **All tables** under the client lists every table in the org, system tables like `systemuser` included. **Find Table** (the search icon on All tables) jumps to one by display name or logical name.

- **Columns** show display name, logical name, type, and whether they're required. Hover for schema name, max length, lookup targets, and description. Choice and yes/no columns expand to their values and labels.
- **Forms** expand to tabs, sections, and controls with the exact names for `tabs.get()`, `sections.get()`, and `getControl()`. Composite fields (addresses, full name) list their inner controls, like `address1_composite_compositionLinkControl_address1_line3`.
- **Event handlers** shows which function runs on load, save, and each column's change, and flags handlers that don't get the execution context. Click a handler (or right-click, **Go to Function**) to jump to its definition in your local copy of the library. If the library isn't in the client folder, you can open a read-only copy from Dataverse instead. If the function can't be found in the file, you get a warning, since the form would fail at runtime.
- The right-click menu on tables, columns, choice values and form parts has the same order everywhere: open (Table Reference, **Open in Maker Portal**, browser), find (where used, dependencies), **Query ›**, **Copy ›**, **JavaScript ›** and **C# ›**, data (Import CSV), solution (Add to, Remove from), refresh.
- **JavaScript ›** inserts `formContext.getAttribute("…")` or `getControl("…")` for a column (with the control's name from the forms, so a column inside a composite field gets its composite link control), `setValue(…)` for a choice value, or a tab's or section's `formContext.ui.tabs.get(…)`; it also has **Add Script Model Property** (column) and **Add to Script Model…** (table).
- **C# ›** inserts `entity.GetAttributeValue<T>(…)` or a typed set for a column (using the generated class's `Fields` constant when there is one), or `new OptionSetValue(…)` for a choice value; it also has **Add C# Property** (column) and **Add to C# Classes…** (table).
- **Script models** are the JavaScript or TypeScript counterpart of the C# classes, for form scripts and web resources: one class per table, named like the C# class: `Acme.Models.Account` has the table's logical, entity set, primary ID and name and `fields` (the picked columns' logical names) as statics, an enum per choice column (`Account.statuscode.Inactive`), and an instance is a record whose properties are the values, like the C# class's: `new Acme.Models.Account(formContext)` reads and writes the form (`account.statuscode = Acme.Models.Account.statuscode.Inactive`), and `new Acme.Models.Account(row)` wraps a `Xrm.WebApi` row with lookups as `Xrm.LookupValue[]`, dates as `Date` and multi-selects as numbers, so `retrieveRecord(Account.logicalName, id).then((row) => new Account(row))` gives the same object either way. `account.fields.<name>` has the column's `.attribute`, `.control`, `.controls` (every control of the column: header, business process flow, duplicates) and `.name`, like `account.fields.primarycontactid.control?.addPreSearch(…)` or `account.fields.name.controls.forEach((c) => c.setDisabled(true))`. A column that isn't on the form reads as `null` (no controls) and ignores sets; a row-backed instance has no attributes or controls and holds what you set; `account.field("…")` works for any column, and `recordId` is the row's ID. A column that only appears inside a composite field (full name, address) has no control of its own name, so `.control` and `.controls` fall back to the composite's link control, like `fullname_compositionLinkControl_firstname`. In TypeScript everything is typed (the matching `Xrm.Attributes` and `Xrm.Controls` types, values as `string`, `number`, `Date`, `Xrm.LookupValue[]`, and each choice column's enum, so a wrong value doesn't compile), and `Account.Row` is the raw `Xrm.WebApi` row shape if you want it. They're plain global scripts (no modules), so they work as a form library and with `module: none` tsconfigs. The columns are picked on a page like the C# classes': a searchable checklist, custom columns first, with the folder, language (TypeScript is suggested when the folder has a `tsconfig.json`) and namespace above it until they're set. Columns are alphabetical with the primary key first; what's in a model comes pre-ticked, and so do the solution's columns when you start from a table under a solution (the same goes for Add to C# Classes); a column gone from Dataverse is kept by name. The CodeLens above a model has **Edit Columns** and **Update from Dataverse**.
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

**New Query** (the database icon in the Environment view, or a tenant's right-click menu) opens a SQL document aimed at that tenant. Write SQL against Dataverse tables and press **F5** (or click **Run** above the query). Select part of the document to run just that part. Several statements separated by `;` or `GO` each get their own results.

```sql
SELECT TOP 50 a.name, a.revenue, c.fullname AS primary_contact
FROM account a
LEFT JOIN contact c ON c.contactid = a.primarycontactid
WHERE a.statecode = 0 AND a.name LIKE 'Con%'
ORDER BY a.revenue DESC
```

```sql
SELECT name FROM account a
WHERE a.statecode = 0
  AND NOT EXISTS (SELECT 1 FROM contact c WHERE c.parentcustomerid = a.accountid AND c.statecode = 0)
```

Supported SQL:

- `SELECT` with `TOP` and `DISTINCT`, `*` and `alias.*`, and column aliases
- `INNER` and `LEFT JOIN` on one `a.col = b.col` condition
- `WHERE` with `=`, `<>`, `<`, `>`, `LIKE`, `IN`, `IS NULL`, `BETWEEN`, `AND`, `OR`, and `NOT`
- Subqueries as conditions: `[NOT] EXISTS (SELECT ...)` and `column [NOT] IN (SELECT column FROM ...)`, anywhere in the `WHERE`, including under `OR` and `NOT`, and inside one another. A subquery is a table, with `INNER JOIN`s if needed, whose `WHERE` links it to the query around it on one equality (`c.parentcustomerid = a.accountid`; for `IN`, the selected column and the outer column are the link) and whose other conditions filter the related rows. They become `<link-entity link-type="any">` or `"not any"` inside the filter, so each outer row comes back once and the related rows' columns aren't returned. The link normally goes to the `FROM` table; it can go to an `INNER JOIN`ed table when the subquery is combined with the rest of the `WHERE` by `AND` (it's written inside that join). Lantern says why when FetchXML can't express a subquery: no linking condition, a link that isn't a plain `=`, a link to a `LEFT JOIN`ed table or to a query further out, a `LEFT JOIN`, `GROUP BY`, `ORDER BY`, `TOP` or aggregate inside the subquery, a condition on a subquery's joined table under `OR`, a subquery in `SELECT` or `FROM`, or `= (SELECT ...)`. `NOT IN (SELECT ...)` runs as `NOT EXISTS`, so `NULL`s in the subquery's column don't empty the result the way they do in SQL Server. Copy as code writes them as `QueryExpression` filters with `AnyAllFilterLinkEntity`.
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
- Queries stop after `lantern.query.maxRows` rows (5,000 by default) unless they use `TOP`. The progress notification counts the rows so far, and **Cancel** stops the query between pages. Dataverse returns at most 250 rows per page when a File column is selected (and the column comes back empty), so leave file columns out of big queries or use `TOP`.

**Saved and recent queries:** **Save Query…** (right-click in a query) saves it to the client's `queries` folder, which the **Queries** node in the tree lists. **Recent** under it keeps your last 30 queries per client, with the environment and row count.

**UPDATE, DELETE, and INSERT** run with a preview. SQL Server's `UPDATE a SET a.fax = NULL FROM account a WHERE ...` and `DELETE a FROM account a WHERE ...` forms work too, with one table in `FROM`. `UPDATE account SET fax = '555-0199' WHERE statecode = 0` first finds the matching rows, then asks "Set fax = '555-0199' on 12 Account rows?" and lists the first ten by name, with a stronger warning when there's no `WHERE`. Nothing changes until you confirm, and the results show each row's outcome. The changes go to Dataverse in Web API batches, several at a time, tuned while they run for the most rows per second: the number in flight starts at four and doubles every ten seconds while a row takes no longer than it did with fewer, then moves a quarter at a time, up while the rate still rises and back when it falls (past some point more parallel batches only make every row slower), within the environment's own recommendation (`x-ms-dop-hint`); each batch is sized to take about five seconds (20 rows to start, then 5 to 100 depending on how long a row takes). So deleting or updating thousands of rows takes seconds rather than minutes; the progress notification counts the rows done, Cancel stops after the batches already in flight (rows not sent show as skipped), a row that Dataverse refuses shows its error without stopping the others, and the Output panel logs how long finding the rows and changing them took. Text, number, yes/no, choice (number or label), date, and lookup columns can be set. A lookup takes a record ID, or `'table:ID'` for customer and owner lookups (`SET ownerid = 'team:…'`), and `NULL` clears it. A File column is cleared with `NULL` too, which deletes the file; files can't be set from SQL. For bulk changes where the table's custom logic is the slow part, end the statement with `OPTION (BYPASS PLUGINS)` to run it without custom synchronous and asynchronous plug-ins and workflows (Dataverse's `BypassBusinessLogicExecution`; `BYPASS SYNC PLUGINS` or `BYPASS ASYNC PLUGINS` for one kind; system administrators have the privilege it needs, Microsoft-published logic still runs), and `OPTION (BYPASS FLOWS)` to not trigger Power Automate flows (`SuppressCallbackRegistrationExpanderJob`; no privilege needed, flow owners aren't told). The confirmation says what's bypassed. If Dataverse throttles the batches (429), Lantern waits out its Retry-After, halves the batches in flight, and grows back one at a time. `INSERT INTO account (name, industrycode) VALUES ('Contoso', 'Accounting'), ('Fabrikam', 2)` creates rows after showing how many.

**Import CSV…** (right-click a table) matches the file's headers to columns by logical, schema, or display name, previews the rows in the results panel, then asks before importing. Rows with a value in the table's ID column (like `accountid`) update that record, and the rest are created. Empty cells are left alone, and headers that don't match a column are listed and skipped. The rows go to Dataverse in the same batches as `UPDATE` and `DELETE`, with progress, Cancel and a per-row result.

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

### AI tools (Claude Code, Codex, Copilot)

**AI Tools** (the ✨ on the Tenant view) opens a tab with a card per assistant. **Claude Code** and **Codex**, the CLI and the VS Code extension alike, connect to Lantern's MCP server, which runs inside VS Code on `127.0.0.1` with a token. **Set Up** writes their configuration (`~/.claude.json` for Claude Code; `~/.codex/config.toml` for Codex, which starts `~/.lantern/lantern-mcp.js` to forward to the server), **Remove** takes it out again, and the configuration can be copied to paste elsewhere. **Copilot** gets the same tools directly in Copilot Chat's agent mode, where you can also reference them with `#`. The server runs only while `lantern.mcp.enabled` is on (Set Up turns it on) and `lantern.mcp.port` sets its port; both are machine settings, so a repository's workspace settings can't change them. The tools read from the environment selected in Lantern.

| Tool | In Copilot | What it does |
| --- | --- | --- |
| `lantern_tenants` | `#lanternTenants` | Tenants, environments and solutions, and which are selected |
| `lantern_describe_table` | `#lanternTable` | A table's columns, choices, lookups, forms and handlers |
| `lantern_query` | `#lanternQuery` | A read-only SQL or FetchXML query (you confirm each one) |
| `lantern_where_used` | `#lanternWhereUsed` | Where a column is used: forms, views, processes, plug-in step filters, and up to 40 lines of code (files that also name the table first; **Find Where Column Is Used** in VS Code lists them all) |
| `lantern_search_flows` | `#lanternFlows` | Cloud flows by name, or by what they do: `email`, `teams`, `approval`, `http`, `sharepoint`, `childflow`, `dataverse-write`, or any text in the definition |
| `lantern_explain_flow` | `#lanternFlow` | A flow's trigger, its steps with their connectors and parameters, conditions and loops, and connections |
| `lantern_explain_plugin` | `#lanternPlugin` | A plug-in's registration, steps and images, and its source when the project is in the folder; with no plug-in named, the registered assemblies (the tenant's own first, Microsoft's on one line) |
| `lantern_explain_web_resource` | `#lanternWebResource` | A web resource's content, functions, and the forms and events that load it |
| `lantern_trace_column` | `#lanternColumn` | Everything that can make a field behave a certain way: its definition, forms, form-script lines, business rules, workflows, flows, plug-in steps and code (code capped like `lantern_where_used`) |
| `lantern_generate_csharp_classes` | `#lanternCSharpClasses` | Tables and columns from a pasted user story into the C# classes queue, or written when asked; it only adds |

So you can ask "which flows send email?", "what does the Notify Owner flow do?", "why does Credit Hold get set on accounts?" or "generate the C# classes this story needs", and the assistant uses the tools. None of them change data in the environment; `lantern_generate_csharp_classes` writes class files in your folder. Copilot needs a VS Code version with language model tools.

## Configuration

### Client settings

Lantern uses one selected tenant at a time. In the default `global` mode, saved tenants live in Lantern's global extension storage and are available in every VS Code window. No tenant is selected when a window opens; use **Select Tenant** or **Add Tenant** in the title bar of the Tenant view, at the top of the Lantern side bar. The Tenant view also shows the active environment and account; click either to switch. In `folder` mode, only tenants in `.lantern/config.json` at an open workspace root are available. Set `defaultTenant` to a tenant name to select it when the folder opens. **Edit Tenant Configuration** opens the active mode's JSON. Switching modes never moves or deletes settings. Root-level `client.json`, root-level `config.json`, `.lantern/client.json`, and `xdt.json` are ignored.

For multiple tenants in one local config, use a list. `defaultTenant` selects the tenant when the folder opens, and each tenant's `defaultEnvironment` selects its initial Dataverse environment. **Switch Environment** changes the current window without changing that default.

```json
{
  "defaultTenant": "Contoso",
  "tenants": [
    {
      "name": "Contoso",
      "defaultEnvironment": "DEV",
      "environments": [
        { "name": "DEV", "org": "https://contoso-dev.crm.dynamics.com", "defaultBrowser": "firefox", "defaultProfile": "contoso-dev" },
        { "name": "PROD", "org": "https://contoso.crm.dynamics.com", "protected": true }
      ],
      "solutions": ["ContosoCore"]
    }
  ]
}
```

Set `defaultBrowser` and `defaultProfile` on an environment to open its Dataverse and Power Automate links with `firefox -P <profile> <url>`. Without `defaultBrowser`, Lantern uses the system default browser. Clicking a flow or typing its search result number opens its Power Automate editor.

Existing single-tenant `.lantern/config.json` files still load with the folder name as their tenant name.

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
  "csharpClasses": { "outDir": "Plugins/Models", "namespace": "Contoso.Plugins.Models", "entities": ["account", "contact"] },
  "plugins": { "Contoso.Plugins": "00000000-0000-0000-0000-000000000000" },
  "pluginDeploy": "assembly",
  "fileTables": { "scripts/utils.js": "account" }
}
```

`environments` and `environment` are managed by Add Environment and Switch Environment; with no environments, `org` is the single org. `accounts` holds the account per environment and `account` the default (both set with **Sign In As…**). `tenant` is only needed for a guest account in the client's tenant, or for the `azureCli` sign-in method.

The one file Lantern writes into a client folder is `jsconfig.json`, which typed Xrm IntelliSense needs. Lantern adds it, and its other local files (`typings/`, `.pull-backup/`, `exports/`), to the local exclude list (`.git/info/exclude`) of whichever repo holds the folder, even when the repo's root is above it. They never show in Source Control and no `.gitignore` changes are needed. Turn the file off with `lantern.createJsconfig`.

**Remove Tenant…** (tenant right-click) removes the tenant from the tenant configuration after asking. The folder and its files, including `jsconfig.json`, are left as they are.

### VS Code settings

| Setting | Default | Notes |
| --- | --- | --- |
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
| `lantern.clientSettingsLocation` | `global` | Use globally saved tenants (`global`) or tenants from a workspace root's `.lantern/config.json` (`folder`) |
| `lantern.createJsconfig` | `true` | Create `jsconfig.json` in client folders for typed Xrm IntelliSense |
| `lantern.mcp.enabled` | `false` | Run Lantern's MCP server for Claude Code and Codex (AI Tools' Set Up turns it on). A machine setting |
| `lantern.mcp.port` | `39847` | The MCP server's port on `127.0.0.1`. A machine setting |

### Logs

Lantern writes a daily log to `~/.lantern/log/YYYY-MM-DD.log` (for example, `C:\Users\you\.lantern\log\2026-10-16.log` on Windows). It includes Lantern Output, reported errors, search activity, Dataverse request status and timing, and command-line process exit status. Dataverse request logs omit authentication tokens, query parameters, and request bodies.

## Sign-in and multiple accounts

Lantern signs in two ways, and both follow the account you choose for each client:

- **pac** (solution export and import, PCF, Power Pages) keeps one profile per client, named after the folder, created on first use.
- **The Dataverse Web API** (everything else) uses VS Code's Microsoft account sign-in.

Opening a window or selecting a tenant never asks you to sign in. Lantern checks the connection quietly; when it can't sign in that way, it offers **Sign In As…**.

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

This compiles the extension and runs these suites, stopping at the first that fails:

| Suite | What it covers |
| --- | --- |
| `test/unit.js` | Edge cases for the core modules: SQL translation, script and plug-in analysis, records, environments, CSV, lookups, comparison, sign-in, the Web API client, and the manifest |
| `test/regression/` | One file per area (queries, plug-ins, command bar, tenants, AI tools, build tools, code generation, core), each case a bug that was fixed; `all.js` runs every file in its own process |
| `test/flows.js` | Cloud flows in solutions: filtering, batching, missing solutions, environment routing, and the tree's cache |
| `test/panels.js` | The editor-tab pages (property sheets) driven through their messages |
| `test/run.js` | End-to-end runs of every command against fake `pac`, `dotnet`, and `tsc` command-line tools, real git, and a fake Web API, including pressing Esc at every prompt in the Command Palette and simulated Dataverse outages |
| `test/webview.js` | Loads the query results panel in Chromium for every kind of result and clicks through it |
| `test/panelsBrowser.js` | Loads every editor-tab page in a browser, pokes every control, and fails on a script error or CSP violation |

The two browser suites need Playwright (`npm install -g playwright`) and skip themselves without it. You can run a single suite with `node test/unit.js` (after `npm run compile`); a regression file also runs against another build with `LANTERN_OUT=<folder>`.

### Project layout

| Folder | Contents |
| --- | --- |
| `src/extension.ts` | Activation and command registration |
| `src/commands/` | Command handlers: the prompts and flows behind each command |
| `src/core/` | Dataverse Web API client, SQL translation, plug-in assembly reading and registration, code analysis, and other logic |
| `src/ui/` | Tree views, editors, CodeLens, diagnostics, the results panel, the editor-tab pages (`panels/`), sign-in, and the AI tools |
| `src/mcp/` | The MCP server for Claude Code and Codex, and the bridge Codex starts |
| `schemas/` | JSON schemas for client settings and Custom API definitions |
| `snippets/` | JavaScript and C# snippets |
| `media/` | Icons and walkthrough content |
| `test/` | The test suites, the VS Code mock, and the fake command-line tools |

### Guidelines

- **Add tests with your change.** New commands get an end-to-end step in `test/run.js`, new parsing or analysis logic gets cases in `test/unit.js`, and a bug fix gets a case in its area's `test/regression/` file that fails without the fix.
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

- XrmDefinitelyTyped is a .NET Framework tool and only runs on Windows.
- Older non-SDK-style plug-in projects may need Visual Studio or MSBuild to build.

## License

Lantern for Dataverse is released under the [MIT License](LICENSE). By contributing, you agree that your contributions are licensed under the same terms.
