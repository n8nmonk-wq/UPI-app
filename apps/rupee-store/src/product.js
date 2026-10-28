/** The only thing this store sells. The price lives here, on the server, and is never read from a request. */
export const PRODUCT = Object.freeze({
  sku: 'RUPEE-1',
  name: 'Lucky One Rupee Pass',
  description: 'A tiny digital thank-you, paid by UPI straight to the merchant bank account.',
  amountPaise: 100n,
  currency: 'INR'
});

export function formatRupees(amountPaise) {
  const paise = BigInt(amountPaise);
  return `${paise / 100n}.${String(paise % 100n).padStart(2, '0')}`;
}

/** Order ids are 128 random bits; the format is checked before any lookup. */
export const ORDER_ID_RE = /^R1-[A-Za-z0-9_-]{22}$/;
