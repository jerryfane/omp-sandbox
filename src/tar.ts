/**
 * The small part of tar that `gitmoot workspace pull` and `push --files`
 * use: regular files, directories and symlinks, with permission bits. Reads
 * ustar and POSIX pax (`x` headers carrying `path` and `linkpath`, as Go's
 * archive/tar writes them); writes ustar, with a pax header for a name or link
 * target that does not fit. Anything else in a stream is refused.
 */

export type TarEntry =
	| { type: "file"; path: string; mode: number; data: Uint8Array }
	| { type: "dir"; path: string; mode: number }
	| { type: "symlink"; path: string; mode: number; target: string };

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Parse a tar stream. Throws on a malformed stream or an entry type outside TarEntry. */
export function readTar(bytes: Uint8Array): TarEntry[] {
	const entries: TarEntry[] = [];
	let offset = 0;
	let pax: Record<string, string> = {};
	while (offset + BLOCK <= bytes.length) {
		const header = bytes.subarray(offset, offset + BLOCK);
		if (header.every(b => b === 0)) break; // end of archive
		if (checksum(header) !== octal(header, 148, 8)) throw new Error(`tar: bad header checksum at byte ${offset}`);
		const size = octal(header, 124, 12);
		const kind = String.fromCharCode(header[156] ?? 0);
		const body = bytes.subarray(offset + BLOCK, offset + BLOCK + size);
		if (body.length !== size) throw new Error("tar: truncated entry");
		offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
		if (kind === "x") {
			pax = { ...pax, ...parsePax(body) };
			continue;
		}
		if (kind === "g") continue; // global pax header: no fields used here
		const prefix = text(header, 345, 155);
		const name = pax.path ?? (prefix === "" ? text(header, 0, 100) : `${prefix}/${text(header, 0, 100)}`);
		const path = name.endsWith("/") ? name.slice(0, -1) : name;
		const mode = octal(header, 100, 8) & 0o7777;
		if (kind === "0" || kind === "\0") entries.push({ type: "file", path, mode, data: body.slice() });
		else if (kind === "5") entries.push({ type: "dir", path, mode });
		else if (kind === "2") entries.push({ type: "symlink", path, mode, target: pax.linkpath ?? text(header, 157, 100) });
		else throw new Error(`tar: unsupported entry type ${JSON.stringify(kind)} for ${path}`);
		pax = {};
	}
	return entries;
}

/** A tar stream holding `entries`, in order. */
export function writeTar(entries: readonly TarEntry[]): Uint8Array {
	const blocks: Uint8Array[] = [];
	for (const entry of entries) {
		const name = entry.type === "dir" ? `${entry.path}/` : entry.path;
		const target = entry.type === "symlink" ? entry.target : "";
		const records: [string, string][] = [];
		if (encoder.encode(name).length > 100) records.push(["path", name]);
		if (encoder.encode(target).length > 100) records.push(["linkpath", target]);
		if (records.length > 0) {
			const body = encodePax(records);
			blocks.push(header("PaxHeader", body.length, 0o644, "x", ""), pad(body));
		}
		const data = entry.type === "file" ? entry.data : new Uint8Array();
		const kind = entry.type === "file" ? "0" : entry.type === "dir" ? "5" : "2";
		blocks.push(header(name, data.length, entry.mode, kind, target), pad(data));
	}
	blocks.push(new Uint8Array(BLOCK * 2));
	const out = new Uint8Array(blocks.reduce((sum, b) => sum + b.length, 0));
	let at = 0;
	for (const b of blocks) {
		out.set(b, at);
		at += b.length;
	}
	return out;
}

function header(name: string, size: number, mode: number, kind: string, target: string): Uint8Array {
	const h = new Uint8Array(BLOCK);
	put(h, 0, 100, truncateUtf8(name, 100));
	put(h, 100, 8, octalField(mode & 0o7777, 8));
	put(h, 108, 8, octalField(0, 8));
	put(h, 116, 8, octalField(0, 8));
	put(h, 124, 12, octalField(size, 12));
	put(h, 136, 12, octalField(0, 12));
	h.fill(0x20, 148, 156); // checksum field counts as spaces
	put(h, 156, 1, kind);
	put(h, 157, 100, truncateUtf8(target, 100));
	put(h, 257, 6, "ustar\0");
	put(h, 263, 2, "00");
	put(h, 148, 8, `${checksum(h).toString(8).padStart(6, "0")}\0 `);
	return h;
}

function checksum(h: Uint8Array): number {
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] ?? 0);
	return sum;
}

function octal(h: Uint8Array, at: number, len: number): number {
	const field = text(h, at, len).trim();
	return field === "" ? 0 : Number.parseInt(field, 8);
}

function octalField(value: number, len: number): string {
	return `${value.toString(8).padStart(len - 1, "0")}\0`;
}

function text(h: Uint8Array, at: number, len: number): string {
	const field = h.subarray(at, at + len);
	const end = field.indexOf(0);
	return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

function put(h: Uint8Array, at: number, len: number, value: string): void {
	h.set(encoder.encode(value).subarray(0, len), at);
}

/** The longest prefix of `value` that fits `bytes` UTF-8 bytes without splitting a character. */
function truncateUtf8(value: string, bytes: number): string {
	let out = "";
	for (const ch of value) {
		if (encoder.encode(out + ch).length > bytes) break;
		out += ch;
	}
	return out;
}

function pad(data: Uint8Array): Uint8Array {
	const out = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
	out.set(data);
	return out;
}

/** pax records: "<len> <key>=<value>\n", where <len> counts the whole record. */
function parsePax(body: Uint8Array): Record<string, string> {
	const out: Record<string, string> = {};
	let at = 0;
	while (at < body.length) {
		const space = body.indexOf(0x20, at);
		if (space === -1) throw new Error("tar: malformed pax record");
		const len = Number.parseInt(decoder.decode(body.subarray(at, space)), 10);
		if (!Number.isInteger(len) || len <= 0) throw new Error("tar: malformed pax record length");
		const record = decoder.decode(body.subarray(space + 1, at + len - 1));
		const eq = record.indexOf("=");
		if (eq === -1) throw new Error("tar: malformed pax record");
		out[record.slice(0, eq)] = record.slice(eq + 1);
		at += len;
	}
	return out;
}

function encodePax(records: readonly [string, string][]): Uint8Array {
	let text = "";
	for (const [key, value] of records) {
		const rest = ` ${key}=${value}\n`;
		const restLen = encoder.encode(rest).length;
		let len = restLen + 1;
		while (String(len).length + restLen !== len) len = String(len).length + restLen;
		text += `${len}${rest}`;
	}
	return encoder.encode(text);
}
