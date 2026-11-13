# Changelog

All notable changes to Lantern for Dataverse are listed here, newest first.

## 0.9.7

### Changed

- Opening a window or selecting a tenant no longer pops a Microsoft sign-in. Lantern checks the connection quietly, and when it can't sign in that way it offers **Sign In As…** instead.

- `lantern.mcp.enabled` and `lantern.mcp.port` are machine settings, so a repository's workspace settings can't turn on Lantern's MCP server or move it to another port.

- AI tools give answers that fit an assistant's limits. `lantern_where_used` and `lantern_trace_column` list at most 40 lines of code, files that also name the table first, and count the rest; a common column name like `name` or `statuscode` used to return hundreds of lines from other tables. Their links are full paths, so an assistant working in another folder can open them. **Find Where Column Is Used** in VS Code still lists every line. `lantern_explain_plugin` lists the tenant's own assemblies with their classes and the hundred or so managed Microsoft assemblies on one line, and `lantern_query` says "0 row(s)" for FetchXML that matches nothing instead of an empty table.

- Build and Push of a plug-in package project deletes the last build's `.nupkg` and `.nuspec` before building, checks that the package holds the DLL the build made, asks before pushing a build the environment already has, and writes the file it pushes, when it was written and the assembly version inside to the Output panel (see Fixed).

- For contributors: `npm test` also runs the regression suites (`test/regression/`), the panel checks and, when Playwright is installed, the panel pages in a browser.

### Fixed

- **Build and Push could deploy an old plug-in package and report success.** The plug-in package targets add the DLL to the package from the publish folder, which NuGet doesn't count as an input, so an incremental build recompiled the DLL but kept the last `.nupkg` as up to date, and Lantern pushed it. The package is now made again on every build, a package that doesn't hold the DLL the build made isn't pushed (with a message saying which file and versions), and a project's package is only its own `<PackageId>.<version>.nupkg`, not that of a project whose ID starts the same or a `.symbols.nupkg`.

- **Switching environments while the Solutions or Environment view was loading** kept the view on the old environment's rows until that load finished, which with a big table list or an unanswered sign-in could be a long time. Loads for the environment you left now give way at once, and a request still running from before the switch keeps signing in to its own org instead of getting the new environment's token.

- **Command bar.** Publishing the classic command bar removed buttons the solution had that the page never showed (for example ones added with the Ribbon Workbench), and could send a solution file Dataverse rejects because the zip had no checksums. Saving with no edits now keeps every Id, label, template and tab display rule; edits inside your own groups are written; the local RibbonDiffXml's commands and rules win over older published ones; a flyout in a split button's menu keeps its own sections; and with two local solutions, only the chosen one's file is written and published. A publish that would drop what the solution holds is refused before the import. Saving modern commands again after a save stopped part-way no longer creates or deletes twice, and typing a new rule's or button's Id through an existing one's no longer rewires or relabels it.

- **Plug-ins.** **Unregister Plug-in Package…** checks everything first: a plug-in type something else depends on, or a managed step, stops it before any step is deleted, and the steps are saved to `.pull-backup` before they go. Register Plug-in Step takes the images of SetState messages from `EntityMoniker`, keeps filtering columns when the message is typed in lower case, and pre-selects the class by its ID rather than an older version's class of the same name; the tree no longer shows an old version's steps under the newer version's class. Edit Step treats an empty secure configuration as a problem rather than an empty value. Debug Plug-in Step keeps the comments in `launch.json`, still works when the DLL isn't under `bin/Debug`, and doesn't offer a `.nupkg` to replay. Two Compare Deployed Plug-in with Local runs no longer delete each other's files.

- **PCF and pac.** PCF push names the environment, so a pac profile shared by two environments can't deploy to the wrong one. Tenants with long names get a pac profile per environment, and cancelling the account choice stops instead of opening a sign-in.

- **Tenants and environments.** After switching DEV → PROD → Select Tenant again, table metadata could come from (and be cached under) the wrong environment. Two tenants with the same name are offered once, and saving or removing one leaves the other alone. A tenant renamed or removed in another window isn't written back. Switch Environment followed by Sign In As no longer makes the switched-to environment the saved default. A `tenants.json` that doesn't parse no longer stops Lantern from starting, and the message names the file. Two old folders on the same org both import, each with its own folder. An app registration's secret is kept when Add Environment names the single org or the environment is renamed. The Environment view follows Sign In As, Refresh reloads every section that was loaded, and editing a tenant's `folder` moves it there on the environment it was on. **Configure as Tenant** is back on the Explorer's folder right-click menu, and it and **New Tenant Folder** keep `jsconfig.json` out of the client repo's changes.

- **Queries.** `HAVING` binds to the aggregate with the same function, column, `DISTINCT` and table, so `HAVING COUNT(DISTINCT x)` next to `COUNT(x)`, or on a column name both sides of a `JOIN` have, filters on the right one. FetchXML that starts with an XML declaration or comments runs as FetchXML, and a long run of comments no longer freezes the extension host. Duplicate aggregate aliases, and line breaks and tabs in string values, stay valid in the FetchXML; an aggregate result with more rows than one page says more exist; JSON export keeps columns that share a header; and write statements are recognized after a document's comment header.

- **Writing data and CSV.** A blank number is no value instead of 0, and a decimal comma (`1234,56`) is refused instead of read as 123456; thousands separators still work. Owner lookups take `systemuser:` or `team:` IDs. In CSV, a quote inside an unquoted field is a character; on import, cells holding only spaces are empty, braces around IDs are allowed, and an ID that isn't a GUID fails its row instead of the whole batch.

- **Copy as code and generated code.** C# interpolated strings keep their holes and double literal braces, Xrm.WebApi code keeps backslashes, Web API URLs from multi-line FetchXML keep attributes apart, and `QueryExpression` code escapes line breaks. C# classes keep an enum the code already had and a CrmSvcUtil-style `OptionSetValue` property, put `@` on field names that are C# keywords, turn accented labels into whole words, don't overwrite a file of yours with the class's name, and keep a queue per project, including what was queued while generating. Script models don't overwrite a form script with the model's file name. Adding a form handler to a self-closing event keeps the events after it, New Form Script and New PCF Control accept only names that work, New Plug-in Class adds the file to an old-style project, and TypeScript push finds the file `tsc` wrote when there's no `rootDir`.

- **Form scripts and analysis.** `setTimeout(function () { … })`, `if`, `for` and `while` aren't taken for function definitions, a call at the start of a line is reported on that line, a tab named `tab` is underlined in the right place, and a `@""""` verbatim string isn't read as a raw string. Deactivated-row filters work for tables with more than two states. Comparing environments keeps pre- and post-operation steps with the same default name apart, and two forms with one name and type; a dependency lookup that fails says it couldn't check instead of showing nothing.

- **Web resources.** A `webResourceRoots` folder named like build output (`dist`) is still searched for web resources.

- **AI tools.** Set Up for Claude Code no longer replaces `~/.claude.json` with only Lantern's entry when the file starts with a byte order mark, leaves a file it can't read alone with a way forward, and keeps config files' permissions; removing Lantern from Codex keeps the tables after it. The MCP server answers invalid requests with an error instead of nothing. The tools accept only logical names for tables and columns. Flow search finds text in conditions, loop sources and trigger conditions, and `teams` and `email` skip triggers and read-only steps. Security role privileges for activities, notes, users and Topic reach their tables, and an environment's name is checked for production before anything else.

- **Sign-in and the Web API.** Dataverse's `Retry-After` is read as seconds or a date, and a wait longer than Lantern allows fails at once with how long Dataverse asked for, instead of retrying early. A metadata load that fails isn't retried once for every caller waiting on it, and Refresh during a slow load fetches again.

- **Reliability.** A truncated or damaged DLL is refused as not an assembly instead of hanging. Settings files saved with a byte order mark are read, and Lantern's JSON files are replaced whole instead of rewritten in place. Cancelling a command-line tool on Windows ends the tool, not just the shell around it; nothing starts once cancelled; output split mid-character decodes whole; Windows arguments keep trailing backslashes, quotes and `%VAR%`; and a missing tool or folder is reported as missing. Pages (the property sheets) ignore a second Save while one is saving, and keep the page open with the message when saving fails.

## 0.9.6

### Changed

- The property sheets are pages now. Registering or editing a plug-in registration, registering or editing a plug-in step, adding an environment, and picking the columns for C# classes and script models open as editor tabs instead of a run of input boxes and quick picks: a title and summary at the top, a list on the left where there's one (the assembly's classes, the step's images, the environments your account can open), labelled fields on the right with hints and inline problems, and a footer whose Register, Save, Add or Queue button stays off until the form is valid (and, when editing, until something changed). Escape or Cancel closes a page without changes. The pages use VS Code's theme colours, so they fit dark and light themes. Register Plug-in Step gained the fields Edit Step had: execution order, run-as user, unsecure configuration, a name you can type over, and images of any type. Genuinely one-field choices (a solution, a table, a step) stay quick picks.

- C# early-bound classes are now **C# classes**, generated by Lantern from the org's metadata instead of `pac modelbuilder`. Add tables to a queue with the columns to include (Add to C# Classes…); a status bar item shows the queue until you generate, and you can change or remove queued tables. The namespace is optional, files have no `#pragma warning disable` (every member has an XML comment), and regenerating keeps what's already in your classes. The `earlyBound` setting is now `csharpClasses`; the old name is still read.

- The sidebar shows the tenant once. A new **Tenant** view at the top shows the selected tenant, environment and account (click one to switch), and each row's right-click has its actions: the tenant's configuration and code setup, the environment's switching, comparing, connection test, user settings, publishing and import, and Sign In As. **Solutions** and **Environment** start straight at their contents and stay hidden until a tenant is selected; with none selected, the Tenant view shows one Select Tenant / Add Tenant welcome. Tenant-wide actions moved from the tenant row to the Tenant view and the Solutions and Environment title bars.

- Adding an environment picks instead of typing: names come from a list with one suggested from the org's own name (`contosodev` suggests DEV), and the org is picked from the environments your account can open (Global Discovery Service, all clouds). Entering a URL still works, and is used when the list can't be read.

- Column rows no longer have the getAttribute icon; it's in the right-click menu's **JavaScript ›**.

- SQL `DELETE`, `UPDATE` and `INSERT` are much faster. The rows used to go to Dataverse one HTTP request at a time, one after the other, so a thousand rows took minutes; they now go in Web API `$batch` requests, several in flight at once, with `odata.continue-on-error` so one refused row doesn't stop the rest. Dataverse runs a batch's requests one after another, so the parallel batches are what make slow per-row work like deleting files go faster, but past some point more of them only make every row slower, so the number in flight is tuned while the statement runs for the most rows per second: four to start, doubling every ten seconds while a row takes no longer than it did with fewer, then a quarter at a time, up while the rate still rises and back when it falls, within the environment's `x-ms-dop-hint` recommendation. Each batch is sized to take about five seconds (20 rows to start, then 5 to 100 from how long a row takes), so quick updates go in big batches with few round trips and slow ones in small batches that keep the progress moving. The Output panel logs each tuning step: rows per second, time per row, batches in flight and their size. When Dataverse throttles (429), no new batch starts until its Retry-After ends, the batches in flight drop to half, and they grow back one per batch. The progress notification counts the rows done, Cancel stops after the batches already in flight (the rest show as skipped), each row's Result is still listed, the protected-environment confirmation is still asked once per statement, and the Output panel logs how long finding the rows and applying the change took. **Import CSV…** sends its rows the same way.

- App searches now require a trailing `e` to edit or `r` to run. The selected action determines the app URL, with distinct handling for model-driven, canvas, and code apps.

- Columns and forms under a solution's table show only components included in that solution, including tables configured to include all objects. All tables remains environment-wide.

- The Lantern sidebar has separate Solutions and Environment panes. Org-wide items and their existing actions now appear under Environment.

- Solutions in the tenant tree come only from the configured solution names. Solution pull, its review panel, automatic local folder matching, and Pack and Import from Your Files have been removed.

- Internal storage mode ignores local configuration files and requires explicit client initialization. Switching storage modes does not migrate or delete settings; folder mode uses `.lantern/config.json` independently.

- Local client settings use only `.lantern/config.json`. Root-level `client.json`, `config.json`, and legacy `xdt.json` are no longer discovered or migrated as client settings.

### Fixed

- `UPDATE … SET <file column> = NULL` deletes the file, with the `DELETE` on the column that Dataverse requires for File columns, instead of sending `null` in the update, which Dataverse rejects. Setting a file column to anything else is refused with a note that files are uploaded from the app or the Web API.

- **Cancel** on a query's progress notification now stops it between pages, and the notification counts the rows so far. A query without `TOP` keeps paging until `lantern.query.maxRows`, and Dataverse returns at most 250 rows per page when the query selects a File column (whose value comes back empty anyway), so such a query over a big table took twenty slow pages and couldn't be stopped.

- An `UPDATE`, `DELETE` or `INSERT` with a syntax error now reports that error. Before, the statement fell through to the query translator, which said "UPDATE changes data, so it has no FetchXML". **Show FetchXML** on a document with write statements comments them out instead of failing.

- Registering a plug-in package no longer fails with "Export key attribute uniquename for component pluginpackage must start with a valid customization prefix". The unique name gets the chosen solution's publisher prefix (the Default solution's when none is chosen) and can be changed before registering; a package registered with a prefix is found again by its package ID, and Get Source reads the package ID from the package itself.

- A table, column or form created since Lantern last read the org's metadata shows up: the **+** on a solution's Tables, Columns and Forms reads the current metadata, and the refresh buttons (the Solutions and Environment titles, a solution) reload the table list and the solutions' components. Columns and forms of other tables keep their cache; the metadata view's refresh clears those.

- Build and Push no longer pushes a plug-in package just because the project built a `.nupkg`: a project that builds both a `.dll` and a `.nupkg` is pushed the way the org has it registered (assembly or package), and when neither is registered yet Lantern asks once and remembers the answer per tenant (`pluginDeploy`). Compare Deployed Plug-in with Local and Debug Plug-in Step use the `.dll`.

- F5 runs the query in any SQL document, and in a FetchXML document as soon as it holds FetchXML: the Run context used to be set only when you switched editors, so F5 fell through to Start Debugging.

- Add Environment saves what it adds. When anything refreshed the tenant while the Add Environment page was open, the new environment (and the name given to the org in use) went into a stale copy of the configuration and were never written, although "Added …" was shown; Switch Environment then offered nothing.

### Added

- **Open Command Bar…** (right-click a table, or the command palette): a command bar editor, the Ribbon Workbench's job inside VS Code. The table's ribbon is read with `RetrieveEntityRibbon` for the form, main grid and subgrid, with the modern commands (`appaction` rows) of every app: locations → tabs → groups → controls on the left (split-button menus and flyouts included), the selected control on the right with a preview of its bar (icons from your image web resources), its labels, icon, command, actions (JavaScript function with library and parameters, URL, dialog) and enable and display rules, every rule explained in words. The RibbonDiffXml for the table in your local solution folders is laid over it, so your own buttons, groups, commands and rules are tagged, buttons not yet in the environment show as local only, and the controls your solution hides are listed. What's yours can be edited: button labels and tooltips (as LocLabels, other languages kept), sequence, command and icons; new buttons on any group; hiding and unhiding Microsoft's buttons; commands with their actions, parameters and rules; rules with steps of any kind, explained as you type; modern commands (label, location, type, sequence, hidden, JavaScript function and library, icon, new ones for an app). Every JavaScript function is checked against the workspace like the form-script warnings (library a web resource in the client folder, function defined in it) as warnings next to the action; what Dataverse would reject keeps Save off. Save writes the RibbonDiffXml to the solution folder, the modern commands to the environment (and publishes their apps), and can publish the classic bar through the solution you pick (export, patch, import, publish the table). Not covered: Power Fx formulas, the application ribbon, changing Microsoft's buttons beyond hiding them.

- **Subqueries in SQL.** `WHERE [NOT] EXISTS (SELECT 1 FROM contact WHERE contact.parentcustomerid = account.accountid AND ...)` and `accountid [NOT] IN (SELECT parentcustomerid FROM contact WHERE ...)` translate to FetchXML's `link-entity` of type `any` / `not any` inside the filter, so they combine with `AND`, `OR` and `NOT` like any other condition, nest inside one another, and each outer row comes back once. The condition linking the subquery to the query around it becomes the link's `from` / `to`, the rest of its `WHERE` becomes the link's filter, and its `INNER JOIN`s nest inside the link with their conditions in their own filter. A subquery linked to an `INNER JOIN`ed table of the outer query is written inside that join when the subquery is combined with the rest of the `WHERE` by `AND`. What FetchXML can't express gets an error that says what to change: no linking condition, a link that isn't a plain `=`, a link to a `LEFT JOIN`ed table or to a query further out, a `LEFT JOIN`, `GROUP BY`, `ORDER BY`, `TOP` or aggregate inside the subquery, a condition on a subquery's joined table under `OR`, a subquery in `SELECT` or `FROM`, or `= (SELECT ...)`. Copy as code writes them as C# `QueryExpression` filters with `AnyAllFilterLinkEntity` (`JoinOperator.Any` / `NotAny`), and `EXISTS` is in the SQL completions.

- SQL Server's `UPDATE i SET i.col = NULL FROM incident i WHERE ...` and `DELETE i FROM incident i WHERE ...` forms are accepted, with one table in `FROM`; a `JOIN` there says to use `WHERE EXISTS (SELECT ...)` instead.

- `OPTION (BYPASS PLUGINS)`, `OPTION (BYPASS SYNC PLUGINS)`, `OPTION (BYPASS ASYNC PLUGINS)` and `OPTION (BYPASS FLOWS)` at the end of an `UPDATE`, `DELETE` or `INSERT` send Dataverse's `MSCRM.BypassBusinessLogicExecution` and `MSCRM.SuppressCallbackRegistrationExpanderJob` headers with every row, for bulk changes where a table's custom plug-ins, workflows or flow triggers are what make each row slow. The confirmation says what's bypassed; bypassing plug-ins needs the privilege system administrators have, and Microsoft-published logic still runs.

- **Plug-in registration details.** Registering a new assembly first shows what the Plugin Registration Tool would let you set: its description and isolation mode, and each class's name, display name, description and workflow activity group. A new plug-in package asks for its name and unique name.

- **Edit Plug-in Registration…** (the pencil on a registered assembly or class, the right-click menu, or a click on a project's "version in environment" row): an assembly's description and isolation mode, its package's name, and each class's name, display name, description and workflow activity group, saved together. Display names show beside classes in the tree.

- **Edit Step…** (the pencil on a step, or right-click): name, description, stage, sync or async, execution order, filtering columns, run-as user, deleting the system job on success, unsecure configuration, write-only secure configuration, and images (add, change alias, type and columns, remove). Dataverse's rules are checked before saving (async only post-operation, post-images only post-operation, no pre-image on Create, no post-image on Delete). **Unregister Step…** deletes a step with its images and secure configuration after asking.

- **Debug Plug-in Step…** (the debug icon on a step, or right-click): record a run and replay it locally with breakpoints, the only way to debug a plug-in in Dataverse. It turns the step's profiler on (a flag on the step; no profiler solution), sets plug-in trace logging to All if needed (asking first), builds the project in Debug, adds a `clr` attach configuration for `PluginRegistration` to `.vscode/launch.json`, waits for the step to run, saves the profile under `.lantern/profiles/` and opens the Plugin Registration Tool for Replay Plug-in Execution. Steps being profiled show "profiling"; **Stop Profiling** turns it off and offers the trace setting back.

- **Unregister Plug-in Package…** (right-click Plug-ins, a registered assembly, or a project's registration row): shows what the package holds (assemblies, plug-in types, steps), then unregisters the steps first, as Dataverse requires, and the package, which removes its assemblies and types. A package ID a push had remembered is forgotten.

- **AI Tools** (the ✨ on the Tenant view): a tab with a card for each assistant. **Claude Code** and **Codex**, CLI and VS Code extension alike, connect to Lantern's MCP server, which runs in VS Code on `127.0.0.1` and needs a token; Set Up writes their configuration (Codex starts `~/.lantern/lantern-mcp.js`, which forwards to the server). **Copilot** gets the tools directly. The server only runs when `lantern.mcp.enabled` is on (Set Up turns it on); `lantern.mcp.port` sets its port.

- **AI tools** for Copilot and MCP clients, on top of the existing tenant, table, query and where-used tools: `lantern_search_flows` (by name, or by what they do: `email`, `teams`, `approval`, `http`, `sharepoint`, `childflow`, `dataverse-write`, or any text in the definition), `lantern_explain_flow` (trigger, steps with their connectors and parameters, conditions and loops, connections), `lantern_explain_plugin` (registration, steps, images, and the source when the project is in the folder), `lantern_explain_web_resource` (content, functions, the forms and events that load it), `lantern_trace_column` (everything that can make a field behave a certain way: its definition, forms, form-script lines, business rules, workflows, flows, plug-in steps and code), and `lantern_generate_csharp_classes` (tables and columns from a pasted user story into the C# classes queue, or written when asked; it only adds).

- **C# classes** also have: **Add C# Property** on a column (straight into its table's class), CodeLens on class files (**Edit Columns** to tick and untick a class's columns, **Update from Dataverse** to regenerate with current labels and choices), and **C# ›** inserts on columns and choice values (`GetAttributeValue<T>`, a typed set, `new OptionSetValue(…)`), using a class's `Fields` constants when it has the column. Classes and properties keep their schema names, like `pac`'s, so existing code still compiles.

- **Script models**: JavaScript or TypeScript table models for form scripts (Add to Script Model… on a table, Add Script Model Property on a column, Edit Columns and Update from Dataverse in the CodeLens), as one plain global class per table like the C# classes (`Acme.Models.Account`): the table's names and `fields` as statics, an enum per choice column (`Account.statuscode.Inactive`), an instance from a form (`new Account(formContext)`) or a Web API row (`new Account(row)`, with lookups, dates and multi-selects normalized) whose properties are the values (`account.statuscode`), and `account.fields.<name>` with the column's `.attribute`, `.control` and `.controls` (typed in TypeScript, choice values included; controls inside composite fields like full name and address are found), and `Account.Row`, the raw Web API row type, in TypeScript. Started from a table under a solution, the script model and C# class pickers pre-tick that solution's columns.
- **JavaScript › Insert getControl** uses the control's real name from the forms, so a column that only appears inside a composite field gets `address1_composite_compositionLinkControl_address1_line1` instead of a name that returns `null`.

- **Add to Solution** and **Remove from Solution** on plug-in assemblies and packages, plug-in steps, web resources, cloud flows, tables and columns, replacing the maker portal's Add existing: a table can go in as metadata only, with everything, or with a checklist of its columns; tooltips show which solutions each one is in.

- The **+** on a solution's Tables, Web resources and Power Automate flows, and on Columns and Forms under its tables, adds existing ones from a searchable list. **Open in Maker Portal** on solutions, tables, columns, forms, web resources and flows.

- The right-click menu on tables, columns, choice values and form parts follows one order (open, find, Query, Copy, JavaScript, C#, data, solution, refresh), with each language's inserts and generators in its own submenu.

- Search now supports `t` tables, `br` business rules, and `a` model-driven, canvas, and code apps. Prefix a component search with `s <solution unique name>` to limit results and open the selection in that solution.

- Lantern checks the selected Dataverse connection when it starts or the tenant or environment changes, prompting for sign-in before the first command when needed.

- Search opens an exact solution unique name with `s <name>` or lists fuzzy solution matches for partial names.

- Daily logs in the user's `~/.lantern/log` folder capture Lantern output, errors, search activity, Dataverse request outcomes, and process exit status.

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
