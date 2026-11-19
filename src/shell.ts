/** A valid shell variable name. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Quote `text` as one POSIX shell word. */
export function shellQuote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}
