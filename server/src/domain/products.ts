export const PRODUCTS = ['API', 'TRADING', 'FINANCING', 'CUSTODY'] as const;
export type Product = (typeof PRODUCTS)[number];

/** Gentlest step first. Deposits and closing positions are never restricted. */
export const RESTRICTION_LADDER: Record<Product, readonly string[]> = {
  API: ['REQUIRE_PREPAY', 'RATE_LIMIT', 'READ_ONLY'],
  TRADING: ['PAUSE_OTC', 'NO_NEW_POSITIONS', 'CLOSE_ONLY'],
  FINANCING: ['NO_NEW_BORROWING', 'LOWER_LINE'],
  CUSTODY: ['FEE_DEBIT', 'HOLD_AMOUNT_OWED', 'FULL_FREEZE'],
};
