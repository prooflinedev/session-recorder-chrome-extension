/**
 * Detects personal numbers by their value, whatever key they are stored under.
 * Every check validates a checksum, not just the shape, to keep false positives
 * low. Pure: values are only inspected.
 */

/**
 * Card issuer prefixes as [first prefix, last prefix, min length, max length].
 * About one in ten digit strings passes Luhn, so requiring a real issuer range
 * keeps timestamps and order numbers from matching.
 */
const CARD_ISSUERS: ReadonlyArray<readonly [number, number, number, number]> = [
  [4, 4, 13, 19], // Visa
  [51, 55, 16, 16], // Mastercard
  [2221, 2720, 16, 16], // Mastercard
  [34, 34, 15, 15], // American Express
  [37, 37, 15, 15], // American Express
  [300, 305, 14, 19], // Diners Club
  [36, 36, 14, 19], // Diners Club
  [38, 39, 14, 19], // Diners Club
  [3528, 3589, 16, 19], // JCB
  [6011, 6011, 16, 19], // Discover
  [644, 649, 16, 19], // Discover
  [65, 65, 16, 19], // Discover
  [62, 62, 16, 19], // UnionPay
  [2200, 2204, 16, 19], // Mir
  [50, 50, 13, 19], // Maestro
  [56, 69, 13, 19], // Maestro
];

/** IBAN length per country code (SWIFT IBAN registry). */
// prettier-ignore
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27,
  BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28,
  EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23,
  GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26,
  IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21,
  LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28,
  NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22,
  RU: 33, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25,
  SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

export function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** 13–19 digits, optionally separated by single spaces or dashes. */
export function isPaymentCardNumber(value: string): boolean {
  if (!/^\d(?:[ -]?\d){12,18}$/.test(value)) return false;
  const digits = value.replace(/[ -]/g, '');
  const issued = CARD_ISSUERS.some(([from, to, minLength, maxLength]) => {
    const prefix = Number(digits.slice(0, String(from).length));
    return (
      prefix >= from &&
      prefix <= to &&
      digits.length >= minLength &&
      digits.length <= maxLength
    );
  });
  return issued && passesLuhn(digits);
}

/** Compact or grouped in fours; letters in either case. */
export function isIban(value: string): boolean {
  const upper = value.toUpperCase();
  const iban = upper.replace(/ /g, '');
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  if (iban.length !== IBAN_LENGTHS[iban.slice(0, 2)]) return false;
  if (upper !== iban && upper !== iban.replace(/(.{4})(?!$)/g, '$1 ')) return false;

  // ISO 7064 mod 97: move the first four characters to the end, read letters as
  // A=10 … Z=35, and the remainder must be 1.
  let remainder = 0;
  for (const ch of iban.slice(4) + iban.slice(0, 4)) {
    const n = parseInt(ch, 36);
    remainder = (remainder * (n > 9 ? 100 : 10) + n) % 97;
  }
  return remainder === 1;
}

/** German tax identification number (Steuer-ID), compact or `12 345 678 901`. */
export function isGermanTaxId(value: string): boolean {
  if (!/^[1-9]\d{10}$|^[1-9]\d \d{3} \d{3} \d{3}$/.test(value)) return false;
  const digits = value.replace(/ /g, '');
  const body = digits.slice(0, 10);

  // Exactly one digit appears two or three times, never three in a row.
  const counts = new Map<string, number>();
  for (const ch of body) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const repeats = [...counts.values()].filter((c) => c > 1);
  if (repeats.length !== 1 || (repeats[0] ?? 0) > 3 || /(\d)\1\1/.test(body)) {
    return false;
  }

  // ISO 7064 MOD 11,10 check digit.
  let product = 10;
  for (const ch of body) {
    const sum = (Number(ch) + product) % 10 || 10;
    product = (sum * 2) % 11;
  }
  return (11 - product) % 10 === Number(digits[10]);
}

/** Strings are checked whole; JSON integers by their digits. */
export function isSensitiveValue(value: unknown): boolean {
  let text: string;
  if (typeof value === 'string') {
    text = value.trim();
  } else if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    text = String(value);
  } else {
    return false;
  }
  return isPaymentCardNumber(text) || isIban(text) || isGermanTaxId(text);
}
