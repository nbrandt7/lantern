// Writes a minimal but valid .NET assembly (PE file with ECMA-335 metadata) for tests:
// an Assembly row, assembly references, type references and type definitions with
// base classes, interfaces and nesting. No method bodies; nothing here needs to run.
//
// spec = {
//   name, version: "1.0.0.0", publicKey?: Buffer, signed?: boolean,
//   types: [{ ns, name, public?: true, abstract?, interface?, nestedIn?: "Name",
//             base?: "object" | "CodeActivity" | "Entity" | <local type name>,
//             interfaces?: ["IPlugin" | <local interface name>] }]
// }
const EXTERNAL = {
  object: { scope: "mscorlib", ns: "System", name: "Object" },
  IPlugin: { scope: "Microsoft.Xrm.Sdk", ns: "Microsoft.Xrm.Sdk", name: "IPlugin" },
  CodeActivity: { scope: "System.Activities", ns: "System.Activities", name: "CodeActivity" },
  Entity: { scope: "Microsoft.Xrm.Sdk", ns: "Microsoft.Xrm.Sdk", name: "Entity" },
};
const REFS = {
  mscorlib: { version: [4, 0, 0, 0], token: "b77a5c561934e089" },
  "Microsoft.Xrm.Sdk": { version: [9, 0, 0, 0], token: "31bf3856ad364e35" },
  "System.Activities": { version: [4, 0, 0, 0], token: "31bf3856ad364e35" },
};

function writeAssembly(spec) {
  const strings = [Buffer.from([0])];
  const stringIndex = new Map();
  const str = (s) => {
    if (!s) return 0;
    if (stringIndex.has(s)) return stringIndex.get(s);
    const at = strings.reduce((n, b) => n + b.length, 0);
    strings.push(Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]));
    stringIndex.set(s, at);
    return at;
  };
  const blobs = [Buffer.from([0])];
  const blob = (b) => {
    if (!b || !b.length) return 0;
    const at = blobs.reduce((n, x) => n + x.length, 0);
    const len = b.length < 0x80 ? Buffer.from([b.length]) : Buffer.from([0x80 | (b.length >> 8), b.length & 0xff]);
    blobs.push(len, b);
    return at;
  };

  // Assembly references and type references actually used
  const types = spec.types;
  const usedExternal = new Set(["object"]);
  for (const t of types) {
    if (t.base && EXTERNAL[t.base]) usedExternal.add(t.base);
    for (const i of t.interfaces || []) if (EXTERNAL[i]) usedExternal.add(i);
  }
  const scopes = [...new Set([...usedExternal].map((e) => EXTERNAL[e].scope))];
  const assemblyRefRow = (scope) => scopes.indexOf(scope) + 1;
  const externals = [...usedExternal];
  const typeRefRow = (e) => externals.indexOf(e) + 1;

  // TypeDefs: row 1 is <Module>; enclosing types must come before nested ones
  const typeDefRow = (name) => {
    const i = types.findIndex((t) => t.name === name);
    if (i < 0) throw new Error(`unknown local type ${name}`);
    return i + 2;
  };
  const typeDefOrRef = (target) => (EXTERNAL[target] ? (typeRefRow(target) << 2) | 1 : typeDefRow(target) << 2);

  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

  const tables = {};
  tables[0x00] = [Buffer.concat([u16(0), u16(str(`${spec.name}.dll`)), u16(1), u16(0), u16(0)])];
  tables[0x01] = externals.map((e) => Buffer.concat([u16((assemblyRefRow(EXTERNAL[e].scope) << 2) | 2), u16(str(EXTERNAL[e].name)), u16(str(EXTERNAL[e].ns))]));
  tables[0x02] = [Buffer.concat([u32(0), u16(str("<Module>")), u16(0), u16(0), u16(1), u16(1)])];
  for (const t of types) {
    let flags = 0;
    if (t.public !== false) flags |= t.nestedIn ? 0x2 : 0x1;
    if (t.abstract || t.interface) flags |= 0x80;
    if (t.interface) flags |= 0x20;
    const extendsIndex = t.interface ? 0 : typeDefOrRef(t.base || "object");
    tables[0x02].push(Buffer.concat([u32(flags), u16(str(t.name)), u16(t.nestedIn ? 0 : str(t.ns)), u16(extendsIndex), u16(1), u16(1)]));
  }
  const impls = [];
  types.forEach((t, i) => (t.interfaces || []).forEach((iface) => impls.push([i + 2, typeDefOrRef(iface)])));
  impls.sort((a, b) => a[0] - b[0]);
  tables[0x09] = impls.map(([cls, iface]) => Buffer.concat([u16(cls), u16(iface)]));
  const [ma, mi, bu, re] = (spec.version || "1.0.0.0").split(".").map(Number);
  tables[0x20] = [Buffer.concat([u32(0x8004), u16(ma), u16(mi), u16(bu), u16(re), u32(spec.publicKey ? 1 : 0), u16(blob(spec.publicKey)), u16(str(spec.name)), u16(0)])];
  tables[0x23] = scopes.map((s) => {
    const r = REFS[s];
    return Buffer.concat([u16(r.version[0]), u16(r.version[1]), u16(r.version[2]), u16(r.version[3]), u32(0), u16(blob(Buffer.from(r.token, "hex"))), u16(str(s)), u16(0), u16(0)]);
  });
  const nested = types.map((t, i) => (t.nestedIn ? [i + 2, typeDefRow(t.nestedIn)] : null)).filter(Boolean).sort((a, b) => a[0] - b[0]);
  if (nested.length) tables[0x29] = nested.map(([n, e]) => Buffer.concat([u16(n), u16(e)]));

  const present = Object.keys(tables).map(Number).filter((k) => tables[k].length).sort((a, b) => a - b);
  let valid = 0n;
  for (const k of present) valid |= 1n << BigInt(k);
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0, 0);
  header[4] = 2;
  header[5] = 0;
  header[6] = 0; // all heaps use 2-byte indexes
  header[7] = 1;
  header.writeBigUInt64LE(valid, 8);
  header.writeBigUInt64LE(0n, 16);
  const tableStream = pad4(Buffer.concat([header, ...present.map((k) => u32(tables[k].length)), ...present.flatMap((k) => tables[k])]));
  const stringHeap = pad4(Buffer.concat(strings));
  const blobHeap = pad4(Buffer.concat(blobs));
  const guidHeap = Buffer.alloc(16, 0x42);

  const streams = [["#~", tableStream], ["#Strings", stringHeap], ["#GUID", guidHeap], ["#Blob", blobHeap]];
  const version = pad4(Buffer.from("v4.0.30319\0"));
  const streamHeaders = streams.map(([name]) => 8 + pad4(Buffer.from(name + "\0")).length).reduce((a, b) => a + b, 0);
  let offset = 16 + version.length + 4 + streamHeaders;
  const headerParts = [];
  for (const [name, data] of streams) {
    headerParts.push(u32(offset), u32(data.length), pad4(Buffer.from(name + "\0")));
    offset += data.length;
  }
  const root = Buffer.concat([u32(0x424a5342), u16(1), u16(1), u32(0), u32(version.length), version, u16(0), u16(streams.length), ...headerParts, ...streams.map((s) => s[1])]);

  // .text section at RVA 0x2000: CLI header, strong-name signature, metadata
  const RVA = 0x2000;
  const signature = spec.publicKey ? Buffer.alloc(128, spec.signed === false ? 0 : 0xab) : Buffer.alloc(0);
  const cliSize = 72;
  const sigRva = RVA + cliSize;
  const metaRva = sigRva + signature.length;
  const cli = Buffer.alloc(cliSize);
  cli.writeUInt32LE(cliSize, 0);
  cli.writeUInt16LE(2, 4);
  cli.writeUInt16LE(5, 6);
  cli.writeUInt32LE(metaRva, 8);
  cli.writeUInt32LE(root.length, 12);
  cli.writeUInt32LE(1 | (signature.length && spec.signed !== false ? 8 : 0), 16);
  if (signature.length) {
    cli.writeUInt32LE(sigRva, 32);
    cli.writeUInt32LE(signature.length, 36);
  }
  const text = Buffer.concat([cli, signature, root]);
  const raw = Buffer.concat([text, Buffer.alloc((0x200 - (text.length % 0x200)) % 0x200)]);

  const dos = Buffer.alloc(0x80);
  dos.write("MZ", 0, "ascii");
  dos.writeUInt32LE(0x80, 0x3c);
  const coff = Buffer.alloc(24);
  coff.write("PE\0\0", 0, "binary");
  coff.writeUInt16LE(0x14c, 4);
  coff.writeUInt16LE(1, 6);
  coff.writeUInt16LE(0xe0, 20);
  coff.writeUInt16LE(0x2102, 22);
  const opt = Buffer.alloc(0xe0);
  opt.writeUInt16LE(0x10b, 0);
  opt.writeUInt32LE(0x2000, 32); // section alignment
  opt.writeUInt32LE(0x200, 36); // file alignment
  opt.writeUInt32LE(0x2000 + raw.length, 56); // size of image
  opt.writeUInt32LE(0x200, 60); // size of headers
  opt.writeUInt32LE(16, 92);
  opt.writeUInt32LE(RVA, 96 + 14 * 8);
  opt.writeUInt32LE(cliSize, 96 + 14 * 8 + 4);
  const section = Buffer.alloc(40);
  section.write(".text", 0, "ascii");
  section.writeUInt32LE(text.length, 8);
  section.writeUInt32LE(RVA, 12);
  section.writeUInt32LE(raw.length, 16);
  section.writeUInt32LE(0x200, 20);
  section.writeUInt32LE(0x60000020, 36);
  const headers = Buffer.concat([dos, coff, opt, section]);
  return Buffer.concat([headers, Buffer.alloc(0x200 - headers.length), raw]);
}

function pad4(b) {
  return b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b;
}

module.exports = { writeAssembly };
