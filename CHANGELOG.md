# Changelog

All notable changes to Lantern for Dataverse are listed here, newest first.

## Unreleased

### Changed

- Internal storage mode ignores local configuration files and requires explicit client initialization. Switching storage modes does not migrate or delete settings; folder mode uses `.lantern/config.json` independently.

- Local client settings use only `.lantern/config.json`. Root-level `client.json`, `config.json`, and legacy `xdt.json` are no longer discovered or migrated as client settings.

### Added

- **Power Automate flows** under each solution: browse cloud flows in the active environment with their status, then click to open the designer in VS Code's Integrated Browser. Requires a desktop VS Code build with Integrated Browser support; portal sign-in is separate from Dataverse sign-in.

## 0.9.5

### Changed

- Each client has one **Plug-ins** item that holds everything plug-in related: **Projects** (your projects, matched class by class to the active environment, plus registered assemblies with no project in the folder), **Steps**, and **Traces**. Steps and traces moved there from the client level.
- The "N steps" CodeLens on a plug-in class shows that class in the Lantern view with its steps expanded.
- **Build and Push Plug-in** started from the tree picks from that client's projects instead of using the file open in the editor.

## 0.9.4

### Added

- **Signing help:** Lantern creates a key for a new assembly, or finds the original `.snk` in your folders by its public key token.
- **Get Plug-in Source from Dataverse** decompiles a registered assembly with ILSpy into a buildable project in the client folder, signed with the original key when it's found. It won't duplicate a project you already have.
- **Compare Deployed Plug-in with Local** decompiles both what's registered and your build, and opens the differences.
- The **Clients view** shows each plug-in class matched to its registration: its steps, not registered yet, or only in Dataverse. Registered assemblies with no project in the folder are listed too.

### Changed

- **Build and Push Plug-in** registers and updates assemblies through the Dataverse Web API instead of `pac plugin push`. The first push registers the assembly and every plug-in and workflow class; later pushes update the content and register new classes. Removed classes are unregistered (with their steps) only after you confirm. Version, signing key, culture, managed, and package problems are caught before anything is sent.
- The plug-in CodeLens covers every plug-in class in a file, including classes that inherit from a base class elsewhere in the project or in a shared project.
- Opening a class from a step or trace matches the full type name, preferring the project that builds that assembly.
- Plug-in packages are found by their `PackageId`.

### Fixed

- The pickers for step images and new plug-in classes set VS Code's reserved `kind` property on their items.

## 0.9.3

### Added

- **Remove Lantern from Folder** cleans up a folder that shouldn't be a client.
- `lantern.createJsconfig` turns off the `jsconfig.json` file.

### Changed

- **Client settings are kept outside client folders**, in Lantern's storage. Existing untracked `client.json` files move there automatically; tracked ones stay. Set `lantern.clientSettingsLocation` to `folder` to keep the in-folder layout.
- Project folders inside a repo you open directly aren't configured as clients anymore.

### Fixed

- Lantern's local files showed up as changes when a client folder was inside a larger repo. They're excluded wherever the repo's root is.

## 0.9.2

### Changed

- New icon: an abstract lantern made of folded ribbons in flame gradients, with a matching sidebar icon.

## 0.9.1

### Changed

- New icon: a lantern in flame gradients built from layered parts, with a matching sidebar icon.

## 0.9.0

### Added

- **App registrations (service principals)** in **Sign In As**, per environment, with the secret kept in VS Code's secret storage and masked in logs.
- **Pack and Import from Your Files** for pulled solutions.
- **New Plug-in Project** (`pac plugin init`) and **New Plug-in Class** (plug-in, Custom API handler, or custom workflow activity).
- **Registered steps on plug-in classes:** a CodeLens lists the class's steps and offers **Register step** for it.
- **PCF controls:** create, build, push, and start the test harness. Controls are listed under each client.
- **Power Pages:** download and upload sites with `pac pages`.
- **FetchXML in code:** **Run FetchXML** and **Edit as query** above FetchXML strings in JavaScript, TypeScript, and C#, with placeholder values and write-back.
- **Custom APIs** as files in the repo: deploy, generate a C# handler, and generate a typed TypeScript client.
- **Register Function as Form Event Handler** edits the forms' XML and publishes.
- **Script unit tests** with Jest and xrm-mock.
- **Copilot Chat tools:** clients, table descriptions, read-only queries, and where a column is used.
- A **Get started** walkthrough.

## 0.8.1

### Fixed

- **Queries:** FetchXML starting with an XML declaration or a comment ran as SQL and failed. `TOP` was ignored on grouped and aggregate queries. Double-quoted text explains that values take single quotes.
- **Script analysis:** commented-out code no longer counts in outlines, Go to Function, and live warnings, and regex literals containing braces no longer merge two functions together.
- **Records:** app URLs with `appid=` opened the app's ID instead of the record. Inspecting a record from the results grid works for any row.
- **Accounts:** choosing "Don't pin an account" on an environment fell back to the client's default account instead of unpinning.
- **Sign-in and the Web API:** a rejected token is replaced instead of reused until it expires, throttling (429) waits for `Retry-After`, and network failures say which org couldn't be reached. A background metadata load can no longer make the tree show "not signed in".
- **Environment comparison:** a side that can't be read is reported under "Not compared" instead of producing false "only in DEV" differences.
- **Command bar analysis:** functions are attributed to the right command (not a referenced enable rule), the `isNaN` no-op isn't treated as a web resource, and large customization files are read once.
- **Results panel:** toggling **Stored values** on an empty result threw a script error. Truncation notes no longer suggest `TOP` when the query already used it, and import previews and role grids get their own wording.
- **Plug-in checks:** reads through `Attributes.Contains`, image chains, and cast Targets are recognized, and reads guarded by `TryGetAttributeValue` or `Contains` aren't flagged.
- **Pushes:** a partial push reports what was skipped, and cancelling still publishes what was already pushed.
- **Elsewhere:** Find Table searches the client whose row you clicked. Client actions only offer the open file when it belongs to that client. Inserted snippets escape `\` and `}`. Generated documentation lists the solution's own environment variables and names anything it couldn't read. Pull Review recognizes git-ignored files with accented names. Tab labels prefer English. `account_main.js` maps to account. The Run CodeLens and the results title show the environment.

## 0.8.0

### Added

- **Environments per client** (DEV, TEST, PROD), added and switched from the client or the status bar. Each environment has its own metadata cache, pac profile, and account. **Protected** environments confirm before pushes, publishing, imports, data changes, step changes, and settings changes, and color the status bar.
- **Compare Environments:** a solution's version, columns, forms, web resource contents, plug-in steps, and environment variable values between two environments, with side-by-side diffs of changed web resources.
- **Solution operations:** export (managed or unmanaged), import, copy to another environment, change version, run the solution checker (issues go to the Problems panel), and generate documentation.
- **Live warnings** in form scripts for unknown columns, columns and controls not on any form, unknown tabs and sections, and handlers the file doesn't define.
- **Register Plug-in Step** with filtering columns and images.
- **Command bar awareness:** functions called from `RibbonDiffXml` count as used in outlines, reports, warnings, and documentation.
- **Go to Plug-in Class** from a trace entry.
- **Saved queries and Recent** under a client's Queries node.
- **FetchXML IntelliSense** for tables, columns, link-entity `from` and `to`, and operators.
- **INSERT**, lookups in **UPDATE** (set and clear), and **CSV import** with a preview.
- **Security:** view a role's privileges by table, and check and explain a user's access to a record.
- **TypeScript web resources:** set up, compile on save, and push the output.

## 0.7.0

### Added

- **Show Dependencies** on tables, columns, forms, web resources, plug-in steps, and environment variables, from Dataverse's dependency tracking, with names resolved and grouped by type.
- **What Does This Function Touch?** for form script functions: columns, controls, tabs, sections, Web API calls, and called functions, each checked against the table's forms. The "Runs on" CodeLens opens it.
- **Library Outline** for scripts: functions, where each runs, callers, and possibly unused functions.
- **Check Step Against Its Code** compares a plug-in step's images and filtering columns with what its class reads and writes.

### Changed

- **Find Where Column Is Used** names the function each code reference is in and where that function runs.

## 0.6.1

### Added

- **Add solutions from the tree:** the **+** on Solutions lists the org's solutions (unmanaged first, with publisher and version) so you can add several at once, then offers to pull. Remove a solution from its right-click menu. Unpacked folders the client doesn't list show up with a button to add them.

### Changed

- **Each solution holds its own Tables and Web resources.** Web resources open your local copy, or the Dataverse version if you haven't pulled. The client-level **All tables** lists every table in the org.

## 0.6.0

### Added

- **An account per client:** **Sign In As…** pins a Microsoft account to a client. The Web API always signs in to that client's org with it, tokens are cached per account, and a pac profile signed in as someone else is offered for recreation. The account shows in the client's tooltip and under Environment, and XrmDefinitelyTyped uses it as the sign-in hint.

### Changed

- New icon.

## 0.5.1

### Added

- **Query submenu** on tables and columns with common debugging queries: find duplicates (on one column, or any combination you pick), rows missing required values, rows where a column is empty, values with leading or trailing spaces, recently created and changed rows, inactive rows, and counts by status reason and owner.
- **HAVING** in SQL queries, applied to the grouped rows after the fetch since FetchXML has no equivalent.

## 0.5.0

### Added

- **Publish All Customizations** for a client.
- **UPDATE and DELETE** in queries, with a preview of the matching rows and a confirmation before anything changes.
- **Run as…** runs a query as another user through impersonation.
- **Copy as code:** `Xrm.WebApi` JavaScript, Web API URL, C# `FetchExpression`, or C# `QueryExpression`, from a query or the results toolbar.
- **Inspect a Record**, **Open Record from Clipboard**, and **Audit History** (per record or per column).
- **Plug-in steps** section: steps by assembly, turn them on or off, open the plug-in class.
- **System jobs** section: failed (or all) async operations with their messages.
- **Environment variables** section: view and edit values.
- **Environment** section: signed-in user, roles, business unit, version, IDs, and links.
- **"Runs on" CodeLens** above form handler functions, with a warning for handlers the file doesn't define.

### Changed

- **One tree per client.** The separate Metadata and Plug-in Traces views are gone. Each client in the Clients view holds its local folder (solutions, plug-in projects) and its org: Tables, Plug-in steps, Plug-in traces, System jobs, Environment variables, and Environment. Org sections load when expanded and stay loaded until refreshed.

## 0.4.1

### Added

- Click a form event handler in the Metadata view (or right-click, **Go to Function**) to open its function in the client folder's copy of the library, selected at its definition. Without a local copy, Lantern offers a read-only copy from Dataverse. A handler whose function can't be found gets a warning.

## 0.4.0

### Added

- Saving results as CSV or JSON offers **Open File** and **Show in Folder**.
- Right-click a results cell to copy its value, row, or column, or to open the record.
- Metadata view right-click menus: Select Top 1000 Rows, New Query with All Columns, Count Rows, open in browser, new record, and add to early-bound classes on tables; Select Rows with a Value and Show Value Counts on columns; insert `setValue` on choice values and `formContext.ui` references on tabs and sections; and a Copy submenu.

### Changed

- Query results moved to a **Query Results** tab in the bottom panel, with a compact icon toolbar. Each statement shows on one expandable line instead of being cut off.

## 0.3.0

### Added

- **Queries:** write read-only SQL (joins, filters, grouping, aggregates, sorting) or FetchXML against a client's org and run it with F5. Results show display and stored values, sort by column, open records, and save as CSV or JSON. Table and column names autocomplete. **Show FetchXML** shows the translation.
- **Plug-in Traces view:** the newest trace log entries per client, with failures marked, filters for errors, time, and plug-in name, and an offer to turn trace logging on when it's off.
- **Find Where Column Is Used:** forms, views, business rules, workflows, actions, plug-in steps, and code in the client folder.
- **Edit User Settings:** change time zone, records per page, languages, or week numbers for one or many users.

## 0.2.0

### Added

- **Metadata view:** browse tables, columns (types, required level, lookup targets, choice values), and forms down to tabs, sections, controls, composite-field parts, and registered event handlers. Copy names, insert `getAttribute`/`getControl` calls, or open a one-page table reference. Metadata is cached per org for instant, offline use.
- **Column-aware IntelliSense:** completions and hovers for names inside `getAttribute`, `getControl`, `tabs.get`, and `sections.get`. Columns not on any form are flagged, since `getAttribute` returns `null` for them at runtime.
- **Set Table for This File** for scripts whose table can't be worked out from the file name.

## 0.1.1

### Fixed

- Web resources named without a file extension (like `new_AccountFormOnLoad`, common for ones created in the maker portal) work: the type is read from the solution's `.data.xml`, so push, compare, CodeLens, the editor title button, and the Explorer menu all recognize them.
- Those files open with the right language mode (JavaScript, HTML, CSS, or XML) instead of plain text.

## 0.1.0

Initial release: client folders with optional Azure DevOps repos, pull from Dataverse with a review panel, web resource push and compare, plug-in build and push, JavaScript form types (XrmDefinitelyTyped), C# early-bound classes (`pac modelbuilder`), form script templates, snippets, CodeLens, and a status bar for the active client.
