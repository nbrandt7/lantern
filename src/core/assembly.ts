import * as crypto from "crypto";

/**
 * Reads what the Plugin Registration Tool reads from a built plug-in DLL, without
 * loading it: the assembly's name, version, culture and public key token, and
 * which public classes are plug-ins (implement IPlugin) or custom workflow
 * activities (derive from System.Activities.Activity). Everything comes from the
 * ECMA-335 metadata tables in the PE file.
 */

export interface AssemblyReference {
  name: string;
  version: string;
  publicKeyToken?: string;
}

export interface PluginClass {
  /** Reflection-style full name (Namespace.Outer+Inner), what Dataverse stores as typename. */
  typeName: string;
  kind: "plugin" | "workflow";
}

export interface AssemblyMetadata {
  name: string;
  version: string;
  /** "neutral" when the assembly has no culture, as Dataverse stores it. */
  culture: string;
  /** Lowercase hex, or undefined when the assembly isn't strong-named. */
  publicKeyToken?: string;
  /** True when the strong-name signature is present and not all zeros (delay-signed assemblies aren't). */
  signed: boolean;
  references: AssemblyReference[];
  /** Public, non-abstract classes that Dataverse can register, in metadata order. */
  pluginClasses: PluginClass[];
  /** Public non-abstract classes whose base class lives in another assembly we can't inspect. */
  unresolvedBases: Array<{ typeName: string; base: string }>;
}

export class NotAnAssemblyError extends Error {}

/** Lowercase hex public key token: the last 8 bytes of SHA-1(public key), reversed. */
export function publicKeyTokenOf(publicKey: Buffer): string {
  const hash = crypto.createHash("sha1").update(publicKey).digest();
  return Buffer.from(hash.subarray(hash.length - 8)).reverse().toString("hex");
}

export function readAssembly(buf: Buffer): AssemblyMetadata {
  const md = new Metadata(buf);
  const asm = md.assemblyRow();
  const publicKey = md.blob(asm.publicKey);
  const references = md.rows(T.AssemblyRef).map((r) => {
    const keyOrToken = md.blob(r[5]);
    const flags = r[4];
    return {
      name: md.string(r[6]),
      version: `${r[0]}.${r[1]}.${r[2]}.${r[3]}`,
      publicKeyToken: keyOrToken.length ? (flags & 1 ? publicKeyTokenOf(keyOrToken) : keyOrToken.toString("hex")) : undefined,
    };
  });
  const { pluginClasses, unresolvedBases } = md.pluginClasses();
  return {
    name: md.string(asm.name),
    version: asm.version,
    culture: md.string(asm.culture) || "neutral",
    publicKeyToken: publicKey.length ? publicKeyTokenOf(publicKey) : undefined,
    signed: md.hasSignature(),
    references,
    pluginClasses,
    unresolvedBases,
  };
}

/** Same reader, for tests and other callers that want any interface or base class. */
export function typesAssignableTo(buf: Buffer, namespace: string, name: string): string[] {
  const md = new Metadata(buf);
  const out: string[] = [];
  for (let i = 1; i <= md.count(T.TypeDef); i++) {
    if (md.isAssignableTo(i, (ns, n) => ns === namespace && n === name)) out.push(md.typeDefName(i));
  }
  return out;
}

// ---------- ECMA-335 ----------

const enum T {
  Module = 0x00, TypeRef = 0x01, TypeDef = 0x02, Field = 0x04, MethodDef = 0x06, Param = 0x08,
  InterfaceImpl = 0x09, MemberRef = 0x0a, DeclSecurity = 0x0e, StandAloneSig = 0x11, Event = 0x14,
  Property = 0x17, ModuleRef = 0x1a, TypeSpec = 0x1b, Assembly = 0x20, AssemblyRef = 0x23,
  File = 0x26, ExportedType = 0x27, ManifestResource = 0x28, NestedClass = 0x29, GenericParam = 0x2a,
  MethodSpec = 0x2b, GenericParamConstraint = 0x2c,
}

/** Coded index: tag bit count and the tables each tag value points to (-1 for unused tags). */
const CODED: Record<string, [number, number[]]> = {
  TypeDefOrRef: [2, [T.TypeDef, T.TypeRef, T.TypeSpec]],
  HasConstant: [2, [T.Field, T.Param, T.Property]],
  HasCustomAttribute: [5, [T.MethodDef, T.Field, T.TypeRef, T.TypeDef, T.Param, T.InterfaceImpl, T.MemberRef, T.Module, T.DeclSecurity, T.Property, T.Event, T.StandAloneSig, T.ModuleRef, T.TypeSpec, T.Assembly, T.AssemblyRef, T.File, T.ExportedType, T.ManifestResource, T.GenericParam, T.GenericParamConstraint, T.MethodSpec]],
  HasFieldMarshal: [1, [T.Field, T.Param]],
  HasDeclSecurity: [2, [T.TypeDef, T.MethodDef, T.Assembly]],
  MemberRefParent: [3, [T.TypeDef, T.TypeRef, T.ModuleRef, T.MethodDef, T.TypeSpec]],
  HasSemantics: [1, [T.Event, T.Property]],
  MethodDefOrRef: [1, [T.MethodDef, T.MemberRef]],
  MemberForwarded: [1, [T.Field, T.MethodDef]],
  Implementation: [2, [T.File, T.AssemblyRef, T.ExportedType]],
  CustomAttributeType: [3, [-1, -1, T.MethodDef, T.MemberRef, -1]],
  ResolutionScope: [2, [T.Module, T.ModuleRef, T.AssemblyRef, T.TypeRef]],
  TypeOrMethodDef: [1, [T.TypeDef, T.MethodDef]],
};

/**
 * Column layout of every table up to GenericParamConstraint (0x2C). u2/u4 are
 * fixed-size, s/g/b are heap indexes, tNN is an index into table NN, and the
 * rest are coded indexes.
 */
const SCHEMA: string[][] = [
  /* 00 Module */ ["u2", "s", "g", "g", "g"],
  /* 01 TypeRef */ ["ResolutionScope", "s", "s"],
  /* 02 TypeDef */ ["u4", "s", "s", "TypeDefOrRef", "t04", "t06"],
  /* 03 FieldPtr */ ["t04"],
  /* 04 Field */ ["u2", "s", "b"],
  /* 05 MethodPtr */ ["t06"],
  /* 06 MethodDef */ ["u4", "u2", "u2", "s", "b", "t08"],
  /* 07 ParamPtr */ ["t08"],
  /* 08 Param */ ["u2", "u2", "s"],
  /* 09 InterfaceImpl */ ["t02", "TypeDefOrRef"],
  /* 0A MemberRef */ ["MemberRefParent", "s", "b"],
  /* 0B Constant */ ["u2", "HasConstant", "b"],
  /* 0C CustomAttribute */ ["HasCustomAttribute", "CustomAttributeType", "b"],
  /* 0D FieldMarshal */ ["HasFieldMarshal", "b"],
  /* 0E DeclSecurity */ ["u2", "HasDeclSecurity", "b"],
  /* 0F ClassLayout */ ["u2", "u4", "t02"],
  /* 10 FieldLayout */ ["u4", "t04"],
  /* 11 StandAloneSig */ ["b"],
  /* 12 EventMap */ ["t02", "t14"],
  /* 13 EventPtr */ ["t14"],
  /* 14 Event */ ["u2", "s", "TypeDefOrRef"],
  /* 15 PropertyMap */ ["t02", "t17"],
  /* 16 PropertyPtr */ ["t17"],
  /* 17 Property */ ["u2", "s", "b"],
  /* 18 MethodSemantics */ ["u2", "t06", "HasSemantics"],
  /* 19 MethodImpl */ ["t02", "MethodDefOrRef", "MethodDefOrRef"],
  /* 1A ModuleRef */ ["s"],
  /* 1B TypeSpec */ ["b"],
  /* 1C ImplMap */ ["u2", "MemberForwarded", "s", "t1a"],
  /* 1D FieldRVA */ ["u4", "t04"],
  /* 1E EncLog */ ["u4", "u4"],
  /* 1F EncMap */ ["u4"],
  /* 20 Assembly */ ["u4", "u2", "u2", "u2", "u2", "u4", "b", "s", "s"],
  /* 21 AssemblyProcessor */ ["u4"],
  /* 22 AssemblyOS */ ["u4", "u4", "u4"],
  /* 23 AssemblyRef */ ["u2", "u2", "u2", "u2", "u4", "b", "s", "s", "b"],
  /* 24 AssemblyRefProcessor */ ["u4", "t23"],
  /* 25 AssemblyRefOS */ ["u4", "u4", "u4", "t23"],
  /* 26 File */ ["u4", "s", "b"],
  /* 27 ExportedType */ ["u4", "u4", "s", "s", "Implementation"],
  /* 28 ManifestResource */ ["u4", "u4", "s", "Implementation"],
  /* 29 NestedClass */ ["t02", "t02"],
  /* 2A GenericParam */ ["u2", "u2", "TypeOrMethodDef", "s"],
  /* 2B MethodSpec */ ["MethodDefOrRef", "b"],
  /* 2C GenericParamConstraint */ ["t2a", "TypeDefOrRef"],
];

const WORKFLOW_BASES = /^(Activity|CodeActivity|NativeActivity|AsyncCodeActivity)(`1)?$/;

class Metadata {
  private readonly sections: Array<{ va: number; size: number; raw: number }> = [];
  private readonly heaps: Record<string, { offset: number; size: number }> = {};
  private readonly rowCount: number[] = new Array(64).fill(0);
  private readonly tableOffset: number[] = new Array(64).fill(0);
  private readonly columnSizes: number[][] = [];
  private readonly rowSize: number[] = [];
  private readonly cli: number;
  private readonly cache = new Map<number, number[][]>();
  private nestedParent?: Map<number, number>;

  constructor(private readonly buf: Buffer) {
    const fail = (why: string): never => {
      throw new NotAnAssemblyError(`Not a .NET assembly: ${why}.`);
    };
    if (buf.length < 0x80 || buf.readUInt16LE(0) !== 0x5a4d) fail("no MZ header");
    const pe = buf.readUInt32LE(0x3c);
    if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) fail("no PE header");
    const sectionCount = buf.readUInt16LE(pe + 6);
    const optionalSize = buf.readUInt16LE(pe + 20);
    const optional = pe + 24;
    const pe32Plus = buf.readUInt16LE(optional) === 0x20b;
    const directoryCount = buf.readUInt32LE(optional + (pe32Plus ? 108 : 92));
    if (directoryCount < 15) fail("no CLI header");
    const directories = optional + (pe32Plus ? 112 : 96);
    const cliRva = buf.readUInt32LE(directories + 14 * 8);
    if (!cliRva) fail("no CLI header (a native DLL?)");
    const sectionTable = optional + optionalSize;
    for (let i = 0; i < sectionCount; i++) {
      const s = sectionTable + i * 40;
      this.sections.push({ va: buf.readUInt32LE(s + 12), size: Math.max(buf.readUInt32LE(s + 8), buf.readUInt32LE(s + 16)), raw: buf.readUInt32LE(s + 20) });
    }
    this.cli = this.offsetOf(cliRva);
    const metadata = this.offsetOf(buf.readUInt32LE(this.cli + 8));
    if (buf.readUInt32LE(metadata) !== 0x424a5342) fail("bad metadata signature");
    let p = metadata + 16 + buf.readUInt32LE(metadata + 12);
    const streamCount = buf.readUInt16LE(p + 2);
    p += 4;
    for (let i = 0; i < streamCount; i++) {
      const offset = buf.readUInt32LE(p);
      const size = buf.readUInt32LE(p + 4);
      let end = p + 8;
      while (buf[end] !== 0) end++;
      const name = buf.toString("ascii", p + 8, end);
      this.heaps[name] = { offset: metadata + offset, size };
      p += 8 + Math.ceil((end - (p + 8) + 1) / 4) * 4;
    }
    const tables = this.heaps["#~"] ?? this.heaps["#-"];
    if (!tables) fail("no metadata tables");
    const heapSizes = buf[tables.offset + 6];
    const valid = buf.readBigUInt64LE(tables.offset + 8);
    p = tables.offset + 24;
    for (let i = 0; i < 64; i++) {
      if ((valid >> BigInt(i)) & 1n) {
        this.rowCount[i] = buf.readUInt32LE(p);
        p += 4;
      }
    }
    if (heapSizes & 0x40) p += 4; // extra data in uncompressed (#-) streams
    // Tables past 0x2C (portable PDB tables, for example) are laid out after the ones read here, so they can be ignored.

    const simple = (table: number) => (this.rowCount[table] < 0x10000 ? 2 : 4);
    const coded = (kind: string) => {
      const [bits, targets] = CODED[kind];
      const max = Math.max(0, ...targets.filter((t) => t >= 0).map((t) => this.rowCount[t]));
      return max < 1 << (16 - bits) ? 2 : 4;
    };
    const size = (column: string): number => {
      if (column === "u2") return 2;
      if (column === "u4") return 4;
      if (column === "s") return heapSizes & 0x01 ? 4 : 2;
      if (column === "g") return heapSizes & 0x02 ? 4 : 2;
      if (column === "b") return heapSizes & 0x04 ? 4 : 2;
      if (column.startsWith("t")) return simple(parseInt(column.slice(1), 16));
      return coded(column);
    };
    for (let i = 0; i < SCHEMA.length; i++) {
      this.columnSizes[i] = SCHEMA[i].map(size);
      this.rowSize[i] = this.columnSizes[i].reduce((a, b) => a + b, 0);
      this.tableOffset[i] = p;
      p += this.rowSize[i] * this.rowCount[i];
    }
  }

  private offsetOf(rva: number): number {
    const s = this.sections.find((x) => rva >= x.va && rva < x.va + x.size);
    if (!s) throw new NotAnAssemblyError(`Not a .NET assembly: RVA 0x${rva.toString(16)} is outside every section.`);
    return s.raw + (rva - s.va);
  }

  count(table: number): number {
    return this.rowCount[table];
  }

  /** Every row of a table, each as its column values. Rows are 1-based in metadata; index 0 here is row 1. */
  rows(table: number): number[][] {
    const cached = this.cache.get(table);
    if (cached) return cached;
    const out: number[][] = [];
    const sizes = this.columnSizes[table];
    for (let r = 0; r < this.rowCount[table]; r++) {
      let p = this.tableOffset[table] + r * this.rowSize[table];
      const row: number[] = [];
      for (const s of sizes) {
        row.push(s === 2 ? this.buf.readUInt16LE(p) : this.buf.readUInt32LE(p));
        p += s;
      }
      out.push(row);
    }
    this.cache.set(table, out);
    return out;
  }

  row(table: number, index: number): number[] {
    return this.rows(table)[index - 1];
  }

  string(index: number): string {
    const heap = this.heaps["#Strings"];
    if (!heap || !index) return "";
    const start = heap.offset + index;
    let end = start;
    while (this.buf[end] !== 0) end++;
    return this.buf.toString("utf8", start, end);
  }

  blob(index: number): Buffer {
    const heap = this.heaps["#Blob"];
    if (!heap || !index) return Buffer.alloc(0);
    const { value, length } = this.compressed(heap.offset + index);
    const start = heap.offset + index + length;
    return this.buf.subarray(start, start + value);
  }

  private compressed(p: number): { value: number; length: number } {
    const b = this.buf[p];
    if ((b & 0x80) === 0) return { value: b, length: 1 };
    if ((b & 0xc0) === 0x80) return { value: ((b & 0x3f) << 8) | this.buf[p + 1], length: 2 };
    return { value: ((b & 0x1f) << 24) | (this.buf[p + 1] << 16) | (this.buf[p + 2] << 8) | this.buf[p + 3], length: 4 };
  }

  assemblyRow(): { version: string; publicKey: number; name: number; culture: number } {
    const r = this.rows(T.Assembly)[0];
    if (!r) throw new NotAnAssemblyError("Not a .NET assembly: it's a module without an assembly manifest.");
    return { version: `${r[1]}.${r[2]}.${r[3]}.${r[4]}`, publicKey: r[6], name: r[7], culture: r[8] };
  }

  hasSignature(): boolean {
    const rva = this.buf.readUInt32LE(this.cli + 32);
    const size = this.buf.readUInt32LE(this.cli + 36);
    if (!rva || !size) return false;
    const start = this.offsetOf(rva);
    return this.buf.subarray(start, start + size).some((b) => b !== 0);
  }

  private parentOf(typeDef: number): number | undefined {
    if (!this.nestedParent) {
      this.nestedParent = new Map();
      for (const [nested, enclosing] of this.rows(T.NestedClass)) this.nestedParent.set(nested, enclosing);
    }
    return this.nestedParent.get(typeDef);
  }

  typeDefName(index: number): string {
    const r = this.row(T.TypeDef, index);
    const parent = this.parentOf(index);
    if (parent) return `${this.typeDefName(parent)}+${this.string(r[1])}`;
    const ns = this.string(r[2]);
    return ns ? `${ns}.${this.string(r[1])}` : this.string(r[1]);
  }

  private typeRefName(index: number): { ns: string; name: string; full: string } {
    const r = this.row(T.TypeRef, index);
    const name = this.string(r[1]);
    const scopeTag = r[0] & 3;
    if (scopeTag === 3 && r[0] >> 2) {
      const outer = this.typeRefName(r[0] >> 2);
      return { ns: outer.ns, name, full: `${outer.full}+${name}` };
    }
    const ns = this.string(r[2]);
    return { ns, name, full: ns ? `${ns}.${name}` : name };
  }

  /** Visible outside the assembly: public, or nested public inside public types. */
  private isExported(index: number): boolean {
    const visibility = this.row(T.TypeDef, index)[0] & 0x7;
    if (visibility === 1) return !this.parentOf(index);
    if (visibility === 2) {
      const parent = this.parentOf(index);
      return parent !== undefined && this.isExported(parent);
    }
    return false;
  }

  /**
   * Whether a type implements an interface or derives from a class matching the
   * test, following base classes and interfaces inside this assembly. Types from
   * other assemblies (TypeRefs) are matched by name only.
   */
  isAssignableTo(typeDef: number, test: (ns: string, name: string) => boolean, seen = new Set<number>()): boolean {
    if (seen.has(typeDef)) return false;
    seen.add(typeDef);
    const r = this.row(T.TypeDef, typeDef);
    if (test(this.string(r[2]), this.string(r[1]))) return true;
    for (const [owner, iface] of this.rows(T.InterfaceImpl)) {
      if (owner === typeDef && this.referenceMatches(iface, test, seen)) return true;
    }
    return r[3] !== 0 && this.referenceMatches(r[3], test, seen);
  }

  /** A TypeDefOrRef coded index: a type here, a type in another assembly, or a generic instantiation. */
  private referenceMatches(codedIndex: number, test: (ns: string, name: string) => boolean, seen: Set<number>): boolean {
    const target = this.resolve(codedIndex);
    if (!target) return false;
    if (target.def) return this.isAssignableTo(target.def, test, seen);
    return test(target.ref!.ns, target.ref!.name);
  }

  private resolve(codedIndex: number): { def?: number; ref?: { ns: string; name: string; full: string } } | undefined {
    const tag = codedIndex & 3;
    const index = codedIndex >> 2;
    if (!index) return undefined;
    if (tag === 0) return { def: index };
    if (tag === 1) return { ref: this.typeRefName(index) };
    if (tag === 2) {
      // TypeSpec: only GENERICINST (0x15) CLASS/VALUETYPE <TypeDefOrRefEncoded> ... names a type we can follow.
      const sig = this.blob(this.row(T.TypeSpec, index)[0]);
      if (sig[0] !== 0x15 || (sig[1] !== 0x12 && sig[1] !== 0x11)) return undefined;
      const base = sig.byteOffset - this.buf.byteOffset;
      return this.resolve(this.compressed(base + 2).value);
    }
    return undefined;
  }

  private baseName(typeDef: number): string | undefined {
    let current = typeDef;
    const seen = new Set<number>();
    while (!seen.has(current)) {
      seen.add(current);
      const target = this.resolve(this.row(T.TypeDef, current)[3]);
      if (!target) return undefined;
      if (target.ref) return target.ref.full;
      current = target.def!;
    }
    return undefined;
  }

  /** The Plugin Registration Tool's rules: exported, non-abstract classes that implement IPlugin or derive from Activity. */
  pluginClasses(): { pluginClasses: PluginClass[]; unresolvedBases: Array<{ typeName: string; base: string }> } {
    const pluginClasses: PluginClass[] = [];
    const unresolvedBases: Array<{ typeName: string; base: string }> = [];
    for (let i = 1; i <= this.count(T.TypeDef); i++) {
      const flags = this.row(T.TypeDef, i)[0];
      const isInterface = (flags & 0x20) !== 0;
      const isAbstract = (flags & 0x80) !== 0;
      if (isInterface || isAbstract || !this.isExported(i)) continue;
      const typeName = this.typeDefName(i);
      if (typeName.includes("`")) continue; // open generic types can't be instantiated by Dataverse
      if (this.isAssignableTo(i, (ns, n) => (ns === "Microsoft.Xrm.Sdk" || ns === "Microsoft.Crm.Sdk") && n === "IPlugin")) {
        pluginClasses.push({ typeName, kind: "plugin" });
      } else if (this.isAssignableTo(i, (ns, n) => ns === "System.Activities" && WORKFLOW_BASES.test(n))) {
        pluginClasses.push({ typeName, kind: "workflow" });
      } else {
        const base = this.baseName(i);
        if (base && !/^(System|Microsoft)\./.test(base)) {
          unresolvedBases.push({ typeName, base });
        }
      }
    }
    return { pluginClasses, unresolvedBases };
  }
}
