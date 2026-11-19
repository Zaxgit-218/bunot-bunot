import { pgTable, integer, text, jsonb } from 'drizzle-orm/pg-core';

export const exchanges = pgTable('exchanges', {
  id: integer().primaryKey(),
  ownerId: text('owner_id').notNull(),
  participants: jsonb().notNull().default([]),
  pairings: jsonb().notNull().default([]),
  prevPairings: jsonb('prev_pairings').notNull().default([]),
  version: integer().notNull().default(0),
});
