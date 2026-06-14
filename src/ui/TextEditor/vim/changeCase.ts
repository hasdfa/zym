/*
 * changeCase — the slice of the `change-case` package the vendored
 * operator-transform-string's `ChangeCase` operators reach for.
 *
 * Upstream depends on the full `change-case` library (camelCase, snakeCase, …);
 * quilx only wires the case operators that don't need it — gU (upperCase), gu
 * (lowerCase), g~ (swapCase) — so we provide just those plus the `lowerCaseFirst`
 * helper `ChangeCase.getNewText` uses to derive the function name from the class
 * name. The fancier transforms can adopt the real package if they're ever bound.
 */

export const upperCase = (text: string): string => text.toUpperCase();

export const lowerCase = (text: string): string => text.toLowerCase();

/** Flip the case of each character (vim's `g~`). */
export const swapCase = (text: string): string =>
  text.replace(/[a-zA-ZÀ-ɏ]/g, (c) =>
    c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
  );

export const lowerCaseFirst = (text: string): string =>
  text ? text[0].toLowerCase() + text.slice(1) : text;

export const upperCaseFirst = (text: string): string =>
  text ? text[0].toUpperCase() + text.slice(1) : text;

export default { upperCase, lowerCase, swapCase, lowerCaseFirst, upperCaseFirst };
