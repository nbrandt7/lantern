import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { publicKeyTokenOf } from "./assembly";
import { findFiles } from "./files";

/**
 * Strong-name key files (.snk). A key pair from "sn -k" is a CryptoAPI
 * PRIVATEKEYBLOB; a public-only file from "sn -p" is the strong-name public key
 * blob the compiler stores in the assembly. Either gives the public key token,
 * which is what Dataverse compares when you update a registered assembly.
 */

const CALG_RSA_SIGN = 0x2400;
const CALG_SHA1 = 0x8004;
const PUBLICKEYBLOB = 0x06;
const PRIVATEKEYBLOB = 0x07;
const RSA1 = 0x31415352;
const RSA2 = 0x32415352;

export interface StrongNameKey {
  /** The public key as stored in an assembly built with this key. */
  publicKey: Buffer;
  /** Lowercase hex. */
  token: string;
  /** False for public-only files, which can only delay-sign. */
  hasPrivateKey: boolean;
}

export function readKeyFile(buf: Buffer): StrongNameKey {
  // "sn -p" output: SigAlgId, HashAlgId, cbPublicKey, then a PUBLICKEYBLOB.
  if (buf.length >= 32 && buf.readUInt32LE(0) === CALG_RSA_SIGN && buf.readUInt32LE(8) === buf.length - 12 && buf[12] === PUBLICKEYBLOB) {
    return { publicKey: Buffer.from(buf), token: publicKeyTokenOf(buf), hasPrivateKey: false };
  }
  if (buf.length < 20 || (buf[0] !== PRIVATEKEYBLOB && buf[0] !== PUBLICKEYBLOB)) throw new Error("Not a strong-name key file.");
  const magic = buf.readUInt32LE(8);
  const bits = buf.readUInt32LE(12);
  if ((magic !== RSA1 && magic !== RSA2) || bits % 16 !== 0 || buf.length < 20 + bits / 8) throw new Error("Not an RSA strong-name key file.");
  const publicKey = strongNamePublicKey(bits, buf.readUInt32LE(16), buf.subarray(20, 20 + bits / 8));
  return { publicKey, token: publicKeyTokenOf(publicKey), hasPrivateKey: buf[0] === PRIVATEKEYBLOB && magic === RSA2 };
}

function strongNamePublicKey(bits: number, exponent: number, modulusLittleEndian: Buffer): Buffer {
  const inner = Buffer.alloc(20 + bits / 8);
  inner[0] = PUBLICKEYBLOB;
  inner[1] = 2;
  inner.writeUInt32LE(CALG_RSA_SIGN, 4);
  inner.writeUInt32LE(RSA1, 8);
  inner.writeUInt32LE(bits, 12);
  inner.writeUInt32LE(exponent, 16);
  modulusLittleEndian.copy(inner, 20);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(CALG_RSA_SIGN, 0);
  header.writeUInt32LE(CALG_SHA1, 4);
  header.writeUInt32LE(inner.length, 8);
  return Buffer.concat([header, inner]);
}

/** A new key pair in the same format "sn -k" writes (1024-bit RSA, what sn and pac plugin init use). */
export function generateKeyFile(bits = 1024): Buffer {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: bits, publicExponent: 0x10001 });
  const jwk = privateKey.export({ format: "jwk" }) as Record<string, string>;
  const le = (b64: string, length: number): Buffer => {
    const big = Buffer.from(b64, "base64url");
    const out = Buffer.alloc(length);
    big.copy(out, length - big.length); // left-pad the big-endian value
    return out.reverse();
  };
  const header = Buffer.alloc(20);
  header[0] = PRIVATEKEYBLOB;
  header[1] = 2;
  header.writeUInt32LE(CALG_RSA_SIGN, 4);
  header.writeUInt32LE(RSA2, 8);
  header.writeUInt32LE(bits, 12);
  header.writeUInt32LE(Buffer.from(jwk.e, "base64url").readUIntBE(0, Buffer.from(jwk.e, "base64url").length), 16);
  const half = bits / 16;
  return Buffer.concat([header, le(jwk.n, bits / 8), le(jwk.p, half), le(jwk.q, half), le(jwk.dp, half), le(jwk.dq, half), le(jwk.qi, half), le(jwk.d, bits / 8)]);
}

/** The private key inside a PRIVATEKEYBLOB as a Node key, so tests can prove a generated file is a working key pair. */
export function privateKeyFromKeyFile(buf: Buffer): crypto.KeyObject {
  const bits = buf.readUInt32LE(12);
  const half = bits / 16;
  let p = 20;
  const take = (n: number) => {
    const part = Buffer.from(buf.subarray(p, p + n)).reverse();
    p += n;
    return part.toString("base64url");
  };
  const e = Buffer.alloc(4);
  e.writeUInt32BE(buf.readUInt32LE(16));
  const n = take(bits / 8), pp = take(half), q = take(half), dp = take(half), dq = take(half), qi = take(half), d = take(bits / 8);
  return crypto.createPrivateKey({ key: { kty: "RSA", n, e: e.subarray(e.findIndex((x) => x !== 0)).toString("base64url"), d, p: pp, q, dp, dq, qi }, format: "jwk" });
}

// ---------- project files ----------

/** The key file a project signs with, if it signs. */
export function signingKeyOf(csproj: string): string | undefined {
  const text = fs.readFileSync(csproj, "utf8");
  if (!/<SignAssembly>\s*true\s*<\/SignAssembly>/i.test(text)) return undefined;
  const match = text.match(/<AssemblyOriginatorKeyFile>\s*([^<]+?)\s*<\/AssemblyOriginatorKeyFile>/i);
  return match ? path.resolve(path.dirname(csproj), match[1].replace(/\\/g, path.sep)) : undefined;
}

/** Turns on signing with a key file next to the project (a relative path in the .csproj). */
export function useSigningKey(csproj: string, keyFile: string): void {
  let text = fs.readFileSync(csproj, "utf8");
  const relative = path.relative(path.dirname(csproj), keyFile).split(path.sep).join("\\");
  const set = (tag: string, value: string) => {
    const pattern = new RegExp(`<${tag}>[^<]*</${tag}>`, "i");
    if (pattern.test(text)) {
      text = text.replace(pattern, `<${tag}>${value}</${tag}>`);
      return;
    }
    const group = text.match(/<PropertyGroup>([ \t]*\r?\n)?/i);
    if (!group) {
      text = text.replace(/<\/Project>\s*$/i, `  <PropertyGroup>\n    <${tag}>${value}</${tag}>\n  </PropertyGroup>\n</Project>\n`);
      return;
    }
    const at = group.index! + group[0].length;
    const indent = text.slice(at).match(/^[ \t]*/)?.[0] || "    ";
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    text = text.slice(0, at) + `${indent}<${tag}>${value}</${tag}>${newline}` + text.slice(at);
  };
  set("AssemblyOriginatorKeyFile", relative);
  set("SignAssembly", "true");
  fs.writeFileSync(csproj, text);
}

/** .snk files under the given folders whose public key token matches. */
export function findKeysWithToken(roots: string[], token: string): string[] {
  const out: string[] = [];
  for (const root of roots) {
    for (const file of findFiles(root, (n) => n.toLowerCase().endsWith(".snk"))) {
      try {
        if (readKeyFile(fs.readFileSync(file)).token === token.toLowerCase() && !out.includes(file)) out.push(file);
      } catch {
        // not a key file
      }
    }
  }
  return out;
}
