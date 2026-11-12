import { describe, expect, it } from 'vitest';
import {
  isGermanTaxId,
  isIban,
  isPaymentCardNumber,
  isSensitiveValue,
  passesLuhn,
} from './value-redaction';

describe('isPaymentCardNumber', () => {
  it('matches card numbers from the major networks, with or without separators', () => {
    for (const v of [
      '4111111111111111', // Visa
      '4222222222222', // Visa, 13 digits
      '5555555555554444', // Mastercard
      '2223003122003222', // Mastercard 2-series
      '378282246310005', // American Express
      '36227206271667', // Diners Club
      '6011111111111117', // Discover
      '3530111333300000', // JCB
      '6200000000000005', // UnionPay
      '4111 1111 1111 1111',
      '4111-1111-1111-1111',
      '3782 822463 10005',
    ]) {
      expect(isPaymentCardNumber(v), v).toBe(true);
    }
  });

  it('rejects a failing Luhn check, wrong lengths and malformed separators', () => {
    for (const v of [
      '4111111111111112',
      '411111111111', // 12 digits
      '41111111111111111111', // 20 digits
      '4111  1111 1111 1111',
      '4111.1111.1111.1111',
    ]) {
      expect(isPaymentCardNumber(v), v).toBe(false);
    }
  });

  it('rejects Luhn-valid numbers outside card issuer ranges', () => {
    for (const v of [
      '1731420000001', // millisecond timestamp
      '100000000000000180', // order ID
      '3400000000000000', // Amex prefix, but 16 digits
    ]) {
      expect(passesLuhn(v), v).toBe(true);
      expect(isPaymentCardNumber(v), v).toBe(false);
    }
  });
});

describe('isIban', () => {
  it('matches IBANs compact, grouped in fours or lowercase', () => {
    for (const v of [
      'DE89370400440532013000',
      'GB82WEST12345698765432',
      'SE4550000000058398257466',
      'BA391290079401028494',
      'NO9386011117947',
      'FR1420041010050500013M02606',
      'DE89 3704 0044 0532 0130 00',
      'NO93 8601 1117 947',
      'de89370400440532013000',
    ]) {
      expect(isIban(v), v).toBe(true);
    }
  });

  it('rejects a failing mod-97 check, wrong length, unknown country or grouping', () => {
    for (const v of [
      'DE89370400440532013001',
      'DE8937040044053201300',
      'XX89370400440532013000',
      'DE8937 0400440532013000',
      'DE89-3704-0044-0532-0130-00',
    ]) {
      expect(isIban(v), v).toBe(false);
    }
  });
});

describe('isGermanTaxId', () => {
  it('matches valid tax IDs, compact or grouped', () => {
    expect(isGermanTaxId('86095742719')).toBe(true);
    expect(isGermanTaxId('86 095 742 719')).toBe(true);
  });

  it('rejects a wrong check digit, a leading zero or a wrong length', () => {
    for (const v of ['86095742718', '01234567891', '8609574271', '860957427190']) {
      expect(isGermanTaxId(v), v).toBe(false);
    }
  });

  it('rejects a valid check digit when the digit-repetition rule fails', () => {
    expect(isGermanTaxId('12345678903')).toBe(false); // no digit repeated
    expect(isGermanTaxId('11223456785')).toBe(false); // two digits repeated
    expect(isGermanTaxId('11123456786')).toBe(false); // three in a row
  });
});

describe('isSensitiveValue', () => {
  it('matches trimmed strings and JSON integers', () => {
    expect(isSensitiveValue(' 4111 1111 1111 1111 ')).toBe(true);
    expect(isSensitiveValue('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(isSensitiveValue(4111111111111111)).toBe(true);
    expect(isSensitiveValue(86095742719)).toBe(true);
  });

  it('does not match order IDs, timestamps or phone numbers', () => {
    for (const v of [
      'ORD-2024-000123',
      '202411120001234',
      '1731420000001',
      1731420000001,
      '2024-11-12T10:15:30.123Z',
      '+44 7700 900123',
      '+1 415 555 0123',
      '14155550123',
      '46701740605',
      '070-174 06 05',
    ]) {
      expect(isSensitiveValue(v), String(v)).toBe(false);
    }
  });

  it('ignores other types and numbers embedded in text', () => {
    for (const v of [null, true, 86095742719.5, { card: '4111111111111111' }]) {
      expect(isSensitiveValue(v)).toBe(false);
    }
    expect(isSensitiveValue('card 4111111111111111')).toBe(false);
  });
});
